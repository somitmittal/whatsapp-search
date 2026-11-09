import { describe, expect, test } from '@jest/globals';
import { parseToolCalls, runAgent } from '../src/gpt/agent.js';
import { GPT_LIMITS } from '../src/gpt/limits.js';

describe('Runtime Harness: Robust Tool Call Parsing (Ollama / Local Models)', () => {
  test('parses multi-line pretty-printed CALL blocks', () => {
    const text = [
      'CALL {',
      '  "tool": "search",',
      '  "args": {',
      '    "query": "cement delivery"',
      '  }',
      '}',
    ].join('\n');

    const calls = parseToolCalls(text);
    expect(calls).toEqual([
      { name: 'search', args: { query: 'cement delivery' } },
    ]);
  });

  test('parses JSON inside markdown code blocks', () => {
    const text = [
      'I will look up the recent messages about site expenses.',
      '```json',
      '{',
      '  "tool": "search",',
      '  "args": { "query": "expense report" }',
      '}',
      '```',
    ].join('\n');

    const calls = parseToolCalls(text);
    expect(calls).toEqual([
      { name: 'search', args: { query: 'expense report' } },
    ]);
  });

  test('parses an array of tool calls in a markdown block', () => {
    const text = [
      '```json',
      '[',
      '  { "tool": "chats", "args": {} },',
      '  { "tool": "search", "args": { "query": "invoice" } }',
      ']',
      '```',
    ].join('\n');

    const calls = parseToolCalls(text);
    expect(calls).toEqual([
      { name: 'chats', args: {} },
      { name: 'search', args: { query: 'invoice' } },
    ]);
  });

  test('parses standalone raw JSON without CALL keyword', () => {
    const text = '{"tool": "read", "args": {"chat": "Site 2", "date": "2026-10-14"}}';
    const calls = parseToolCalls(text);
    expect(calls).toEqual([
      { name: 'read', args: { chat: 'Site 2', date: '2026-10-14' } },
    ]);
  });

  test('parses Ollama/OpenAI format with function name and stringified arguments', () => {
    const text = JSON.stringify({
      name: 'search',
      arguments: JSON.stringify({ query: 'gravel' }),
    });

    const calls = parseToolCalls(text);
    expect(calls).toEqual([
      { name: 'search', args: { query: 'gravel' } },
    ]);
  });

  test('ignores conversational JSON and does not falsely trigger on plain answers', () => {
    expect(parseToolCalls('The total was {"amount": 500} dollars.')).toEqual([]);
    expect(parseToolCalls('I confirmed the delivery on Tuesday.')).toEqual([]);
    expect(parseToolCalls('Here is the report:\n- Cement: 40 bags\n- Steel: 10 tons [m1]')).toEqual([]);
  });
});

describe('Runtime Harness: Supervisor Guidance', () => {
  test('supervisor adds nudge when search returns 0 matching messages', async () => {
    const replies = [
      'CALL {"tool": "search", "args": {"query": "nonexistent term"}}',
      'I could not find anything [m1].',
    ];

    let recordedMessages = [];
    const fakeProvider = {
      name: 'fake',
      async *chatStream(msgs) {
        recordedMessages = msgs;
        const reply = replies.shift() || 'Done';
        for (let i = 0; i < reply.length; i += 5) yield reply.slice(i, i + 5);
      },
    };

    const toolbox = {
      search: async () => ({ text: 'Found 0 messages.', messages: [] }),
    };

    const ctx = { prefetched: [] };
    await runAgent({
      provider: fakeProvider,
      system: 'You are an assistant',
      history: [],
      contextText: '',
      query: 'Where is the excavator?',
      toolbox,
      ctx,
      emit: () => {},
    });

    // Verify supervisor guidance was injected in user feedback turn
    const toolResultMsg = recordedMessages.find((m) => m.role === 'user' && m.content.includes('Tool results:'));
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.content).toContain('[Supervisor note:');
  });
});
