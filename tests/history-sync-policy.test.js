import { describe, expect, test } from '@jest/globals';
import {
  HISTORY_SYNC_TYPE_FULL,
  shouldRequestRecentDaysCatchUp,
  shouldSyncHistoryMessage,
} from '../src/whatsapp/history-sync-policy.js';

describe('shouldSyncHistoryMessage', () => {
  test('accepts the first link so the initial archive can be stored', () => {
    expect(shouldSyncHistoryMessage({ syncType: 3 })).toBe(true);
    expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_FULL })).toBe(true);
    expect(shouldSyncHistoryMessage({})).toBe(true);
  });

  test('declines every later reconnect so the phone is not notified again', () => {
    const opts = { initialHistorySyncDone: true };
    expect(shouldSyncHistoryMessage({ syncType: 3 }, opts)).toBe(false);
    expect(shouldSyncHistoryMessage({ syncType: 'RECENT' }, opts)).toBe(false);
    expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_FULL }, opts)).toBe(false);
    expect(shouldSyncHistoryMessage({ syncType: 6 }, opts)).toBe(false);
    expect(shouldSyncHistoryMessage({}, opts)).toBe(false);
  });

  test('an explicit full-history override still accepts sync', () => {
    expect(shouldSyncHistoryMessage(
      { syncType: 'RECENT' },
      { syncFullHistory: true, initialHistorySyncDone: true },
    )).toBe(true);
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
