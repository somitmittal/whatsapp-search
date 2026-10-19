import { afterAll, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'skills-'));
process.env.DATA_DIR = scratch;

const { isRetryPhrase, parseSkillInvocation } = await import('../src/skills/parse-invocation.js');
const {
  listManagedSkills,
  matchSkills,
  mergeSkills,
  normalizeSkillIdentity,
  skillFromUserRow,
} = await import('../src/skills/catalog.js');
const { SYSTEM_SKILLS } = await import('../src/skills/system-skills.js');
const {
  chatQueryFromRest,
  dateHintFromRest,
  resolveExpenseChat,
  resolveExpenseSheet,
} = await import('../src/skills/expense-inputs.js');
const { createSkillRunner } = await import('../src/skills/skill-runner.js');
const { default: Database } = await import('../src/storage/database.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');
const { default: GptService } = await import('../src/gpt/gpt-service.js');

const NOW = new Date(2026, 9, 18, 12, 0, 0);
const SITE = 'site-a@g.us';
const SHEET_TS = Math.floor(new Date(2026, 9, 17, 18, 0, 0).getTime() / 1000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('parseSkillInvocation', () => {
  test('reads a namespaced command and leaves the rest', () => {
    expect(parseSkillInvocation('/accountant/expense-reconciliation Site A today')).toEqual({
      namespace: 'accountant',
      slug: 'expense-reconciliation',
      rest: 'Site A today',
    });
  });

  test('reads a bare slug', () => {
    expect(parseSkillInvocation('/expense-reconciliation')).toEqual({
      namespace: null,
      slug: 'expense-reconciliation',
      rest: '',
    });
  });

  test('ignores a slash that is not the start of the message', () => {
    expect(parseSkillInvocation('please run /accountant/expense-reconciliation')).toBeNull();
    expect(parseSkillInvocation('hello')).toBeNull();
  });

  test('recognises a retry only when the whole message is the phrase', () => {
    expect(isRetryPhrase('pls try again')).toBe(true);
    expect(isRetryPhrase('please try again')).toBe(true);
    expect(isRetryPhrase('try again.')).toBe(true);
    expect(isRetryPhrase('try again for site 2')).toBe(false);
    expect(isRetryPhrase('/accountant/expense-reconciliation')).toBe(false);
  });
});

describe('expense skill inputs', () => {
  const sheets = [
    { chatJid: SITE, messageId: 'new', fileName: '17-oct.xlsx', timestamp: SHEET_TS },
    { chatJid: SITE, messageId: 'old', fileName: '16-oct.xlsx', timestamp: SHEET_TS - 86400 },
  ];
  const chat = { chatJid: SITE, chatName: 'Site A' };

  test('a name in the command beats an @mention', () => {
    const picked = resolveExpenseChat({
      rest: 'Site A',
      mentions: [{ chatJid: 'other@g.us', chatName: 'Other' }],
      resolveChat: (query) => (query === 'Site A' ? chat : null),
    });
    expect(picked.chat.chatJid).toBe(SITE);
  });

  test('asks instead of picking when several groups are mentioned', () => {
    const picked = resolveExpenseChat({
      mentions: [
        { chatJid: SITE, chatName: 'Site A' },
        { chatJid: 'site-b@g.us', chatName: 'Site B' },
      ],
    });
    expect(picked.status).toBe('needs_input');
    expect(picked.choices.map((c) => c.label)).toEqual(['Site A', 'Site B']);
  });

  test('uses the open group when nothing else is named', () => {
    const picked = resolveExpenseChat({ scopeChatJid: SITE, scopeChatName: 'Site A' });
    expect(picked.chat.chatJid).toBe(SITE);
  });

  test('a pinned site is the chat when the rest of the command is just instructions', () => {
    const picked = resolveExpenseChat({
      rest: 'Please do it for this chat',
      mentions: [{ chatJid: SITE, chatName: 'Site 1' }],
      resolveChat: () => null,
    });
    expect(picked.status).toBe('ready');
    expect(picked.chat.chatJid).toBe(SITE);
  });

  test('the open group is used when the sentence does not name a chat', () => {
    const picked = resolveExpenseChat({
      rest: 'Please do it for this chat',
      scopeChatJid: SITE,
      scopeChatName: 'Site 1',
      resolveChat: () => ({ chatJid: 'other@g.us', chatName: 'Somewhere else' }),
    });
    expect(picked.chat.chatJid).toBe(SITE);
  });

  test('rejects a direct chat', () => {
    const picked = resolveExpenseChat({
      rest: 'Mahesh',
      resolveChat: () => ({ chatJid: '9198@s.whatsapp.net', chatName: 'Mahesh' }),
    });
    expect(picked.status).toBe('needs_input');
    expect(picked.answer).toContain('not a group');
  });

  test('asks which sheet when the chat has more than one', () => {
    const picked = resolveExpenseSheet({ rest: '', chat, sheets });
    expect(picked.status).toBe('needs_input');
    expect(picked.choices).toHaveLength(2);
  });

  test('a day in the command selects the sheet from that day', () => {
    const picked = resolveExpenseSheet({ rest: 'yesterday', chat, sheets, now: NOW });
    expect(dateHintFromRest('yesterday', NOW)).toBe('2026-10-17');
    expect(picked.status).toBe('ready');
    expect(picked.messageId).toBe('new');
  });

  test('a filename selects that sheet', () => {
    const picked = resolveExpenseSheet({ rest: '16-oct.xlsx', chat, sheets, now: NOW });
    expect(chatQueryFromRest('Site A 16-oct.xlsx')).toBe('Site A');
    expect(picked.messageId).toBe('old');
  });
});

describe('skill catalog', () => {
  test('a user skill with the same slug replaces the system skill', () => {
    const custom = skillFromUserRow({
      namespace: 'accountant',
      slug: 'expense-reconciliation',
      version: 3,
      frontmatter: { name: 'My reconciliation', description: 'Owner rules' },
      body: 'Advances count.',
    });
    const merged = mergeSkills(SYSTEM_SKILLS, [custom]);
    const hit = merged.find((s) => s.slug === 'expense-reconciliation');
    expect(hit.kind).toBe('user');
    expect(hit.version).toBe(3);
    expect(hit.name).toBe('My reconciliation');
    expect(matchSkills('my rec', merged).map((s) => s.kind)).toEqual(['user']);
  });

  test('query matches description text', () => {
    expect(matchSkills('excel', SYSTEM_SKILLS).map((s) => s.slug)).toEqual(['expense-reconciliation']);
  });

  test('managed skills mark builtin overrides and custom skills', () => {
    const db = {
      listUserSkills: () => ([
        {
          namespace: 'accountant',
          slug: 'expense-reconciliation',
          version: 2,
          frontmatter: { name: 'Site rules', description: 'Custom' },
          body: 'Prefer advances.',
        },
        {
          namespace: 'ops',
          slug: 'daily-digest',
          version: 1,
          frontmatter: { name: 'Daily digest', description: 'Recap' },
          body: 'Summarize the day.',
        },
      ]),
    };
    const items = listManagedSkills(db);
    const expense = items.find((s) => s.path === 'accountant/expense-reconciliation');
    const custom = items.find((s) => s.path === 'ops/daily-digest');
    expect(expense.hasOverride).toBe(true);
    expect(expense.canDelete).toBe(true);
    expect(expense.body).toBe('Prefer advances.');
    expect(custom.isBuiltin).toBe(false);
    expect(custom.canDelete).toBe(true);
    expect(normalizeSkillIdentity('Ops', 'Daily-Digest')).toEqual({
      namespace: 'ops',
      slug: 'daily-digest',
    });
    expect(() => normalizeSkillIdentity('Bad Name', 'x')).toThrow(/Namespace/);
  });
});

function memoryDb(sheets) {
  const runs = new Map();
  return {
    runs,
    listUserSkills: () => [],
    listExpenseSheetMessages: () => sheets,
    getMessagesByTimeRange: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    createSkillRun(row) {
      const saved = { ...row };
      runs.set(row.id, saved);
      return saved;
    },
  };
}

const sheetRow = {
  chatJid: SITE,
  messageId: 'sheet-1',
  sender: 'Raju',
  text: 'expenses.xlsx',
  mediaPath: '/tmp/expenses.xlsx',
  timestamp: SHEET_TS,
};

describe('skill runner', () => {
  test('dry-runs the expense skill and records coverage without sending', async () => {
    const calls = [];
    const db = memoryDb([sheetRow]);
    const runner = createSkillRunner({
      db,
      directory: { resolve: () => ({ chatJid: SITE, chatName: 'Site A' }), name: () => 'Site A' },
      expenseService: {
        async runForChat(input) {
          calls.push(input);
          return {
            id: 7,
            status: 'completed',
            chatJid: SITE,
            chatName: 'Site A',
            businessDate: '2026-10-17',
            sourceFileName: 'expenses.xlsx',
            reportPath: '/tmp/report.xlsx',
            entries: [],
            discrepancies: [],
            totals: {},
          };
        },
      },
    });
    const outcome = await runner.run({
      text: '/accountant/expense-reconciliation Site A',
      mentions: [],
    });
    expect(calls).toEqual([{
      chatJid: SITE, messageId: 'sheet-1', notifyWhatsApp: false, forceRerun: true,
    }]);
    expect(outcome.skillRun.status).toBe('dry_run');
    expect(outcome.skillRun.canSend).toBe(true);
    expect(outcome.expenseDiff.runId).toBe(7);
    expect(outcome.answer).toContain('Dry run');
    expect(outcome.answer).toContain('Read 3 messages');
    const saved = [...db.runs.values()][0];
    expect(saved.coverage.messageCount).toBe(3);
    expect(saved.coverage.businessDate).toBe('2026-10-17');
    expect(saved.toolCalls.map((c) => c.tool)).toEqual([
      'parse_table', 'extract_records', 'match_records', 'render_report',
    ]);
    expect(saved.kind).toBe('system');
  });

  test('uses the selected model provider for the reconciliation run', async () => {
    const selectedProvider = { name: 'ollama', model: 'llama3.2:3b' };
    const calls = [];
    const runner = createSkillRunner({
      db: memoryDb([sheetRow]),
      directory: { resolve: () => ({ chatJid: SITE, chatName: 'Site A' }), name: () => 'Site A' },
      expenseService: {
        async runForChat(input) {
          calls.push(input);
          return {
            id: 8, status: 'completed', chatJid: SITE, chatName: 'Site A',
            businessDate: '2026-10-17', sourceFileName: 'expenses.xlsx',
            entries: [], discrepancies: [], totals: {},
          };
        },
      },
    });
    const outcome = await runner.run({
      text: '/accountant/expense-reconciliation Site A',
      resolveProvider: async () => selectedProvider,
    });
    expect(calls[0].provider).toBe(selectedProvider);
    expect(outcome.skillRun.status).toBe('dry_run');
  });

  test('does not reconcile when several sheets match', async () => {
    let called = false;
    const runner = createSkillRunner({
      db: memoryDb([
        sheetRow,
        { ...sheetRow, messageId: 'sheet-2', text: 'other.xlsx', timestamp: SHEET_TS - 86400 },
      ]),
      directory: { resolve: () => ({ chatJid: SITE, chatName: 'Site A' }) },
      expenseService: { async runForChat() { called = true; } },
    });
    const outcome = await runner.run({ text: '/expense-reconciliation Site A' });
    expect(called).toBe(false);
    expect(outcome.skillRun.status).toBe('needs_input');
    expect(outcome.choices).toHaveLength(2);
  });
});

describe('skill runs in the database', () => {
  const db = new Database();
  const TENANT = 'tenant-skills';

  test('stores a run and lets a user skill override the system one', () => {
    runWithTenant(TENANT, () => {
      db.upsertUserSkill({
        namespace: 'accountant',
        slug: 'expense-reconciliation',
        version: 2,
        frontmatter: { name: 'Site books', description: 'Our sheet' },
        body: 'Fuel includes diesel.',
      });
      const runner = createSkillRunner({ db, directory: null, expenseService: null });
      const listed = runner.list('expense');
      expect(listed).toHaveLength(1);
      expect(listed[0].kind).toBe('user');
      expect(listed[0].name).toBe('Site books');

      const saved = db.createSkillRun({
        id: 'run-1',
        namespace: 'accountant',
        slug: 'expense-reconciliation',
        kind: 'user',
        version: 2,
        status: 'dry_run',
        inputs: { chatJid: SITE },
        coverage: { messageCount: 4, businessDate: '2026-10-17' },
        toolCalls: [{ tool: 'parse_table' }],
        expenseRunId: 99,
      });
      expect(db.getSkillRun('run-1')).toMatchObject({
        id: saved.id, status: 'dry_run', expenseRunId: 99, kind: 'user',
      });
      expect(db.getSkillRun('run-1').coverage.messageCount).toBe(4);
      expect(db.updateSkillRun('run-1', { status: 'sent', messageId: 'msg-1' }).status).toBe('sent');
    });
  });

  test('try again re-runs the skill that was stopped', async () => {
    const gpt = new GptService({
      db,
      getProvider: () => { throw new Error('provider should not be asked'); },
      expenseService: null,
    });
    let calls = 0;
    gpt.skills.run = async ({ text }) => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('aborted');
        err.name = 'AbortedError';
        throw err;
      }
      return { answer: `ran ${text}`, steps: [], choices: [], skillRun: null, expenseDiff: null };
    };
    await runWithTenant(TENANT, async () => {
      const id = 'retry-after-stop';
      await expect(gpt.handleTurn({
        conversationId: id,
        createConversationIfMissing: true,
        message: '/accountant/expense-reconciliation please',
        scopeChatJid: SITE,
        mentions: [{ type: 'chat', chatJid: SITE, chatName: 'Site 1' }],
      })).rejects.toThrow(/aborted/);

      const again = await gpt.handleTurn({
        conversationId: id,
        message: 'pls try again',
        scopeChatJid: SITE,
        mentions: [{ type: 'chat', chatJid: SITE, chatName: 'Site 1' }],
      });
      expect(calls).toBe(2);
      expect(again.answer).toBe('ran /accountant/expense-reconciliation please');
      expect(again.messages.filter((m) => m.role === 'user').at(-1).content).toBe('pls try again');
    });
  });

  test('a slash command never calls the model', async () => {
    const gpt = new GptService({
      db,
      getProvider: () => { throw new Error('provider should not be asked'); },
      expenseService: null,
    });
    await runWithTenant(TENANT, async () => {
      const result = await gpt.handleTurn({ message: '/accountant/expense-reconciliation' });
      expect(result.answer).toContain('Which site chat');
      expect(result.model).toBeNull();
      const assistant = result.messages.find((m) => m.role === 'assistant');
      expect(assistant.payload.skillRun.status).toBe('needs_input');
    });
  });

  test('passes the selected conversation model into a runnable skill', async () => {
    await runWithTenant(TENANT, async () => {
      const selected = { provider: 'ollama', model: 'llama3.2:3b' };
      const selectedProvider = { name: 'ollama', model: selected.model };
      const fallback = { name: 'openrouter', model: 'some-free-model' };
      const resolveProvider = jest.fn(async (_db, selection, fallbackProvider) => ({
        provider: selection ? selectedProvider : fallbackProvider,
        selection: selection || null,
      }));
      const gpt = new GptService({ db, getProvider: () => fallback, resolveProvider });
      let providerUsedBySkill;
      gpt.skills.run = async ({ resolveProvider: resolveSkillProvider }) => {
        providerUsedBySkill = await resolveSkillProvider();
        return { answer: 'done', steps: [], choices: [], skillRun: null, expenseDiff: null };
      };

      const result = await gpt.handleTurn({ message: '/accountant/expense-reconciliation', model: selected });
      expect(resolveProvider).toHaveBeenCalledWith(db, selected, fallback);
      expect(providerUsedBySkill).toBe(selectedProvider);
      expect(result.answer).toBe('done');
      expect(result.conversation.model).toEqual(selected);
    });
  });

  test('confirm send posts the existing report and marks the run sent', async () => {
    const sent = [];
    const gpt = new GptService({
      db,
      getProvider: () => null,
      expenseService: {
        async sendCompletedReport(id) { sent.push(id); },
      },
    });
    await runWithTenant(TENANT, async () => {
      const run = db.createSkillRun({
        id: 'run-send',
        namespace: 'accountant',
        slug: 'expense-reconciliation',
        kind: 'system',
        version: 1,
        status: 'dry_run',
        expenseRunId: 99,
      });
      db.addSearchMessage({
        id: 'msg-send',
        conversationId: (await gpt.handleTurn({ message: '/no-such-skill' })).conversationId,
        role: 'assistant',
        content: 'report',
        payload: { skillRun: { id: run.id, status: 'dry_run', canSend: true } },
      });
      db.updateSkillRun(run.id, { messageId: 'msg-send' });
      const result = await gpt.sendSkillReport(run.id);
      expect(sent).toEqual([99]);
      expect(result.skillRun.status).toBe('sent');
      expect(db.getSearchMessage('msg-send').payload.skillRun.status).toBe('sent');
      expect(db.getSearchMessage('msg-send').payload.skillRun.canSend).toBe(false);
    });
  });
});
