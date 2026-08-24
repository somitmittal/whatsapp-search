import { describe, expect, test } from '@jest/globals';
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
