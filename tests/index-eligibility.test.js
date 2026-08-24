import { describe, expect, test } from '@jest/globals';
import {
  indexMinMessageCount,
  indexRecentWindowDays,
  isChatEligibleForAutoIndex,
  isChatEligibleForIndex,
} from '../src/search/index-eligibility.js';
import DailySummaryService from '../src/search/daily-summary-service.js';

const NOW = 1_777_000_000;
const TEN_DAYS = 10 * 24 * 60 * 60;

describe('index eligibility', () => {
  test('exposes the configured auto-index bar', () => {
    expect(indexMinMessageCount()).toBe(50);
    expect(indexRecentWindowDays()).toBe(10);
  });

  test('requires more than 50 messages and activity inside 10 days', () => {
    const chat = {
      chatJid: 'busy@g.us',
      messageCount: 51,
      lastMessageTs: NOW - 3 * 24 * 60 * 60,
    };
    expect(isChatEligibleForAutoIndex({ ...chat, nowTs: NOW })).toBe(true);
    expect(isChatEligibleForAutoIndex({ ...chat, messageCount: 50, nowTs: NOW })).toBe(false);
    expect(isChatEligibleForAutoIndex({
      ...chat,
      lastMessageTs: NOW - TEN_DAYS - 1,
      nowTs: NOW,
    })).toBe(false);
  });

  test('never auto-indexes Status or newsletter feeds', () => {
    expect(isChatEligibleForAutoIndex({
      chatJid: 'status@broadcast',
      messageCount: 400,
      lastMessageTs: NOW,
      nowTs: NOW,
    })).toBe(false);
  });

  test('an explicit opt-in indexes a small or old chat, including a feed', () => {
    const small = { chatJid: 'quiet@s.whatsapp.net', messageCount: 4, lastMessageTs: NOW };
    expect(isChatEligibleForIndex(small, { optedIn: false })).toBe(false);
    expect(isChatEligibleForIndex(small, { optedIn: true })).toBe(true);
    expect(isChatEligibleForIndex({
      chatJid: 'status@broadcast',
      messageCount: 400,
      lastMessageTs: NOW,
    }, { optedIn: true })).toBe(true);
  });
});

describe('DailySummaryService respects the auto-index bar', () => {
  const now = Math.floor(Date.now() / 1000);
  const base = now - 60;
  const messages = [
    { timestamp: base, sender: 'Asha', text: 'lunch at the usual place' },
    { timestamp: base + 60, sender: 'Ravi', text: 'works for me' },
    { timestamp: base + 120, sender: 'Asha', text: 'see you at one' },
  ];

  function makeService({ messageCount, lastMessageTs, optedIn = false }) {
    let chatCalls = 0;
    const db = {
      getChatStats: () => [{
        chatJid: 'quiet@g.us',
        chatName: 'Quiet',
        messageCount,
        lastMessageTs,
      }],
      getMessageTimestampsForChat: () => messages.map((m) => ({ timestamp: m.timestamp })),
      getSummarizedThreadStarts: () => new Set(),
      getMessagesByTimeRange: () => messages,
      upsertThreadSummary: () => {},
      getPendingFactThreads: () => [],
      getAllSettings: () => ({}),
      listIndexOptInJids: () => (optedIn ? ['quiet@g.us'] : []),
    };
    const service = new DailySummaryService({
      db,
      isWaLive: () => true,
      provider: {
        name: 'ollama',
        model: 'llama3.2:3b',
        checkHealth: async () => true,
        chat: async () => {
          chatCalls += 1;
          return 'Asha and Ravi: lunch at the usual place, see you at one.';
        },
      },
    });
    return { service, chatCalls: () => chatCalls };
  }

  test('does not summarize a recent chat that is still at or below 50 messages', async () => {
    const { service, chatCalls } = makeService({ messageCount: 50, lastMessageTs: now });
    await service.indexPendingDays();
    expect(chatCalls()).toBe(0);
  });

  test('summarizes once the same chat grows past 50 messages', async () => {
    const { service, chatCalls } = makeService({ messageCount: 51, lastMessageTs: now });
    await service.indexPendingDays();
    expect(chatCalls()).toBeGreaterThan(0);
  });

  test('summarizes a small chat after an explicit opt-in', async () => {
    const { service, chatCalls } = makeService({
      messageCount: 4,
      lastMessageTs: now,
      optedIn: true,
    });
    await service.indexPendingDays();
    expect(chatCalls()).toBeGreaterThan(0);
  });
});
