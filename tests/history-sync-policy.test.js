import { describe, expect, test } from '@jest/globals';
import {
  HISTORY_SYNC_TYPE_FULL,
  fullHistoryBackoffSec,
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

describe('fullHistoryBackoffSec', () => {
  test('the first two retries stay immediate so healthy pulls complete at full speed', () => {
    expect(fullHistoryBackoffSec(0)).toBe(0);
    expect(fullHistoryBackoffSec(1)).toBe(0);
    expect(fullHistoryBackoffSec(-1)).toBe(0);
  });

  test('later retries ramp up instead of hammering the phone', () => {
    expect(fullHistoryBackoffSec(2)).toBe(30);
    expect(fullHistoryBackoffSec(4)).toBe(300);
    expect(fullHistoryBackoffSec(7)).toBe(1800);
    expect(fullHistoryBackoffSec(9)).toBe(7200);
  });

  test('a retry is never refused forever — worst case is one attempt per 6h', () => {
    expect(fullHistoryBackoffSec(10)).toBe(6 * 3600);
    expect(fullHistoryBackoffSec(1000)).toBe(6 * 3600);
    expect(fullHistoryBackoffSec('x')).toBe(0);
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
