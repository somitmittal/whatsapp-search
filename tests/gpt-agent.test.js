import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'gpt-agent-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');
const { parseToolCalls, runAgent } = await import('../src/gpt/agent.js');
const { buildChatOverview, buildHistory, ContextEngine, expenseDiffBlock, expenseHistoryBlocks } = await import('../src/gpt/context.js');
const { detectTimeRange, hybridSearch, isBroadQuery, packMessages } = await import('../src/gpt/retrieval.js');
const { default: GptService, turnScopePins } = await import('../src/gpt/gpt-service.js');

const TENANT = 'tenant-gpt';
const SITE = 'site2@g.us';
const FAMILY = 'family@g.us';
const BASE_TS = Math.floor(new Date(2026, 9, 14, 9, 0, 0).getTime() / 1000);

/** Provider double: each chatStream call replays the next scripted reply in chunks. */
function scriptedProvider(replies) {
  const calls = [];
  return {
    calls,
    name: 'fake',
    async chat() { return '- memory'; },
    async *chatStream(messages) {
      calls.push(messages);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      for (let i = 0; i < reply.length; i += 7) yield reply.slice(i, i + 7);
    },
  };
}

function collect() {
  const events = [];
  return { events, emit: (e) => events.push(e), deltas: () => events.filter((e) => e.type === 'delta').map((e) => e.text).join('') };
}

let db;
beforeAll(() => {
  db = new Database();
  runWithTenant(TENANT, () => {
    db.insertMessageBatch([
      { messageId: 'a1', chatJid: SITE, chatName: 'Site 2', sender: 'Ramesh', text: 'Did the cement arrive?', timestamp: BASE_TS },
      { messageId: 'a2', chatJid: SITE, chatName: 'Site 2', sender: 'Suresh', text: 'Yes 40 bags of cement delivered by Ambuja truck', timestamp: BASE_TS + 60 },
      { messageId: 'a3', chatJid: SITE, chatName: 'Site 2', sender: 'Ramesh', text: 'ok noted', timestamp: BASE_TS + 120 },
      { messageId: 'b1', chatJid: FAMILY, chatName: 'Family', sender: 'Mom', text: 'Dinner at 8 tonight', timestamp: BASE_TS + 300 },
    ]);
  });
});
afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('parseToolCalls', () => {
  test('reads one call per CALL line and skips malformed JSON', () => {
    const calls = parseToolCalls([
      'CALL {"tool":"search","args":{"query":"cement"}}',
      'CALL {"tool":"read", broken',
      '```json',
      'CALL {"name":"chats","args":{}}',
      '```',
    ].join('\n'));
    expect(calls).toEqual([
      { name: 'search', args: { query: 'cement' } },
      { name: 'chats', args: {} },
    ]);
  });

  test('returns nothing for a plain answer', () => {
    expect(parseToolCalls('The cement arrived on Tuesday.')).toEqual([]);
  });
});

describe('packMessages', () => {
  test('groups by chat in time order and skips already-seen messages', () => {
    const rows = [
      { id: 2, chatJid: SITE, chatName: 'Site 2', sender: 'B', text: 'second', timestamp: 20 },
      { id: 1, chatJid: SITE, chatName: 'Site 2', sender: 'A', text: 'first', timestamp: 10 },
      { id: 3, chatJid: FAMILY, chatName: 'Family', sender: 'C', text: 'other', timestamp: 15 },
    ];
    const seen = new Set([3]);
    const packed = packMessages(rows, 10_000, seen);
    expect(packed.count).toBe(2);
    expect(packed.text.indexOf('[m1]')).toBeLessThan(packed.text.indexOf('[m2]'));
    expect(packed.text).not.toContain('[m3]');
  });

  test('stops at the token budget', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, chatJid: SITE, sender: 'A', text: 'x'.repeat(200), timestamp: i }));
    expect(packMessages(rows, 60, new Set()).count).toBe(1);
  });
});

describe('detectTimeRange', () => {
  const now = new Date(2026, 9, 16, 15, 0, 0);
  test('today covers the whole local day', () => {
    const r = detectTimeRange('what happened today', now);
    expect(r.label).toBe('today');
    expect(r.endTs - r.startTs).toBe(86_399);
  });
  test('yesterday ends right before today starts', () => {
    const today = detectTimeRange('today', now);
    const y = detectTimeRange('anything from yesterday?', now);
    expect(y.endTs).toBe(today.startTs - 1);
  });
  test('no date words → no range', () => {
    expect(detectTimeRange('who sent the cement bill', now)).toBeNull();
  });
});

describe('broad group context', () => {
  test('recognizes questions asking what a chat or group is about', () => {
    expect(isBroadQuery('what is this group about?')).toBe(true);
    expect(isBroadQuery('What are they talking about in this conversation?')).toBe(true);
  });

  test('uses the pinned group timeline and summaries instead of noisy generic search', async () => {
    const message = {
      id: 9001, chatJid: SITE, chatName: 'Site 2', sender: 'Ramesh',
      text: 'Discussed cement delivery and site progress.', timestamp: BASE_TS,
    };
    const dbStub = {
      getMessagesPaginated: jest.fn(() => [message]),
      getRecentThreadSummaries: jest.fn(() => [{
        chatJid: SITE, chatName: 'Site 2', date: '14 Oct', summary: 'Site progress and cement deliveries.',
      }]),
      searchMessages: jest.fn(() => { throw new Error('generic overview should not run lexical search'); }),
    };
    const engine = new ContextEngine({ db: dbStub, embeddings: null, directory: { name: () => 'Site 2' } });
    const result = await engine.prefetch({ query: 'what is this group about?', scopeJids: [SITE] });
    expect(dbStub.getMessagesPaginated).toHaveBeenCalledWith(SITE, expect.any(Number), 0);
    expect(dbStub.getRecentThreadSummaries).toHaveBeenCalledWith(SITE, expect.any(Number));
    expect(dbStub.searchMessages).not.toHaveBeenCalled();
    expect(result.text).toContain('Discussed cement delivery');
    expect(result.text).toContain('Site progress and cement deliveries');
    expect(result.messages.map((row) => row.id)).toEqual([message.id]);
  });

  test('answers a broad overview with cited evidence when the archive is media-heavy', async () => {
    await runWithTenant(TENANT, async () => {
      const rows = [
        { id: 9101, chatJid: FAMILY, chatName: 'Family', sender: 'A', text: 'https://instagram.com/reel/example', timestamp: BASE_TS },
        { id: 9102, chatJid: FAMILY, chatName: 'Family', sender: 'B', text: 'Left from Gurgaon', timestamp: BASE_TS + 1 },
        { id: 9103, chatJid: FAMILY, chatName: 'Family', sender: 'C', text: 'Shared a long post about the group plans and upcoming family event.', timestamp: BASE_TS + 2 },
        ...Array.from({ length: 12 }, (_, i) => ({
          id: 9200 + i, chatJid: FAMILY, chatName: 'Family', sender: 'A', mediaType: i % 2 ? 'video' : 'image',
          text: '', timestamp: BASE_TS + 3 + i,
        })),
      ];
      const provider = scriptedProvider(['This is a group about technology and engineering.']);
      provider.name = 'ollama';
      provider.model = 'llama3.2:1b';
      const svc = new GptService({ db, getProvider: () => provider });
      svc.context.prefetch = async () => ({ text: 'recent group messages', messages: rows, range: null });
      const out = await svc.handleTurn({
        message: 'what is this group about?',
        mentions: [{ type: 'chat', chatJid: FAMILY, chatName: 'Family' }],
      });
      expect(provider.calls).toHaveLength(0);
      expect(out.answer).toContain('12 of 15 recent messages are images/videos');
      expect(out.answer).toContain('“Left from Gurgaon” [m9102]');
      expect(out.answer).not.toMatch(/technology|engineering/i);
      expect(out.sources.map((source) => source.ref)).toEqual(['m9101', 'm9102', 'm9103']);
    });
  });
});

describe('buildHistory', () => {
  test('keeps recent turns within budget and prefixes memory', () => {
    const prior = [
      { role: 'user', content: 'old '.repeat(4000) },
      { role: 'assistant', content: 'old answer' },
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
    ];
    const { messages, overflow } = buildHistory(prior, { memory: '- user asked about cement', memoryUpto: 0 });
    expect(overflow).toBe(1);
    expect(messages[0].content).toContain('user asked about cement');
    expect(messages.at(-1).content).toBe('recent answer');
  });

  test('skips turns already folded into memory', () => {
    const prior = [{ role: 'user', content: 'folded' }, { role: 'user', content: 'kept' }];
    const { messages } = buildHistory(prior, { memory: '', memoryUpto: 1 });
    expect(messages.map((m) => m.content)).toEqual(['kept']);
  });
});

describe('hybridSearch', () => {
  test('fuses keyword and vector hits and pulls neighbouring messages', async () => {
    await runWithTenant(TENANT, async () => {
      const ids = db.searchMessages('Family dinner', null, 5).map((m) => m.id);
      const embeddings = { searchSimilar: async () => ids.map((id) => ({ id, score: 0.9 })) };
      const { hits, messages } = await hybridSearch({ db, embeddings, query: 'cement delivered', chatJid: SITE });
      expect(hits[0].text).toContain('40 bags');
      const texts = messages.map((m) => m.text);
      expect(texts).toEqual(expect.arrayContaining(['Did the cement arrive?', 'ok noted']));
    });
  });
});

describe('runAgent', () => {
  const toolbox = {
    async search() {
      return {
        text: '[m7] 14 Oct · Suresh: 40 bags delivered',
        messages: [{ id: 7, chatJid: SITE, chatName: 'Site 2', sender: 'Suresh', text: '40 bags delivered', timestamp: BASE_TS }],
      };
    },
  };

  test('runs a tool, then streams an answer that cites only known messages', async () => {
    const provider = scriptedProvider([
      'CALL {"tool":"search","args":{"query":"cement"}}',
      'Suresh said **40 bags** were delivered [m7] [m999].',
    ]);
    const { events, emit, deltas } = collect();
    const out = await runAgent({
      provider, system: 's', history: [], contextText: '', query: 'cement?', toolbox,
      ctx: { status: () => {}, prefetched: [] }, emit,
    });
    expect(deltas()).not.toContain('CALL');
    expect(events.some((e) => e.type === 'tool' && e.name === 'search')).toBe(true);
    expect(out.answer).toContain('[m7]');
    expect(out.answer).not.toContain('[m999]');
    expect(out.sources.map((s) => s.ref)).toEqual(['m7']);
    expect(provider.calls[1].at(-1).content).toContain('40 bags delivered');
  });

  test('emits reset when prose turns into a tool call', async () => {
    const provider = scriptedProvider([
      'Let me check.\nCALL {"tool":"search","args":{"query":"cement"}}',
      'Delivered [m7].',
    ]);
    const { events, emit } = collect();
    await runAgent({
      provider, system: 's', history: [], contextText: '', query: 'q', toolbox,
      ctx: { status: () => {}, prefetched: [] }, emit,
    });
    const types = events.map((e) => e.type);
    expect(types.indexOf('reset')).toBeGreaterThan(-1);
    expect(types.indexOf('reset')).toBeLessThan(types.lastIndexOf('delta'));
  });

  test('forces an answer once the step budget is spent', async () => {
    const provider = scriptedProvider(['CALL {"tool":"search","args":{"query":"x"}}']);
    const out = await runAgent({
      provider, system: 's', history: [], contextText: '', query: 'q', toolbox,
      ctx: { status: () => {}, prefetched: [] }, emit: () => {},
    });
    const lastPrompt = provider.calls.at(-1).at(-1).content;
    expect(lastPrompt).toMatch(/Answer now/);
    expect(out.answer).not.toContain('CALL');
  });
});

describe('GptService', () => {
  test('answers from auto-context, uses @mentions for that turn, and persists sources', async () => {
    await runWithTenant(TENANT, async () => {
      const [hit] = db.searchMessages('40 bags cement', SITE, 1);
      const provider = scriptedProvider([`Suresh confirmed **40 bags** of cement [m${hit.id}].`]);
      const svc = new GptService({ db, getProvider: () => provider });
      const { events, emit } = collect();
      const out = await svc.handleTurn({
        message: 'did the cement arrive?',
        mentions: [{ type: 'chat', chatJid: SITE, chatName: 'Site 2' }],
        emit,
      });
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].at(-1).content).toContain('40 bags of cement');
      expect(provider.calls[0].at(-1).content).toContain('Active chats this turn: Site 2');
      expect(out.sources[0].messageId).toBe('a2');
      // @mentions are not durable pins when the thread has no home chat.
      expect(out.conversation.pins).toEqual([]);
      expect(events.find((e) => e.type === 'tool').text).toMatch(/Pulled \d+ relevant messages/);

      const saved = svc.getConversation(out.conversationId);
      expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(saved.messages[0].payload.mentions.map((p) => p.chatJid)).toEqual([SITE]);
      expect(saved.messages[1].payload.sources[0].ref).toBe(`m${hit.id}`);
    });
  });

  test('Ask AI defaults to the thread chat; @mentions apply to that message only', async () => {
    await runWithTenant(TENANT, async () => {
      const provider = scriptedProvider(['ok', 'ok', 'ok']);
      const svc = new GptService({ db, getProvider: () => provider });
      const first = await svc.handleTurn({
        message: 'any dinner plans?',
        scopeChatJid: SITE,
        mentions: [],
        emit: () => {},
      });
      expect(first.conversation.pins.map((p) => p.chatJid)).toEqual([SITE]);
      expect(provider.calls[0].at(-1).content).not.toContain('Dinner at 8');

      const second = await svc.handleTurn({
        conversationId: first.conversationId,
        message: 'any dinner plans?',
        scopeChatJid: SITE,
        mentions: [{ type: 'chat', chatJid: FAMILY, chatName: 'Family' }],
        emit: () => {},
      });
      // Mentions are per-message; durable pins stay on the thread home chat.
      expect(second.conversation.pins.map((p) => p.chatJid)).toEqual([SITE]);
      expect(provider.calls[1].at(-1).content).toContain('Dinner at 8');
      expect(provider.calls[1].at(-1).content).toContain('Active chats this turn: Family');

      const third = await svc.handleTurn({
        conversationId: first.conversationId,
        message: 'any dinner plans?',
        scopeChatJid: SITE,
        mentions: [],
        emit: () => {},
      });
      expect(third.conversation.pins.map((p) => p.chatJid)).toEqual([SITE]);
      expect(provider.calls[2].at(-1).content).not.toContain('Dinner at 8');
    });
  });

  test('turnScopePins uses mentions when present, else the thread home chat', () => {
    expect(turnScopePins(SITE, 'Site 2', [])).toEqual([
      { type: 'chat', chatJid: SITE, chatName: 'Site 2' },
    ]);
    expect(turnScopePins(SITE, 'Site 2', [
      { type: 'chat', chatJid: FAMILY, chatName: 'Family' },
    ])).toEqual([
      { type: 'chat', chatJid: FAMILY, chatName: 'Family' },
    ]);
    expect(turnScopePins(null, null, [])).toEqual([]);
  });

  test('expense history blocks are labelled per site', () => {
    const prior = [
      {
        role: 'assistant',
        payload: {
          expenseDiff: {
            chatJid: SITE,
            chatName: 'Site 2',
            businessDate: '2026-10-14',
            sourceFileName: 'a.xlsx',
            sheetRows: [{ rowTone: 'match', category: 'cement', chatAmount: '100', sheetAmount: '100' }],
          },
        },
      },
      {
        role: 'assistant',
        payload: {
          expenseDiff: {
            chatJid: FAMILY,
            chatName: 'Family',
            businessDate: '2026-10-15',
            sourceFileName: 'b.xlsx',
            sheetRows: [{ rowTone: 'mismatch', category: 'food', chatAmount: '10', sheetAmount: '12' }],
          },
        },
      },
    ];
    const block = expenseHistoryBlocks(prior);
    expect(block).toContain('site: Site 2');
    expect(block).toContain('site: Family');
    expect(expenseDiffBlock(prior[0].payload.expenseDiff)).toContain(`chatJid: ${SITE}`);
    expect(expenseHistoryBlocks(prior, { chatJids: [FAMILY] })).toContain('site: Family');
    expect(expenseHistoryBlocks(prior, { chatJids: [FAMILY] })).not.toContain('site: Site 2');
  });

  test('keeps the streamed steps and partial answer when the run fails or is stopped', async () => {
    await runWithTenant(TENANT, async () => {
      const failing = {
        name: 'fake',
        model: 'fake-model',
        async chat() { return '- memory'; },
        async *chatStream() {
          yield 'Cement was ';
          throw new Error('model disconnected');
        },
      };
      const failedId = 'conv-interrupted-fail';
      const svc = new GptService({ db, getProvider: () => failing });
      await expect(svc.handleTurn({
        conversationId: failedId,
        createConversationIfMissing: true,
        message: 'did the cement arrive?',
        scopeChatJid: SITE,
        mentions: [{ type: 'chat', chatJid: SITE }],
        emit: () => {},
      })).rejects.toThrow(/disconnected/);
      const failed = svc.getConversation(failedId);
      expect(failed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(failed.messages[1].content).toContain('Cement was');
      expect(failed.messages[1].payload.error).toMatch(/disconnected/);
      expect(failed.messages[1].payload.steps.join('\n')).toMatch(/Pulled \d+ relevant messages/);
      expect(failed.conversation.pins.map((p) => p.chatJid)).toEqual([SITE]);

      const stoppedId = 'conv-interrupted-stop';
      const provider = scriptedProvider(['unused']);
      const stopping = new GptService({ db, getProvider: () => provider });
      await expect(stopping.handleTurn({
        conversationId: stoppedId,
        createConversationIfMissing: true,
        message: 'did the cement arrive?',
        scopeChatJid: SITE,
        signal: AbortSignal.abort(),
        emit: () => {},
      })).rejects.toThrow(/aborted/);
      const stopped = stopping.getConversation(stoppedId);
      expect(stopped.messages[1].payload.stopped).toBe(true);
      expect(stopped.messages[1].payload.steps.join('\n')).toMatch(/Pulled \d+ relevant messages/);
      expect(stopped.conversation.pins.map((p) => p.chatJid)).toEqual([SITE]);
    });
  });

  test('rejects a turn with no provider configured', async () => {
    const svc = new GptService({ db, getProvider: () => null });
    await expect(runWithTenant(TENANT, () => svc.handleTurn({ message: 'hi' }))).rejects.toThrow(/provider/i);
  });
});
