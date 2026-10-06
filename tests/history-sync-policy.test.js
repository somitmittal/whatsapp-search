import { describe, expect, test } from '@jest/globals';
import {
  HISTORY_SYNC_TYPE_FULL,
  shouldRequestRecentDaysCatchUp,
  shouldSyncHistoryMessage,
} from '../src/whatsapp/history-sync-policy.js';

describe('shouldSyncHistoryMessage', () => {
  test('always ingests RECENT so reconnects catch up while the app was down', () => {
    expect(shouldSyncHistoryMessage({ syncType: 3 }, { syncFullHistory: false })).toBe(true);
    expect(shouldSyncHistoryMessage({ syncType: 'RECENT' }, { syncFullHistory: false })).toBe(true);
  });

  test('skips FULL unless WA_SYNC_FULL_HISTORY is on', () => {
    expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_FULL }, { syncFullHistory: false })).toBe(false);
    expect(shouldSyncHistoryMessage({ syncType: 'FULL' }, { syncFullHistory: false })).toBe(false);
    expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_FULL }, { syncFullHistory: true })).toBe(true);
  });

  test('ingests on-demand / bootstrap / nameless notifications', () => {
    expect(shouldSyncHistoryMessage({ syncType: 0 }, { syncFullHistory: false })).toBe(true);
    expect(shouldSyncHistoryMessage({ syncType: 6 }, { syncFullHistory: false })).toBe(true);
    expect(shouldSyncHistoryMessage({}, { syncFullHistory: false })).toBe(true);
  });
});

describe('shouldRequestRecentDaysCatchUp', () => {
  test('skips when few chats are stale (no phone sync)', () => {
    expect(shouldRequestRecentDaysCatchUp({ staleChatCount: 2, lastSyncAtSec: 0, nowSec: 1_000_000 })).toBe(false);
  });

  test('runs once when many chats froze, then respects cooldown', () => {
    expect(shouldRequestRecentDaysCatchUp({
      staleChatCount: 20,
      lastSyncAtSec: 0,
      nowSec: 1_000_000,
    })).toBe(true);
    expect(shouldRequestRecentDaysCatchUp({
      staleChatCount: 20,
      lastSyncAtSec: 1_000_000 - 60,
      nowSec: 1_000_000,
      cooldownSec: 3600,
    })).toBe(false);
    expect(shouldRequestRecentDaysCatchUp({
      staleChatCount: 20,
      lastSyncAtSec: 1_000_000 - 4000,
      nowSec: 1_000_000,
      cooldownSec: 3600,
    })).toBe(true);
  });
});
