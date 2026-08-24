import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import DailySummaryService from '../src/search/daily-summary-service.js';

describe('DailySummaryService ingestion gate', () => {
  test('does not inspect the indexing backlog while WhatsApp history is still inserting', async () => {
    let providerChecked = false;
    const service = new DailySummaryService({
      db: {
        getChatStats: () => {
          throw new Error('must not read indexing backlog during ingestion');
        },
      },
      provider: {
        checkHealth: async () => {
          providerChecked = true;
          return true;
        },
      },
      shouldDefer: () => true,
    });

    await expect(service.indexPendingDays()).resolves.toBe(0);
    expect(providerChecked).toBe(false);
    expect(service.hasCaughtUp()).toBe(false);
  });

  test('fact extraction also yields to ingestion instead of holding the LLM', async () => {
    let factThreadsQueried = false;
    const service = new DailySummaryService({
      db: {
        getPendingFactThreads: () => {
          factThreadsQueried = true;
          return [{ chatJid: 'a@g.us', threadStart: 1, threadEnd: 2 }];
        },
      },
      provider: {
        name: 'ollama',
        model: 'llama3.2:3b',
        checkHealth: async () => true,
        chat: async () => {
          throw new Error('must not call the LLM during ingestion');
        },
      },
      shouldDefer: () => true,
    });

    await expect(service._indexPendingFacts()).resolves.toBe(0);
    expect(factThreadsQueried).toBe(false);
  });
});

describe('DailySummaryService fact backlog with no summaries left', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('still drains pending facts when every chat is already summarized', async () => {
    // Regression: the early return for an empty summary queue skipped fact extraction
    // entirely, stranding threads that were summarized on an earlier pass. A
    // perpetually-unsummarized thread used to keep the queue non-empty and hide this.
    const settled = [];
    const pending = [{ chatJid: 'a@g.us', chatName: 'A', threadStart: 10, threadEnd: 20 }];

    const service = new DailySummaryService({
      db: {
        // No chats means no unsummarized threads, so the summary queue is empty.
        getChatStats: () => [],
        getPendingFactThreads: () => pending.slice(0, 1),
        getMessagesByTimeRange: () => [{ timestamp: 10, sender: 'A', text: 'invoice due friday' }],
        replaceThreadFacts: () => 1,
        setThreadFactsStatus: (chatJid, threadStart, status) => {
          settled.push({ chatJid, threadStart, status });
          pending.shift();
        },
        getAllSettings: () => ({}),
      },
      isWaLive: () => false,
      provider: {
        name: 'ollama',
        model: 'llama3.2:3b',
        checkHealth: async () => true,
        chat: async () => JSON.stringify([{ search_text: 'invoice due friday' }]),
      },
    });

    await service.indexPendingDays();

    // The thread must reach a terminal status so it leaves the pending queue. Whether
    // the model yielded usable facts ('done') or none ('empty') is not what is under
    // test here — before the fix nothing was called at all and the backlog never moved.
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ chatJid: 'a@g.us', threadStart: 10 });
    expect(['done', 'empty']).toContain(settled[0].status);
    expect(pending).toHaveLength(0);
  });
});
