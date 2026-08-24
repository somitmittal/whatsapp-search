import { describe, expect, test } from '@jest/globals';
import DailySummaryService from '../src/search/daily-summary-service.js';

/**
 * A thread whose LLM output is entirely stripped by the grounding filter never gets a
 * `thread_summaries` row, so it stays on the pending list. Without a retry budget the
 * service re-summarizes it on every pass forever, pinning the local model.
 */
function serviceWithThread(reply) {
  const chatJid = 'archive@imported';
  const base = 1_700_000_000;
  const messages = [
    { timestamp: base, sender: 'Asha', text: 'lunch at the usual place' },
    { timestamp: base + 60, sender: 'Ravi', text: 'works for me' },
    { timestamp: base + 120, sender: 'Asha', text: 'see you at one' },
  ];

  let chatCalls = 0;
  const saved = [];

  const db = {
    getChatStats: () => [{
      chatJid,
      chatName: 'Archive',
      messageCount: messages.length,
      lastMessageTs: base + 120,
    }],
    getMessageTimestampsForChat: () => messages.map((m) => ({ timestamp: m.timestamp })),
    getSummarizedThreadStarts: () => new Set(),
    getMessagesByTimeRange: () => messages,
    upsertThreadSummary: (row) => saved.push(row),
    getPendingFactThreads: () => [],
    getAllSettings: () => ({}),
    listIndexOptInJids: () => [chatJid],
  };

  const service = new DailySummaryService({
    db,
    isWaLive: () => false,
    provider: {
      name: 'ollama',
      model: 'llama3.2:3b',
      checkHealth: async () => true,
      chat: async () => {
        chatCalls += 1;
        return reply;
      },
    },
  });

  return { service, saved, chatCalls: () => chatCalls };
}

/** Every word appears in the transcript, so the grounding filter keeps it. */
const GROUNDED_REPLY = 'Asha and Ravi: lunch at the usual place, see you at one.';
/** Nothing here appears in the transcript, so grounding removes all of it. */
const UNGROUNDED_REPLY = 'Trump and SEBI discussed a Mars colony budget of 40 crore.';

describe('DailySummaryService thread retry budget', () => {
  test('stops re-summarizing a thread whose output never survives grounding', async () => {
    const { service, saved, chatCalls } = serviceWithThread(UNGROUNDED_REPLY);

    for (let pass = 0; pass < 5; pass++) {
      await service.indexPendingDays();
    }

    expect(saved).toEqual([]);
    expect(chatCalls()).toBe(3);
  });

  test('keeps retrying a thread that still has attempts left', async () => {
    const { service, chatCalls } = serviceWithThread(UNGROUNDED_REPLY);

    await service.indexPendingDays();
    expect(chatCalls()).toBe(1);
    await service.indexPendingDays();
    expect(chatCalls()).toBe(2);
  });

  test('a groundable summary is saved and never counts toward the give-up budget', async () => {
    const { service, saved, chatCalls } = serviceWithThread(GROUNDED_REPLY);

    for (let pass = 0; pass < 5; pass++) {
      await service.indexPendingDays();
    }

    expect(saved).toHaveLength(5);
    expect(saved[0].summary).toContain('lunch at the usual place');
    expect(chatCalls()).toBe(5);
  });
});
