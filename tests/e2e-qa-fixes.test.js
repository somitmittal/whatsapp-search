import { describe, expect, test } from '@jest/globals';
import Database from '../src/storage/database.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import { parseToolCalls } from '../src/gpt/agent.js';
import { isFollowUpTransformQuery } from '../src/gpt/context.js';
import { budgetsForProvider, GPT_LIMITS } from '../src/gpt/limits.js';
import { shouldConsiderMemory, extractMemoryFromExchange } from '../src/gpt/user-memory.js';
import ChatDirectory from '../src/gpt/chat-directory.js';

describe('E2E QA fixes', () => {
  test('searchChatsByKeyword executes without FTS5 bm25 window-function error', () => {
    const db = new Database(':memory:');
    runWithTenant('t1', () => {
      db.insertMessage({
        chatJid: '120363001@g.us',
        chatName: 'Krisumi Spa And Salon',
        messageId: 'msg-1',
        sender: 'Salon',
        text: 'Pedicure and manicure charges apply with GST',
        timestamp: 1700000000,
      });
      const hits = db.searchChatsByKeyword('pedicure');
      expect(hits.length).toBe(1);
      expect(hits[0].chatJid).toBe('120363001@g.us');
      expect(hits[0].snippet).toContain('Pedicure');
    });
    db.close();
  });

  test('parseToolCalls handles Tools CALL prefix from small local models', () => {
    const calls = parseToolCalls('Tools CALL {"tool":"search","args":{"query":"spa","chat":"Krisumi Spa And Salon"}}');
    expect(calls).toEqual([{ name: 'search', args: { query: 'spa', chat: 'Krisumi Spa And Salon' } }]);
  });

  test('isFollowUpTransformQuery detects pure follow-up formatting/summary requests', () => {
    expect(isFollowUpTransformQuery('summarize the key points in 3 bullets')).toBe(true);
    expect(isFollowUpTransformQuery('make it a table')).toBe(true);
    expect(isFollowUpTransformQuery('what services and charges are discussed here?')).toBe(false);
  });

  test('budgetsForProvider scales down for local Ollama and keeps full budget for cloud', () => {
    const mockDb = { getSetting: (k) => (k === 'ollama_num_ctx' ? '2048' : '') };
    const local = budgetsForProvider({ name: 'ollama', model: 'llama3.2:3b' }, mockDb);
    expect(local.contextTokens).toBeLessThan(GPT_LIMITS.contextTokens);
    expect(local.compactPrompt).toBe(true);

    const cloud = budgetsForProvider({ name: 'groq', model: 'llama-3.3-70b-versatile' }, mockDb);
    expect(cloud.contextTokens).toBe(GPT_LIMITS.contextTokens);
    expect(cloud.compactPrompt).toBe(false);
  });

  test('Option A auto-memory ignores ordinary chat Q&A and rejects prose fallback', async () => {
    expect(shouldConsiderMemory('what services are covered here?', 'Pedicure and manicure are covered.')).toBe(false);
    expect(shouldConsiderMemory('remember that my salon opens at 10am', 'Got it, noted.')).toBe(true);

    const proseProvider = { chat: async () => 'The user asked about pedicure services.' };
    expect(await extractMemoryFromExchange(proseProvider, {
      userText: 'remember that my salon opens at 10am',
      answerText: 'Noted.',
    })).toBeNull();
  });

  test('ChatDirectory.search deduplicates shadow/0-msg chats with the same title', () => {
    const fakeDb = {
      getChatStats: () => [
        { chatJid: '123@g.us', chatName: 'Krisumi Spa And Salon', messageCount: 2, lastMessageTs: 200 },
        { chatJid: '123@lid', chatName: 'Krisumi Spa And Salon', messageCount: 0, lastMessageTs: 100 },
      ],
    };
    const dir = new ChatDirectory(fakeDb);
    const res = runWithTenant('t1', () => dir.search('krisumi', 10));
    expect(res.length).toBe(1);
    expect(res[0].messageCount).toBe(2);
  });
});
