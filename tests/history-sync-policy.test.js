import { describe, expect, test } from '@jest/globals';
import {
  HISTORY_SYNC_TYPE_FULL,
  evaluatePhoneHistoryQuota,
  filterRowsByRetention,
  fullHistoryBackoffSec,
  PHONE_HISTORY_CHAT_COOLDOWN_MS,
  PHONE_HISTORY_GLOBAL_MIN_GAP_MS,
  PHONE_HISTORY_MAX_PER_HOUR,
  shouldRequestRecentDaysCatchUp,
  shouldSyncHistoryMessage,
  HISTORY_SYNC_TYPE_ON_DEMAND,
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
    expect(shouldSyncHistoryMessage({}, opts)).toBe(false);
  });

  test('still accepts ON_DEMAND replies to our own fetchMessageHistory after the first sync', () => {
    const opts = { initialHistorySyncDone: true };
    expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_ON_DEMAND }, opts)).toBe(true);
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

describe('evaluatePhoneHistoryQuota', () => {
  const base = {
    chatJid: 'x@s.whatsapp.net',
    nowMs: 1_000_000_000,
    waReady: true,
    paused: false,
    inflightUntil: 0,
    lastChatAtMs: 0,
    lastGlobalAtMs: 0,
    pullsLastHourMs: [],
  };

  test('allows a quiet account to pull history', () => {
    expect(evaluatePhoneHistoryQuota(base).ok).toBe(true);
  });

  test('blocks while another pull is in flight', () => {
    const r = evaluatePhoneHistoryQuota({ ...base, inflightUntil: base.nowMs + 5000 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('SYNC_IN_FLIGHT');
  });

  test('enforces per-chat cooldown so Refresh spam cannot re-alert the phone', () => {
    const r = evaluatePhoneHistoryQuota({
      ...base,
      lastChatAtMs: base.nowMs - 60_000,
      chatCooldownMs: PHONE_HISTORY_CHAT_COOLDOWN_MS,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('CHAT_COOLDOWN');
  });

  test('enforces a global gap between chats', () => {
    const r = evaluatePhoneHistoryQuota({
      ...base,
      lastGlobalAtMs: base.nowMs - 30_000,
      globalMinGapMs: PHONE_HISTORY_GLOBAL_MIN_GAP_MS,
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('GLOBAL_COOLDOWN');
  });

  test('caps pulls per rolling hour', () => {
    const pulls = Array.from({ length: PHONE_HISTORY_MAX_PER_HOUR }, (_, i) => base.nowMs - i * 60_000);
    const r = evaluatePhoneHistoryQuota({ ...base, pullsLastHourMs: pulls });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('HOURLY_CAP');
  });
});

describe('filterRowsByRetention', () => {
  const nowSec = 1_000_000;
  const row = (ts) => ({ timestamp: ts });

  test('default keeps the entire archive so older messages are stored', () => {
    const rows = [row(nowSec), row(nowSec - 40 * 24 * 60 * 60), row(nowSec - 365 * 24 * 60 * 60)];
    const { keep, skipped } = filterRowsByRetention(rows, { keepDays: 0, nowSec });
    expect(keep).toHaveLength(3);
    expect(skipped).toBe(0);
  });

  test('a positive window sheds only rows older than N days', () => {
    const rows = [
      row(nowSec - 1 * 60),
      row(nowSec - 7 * 24 * 60 * 60),      // exactly on the edge — kept
      row(nowSec - 8 * 24 * 60 * 60 + 1),  // just inside 8d window — kept
      row(nowSec - 9 * 24 * 60 * 60),      // outside — shed
    ];
    const { keep, skipped } = filterRowsByRetention(rows, { keepDays: 8, nowSec });
    expect(keep).toHaveLength(3);
    expect(skipped).toBe(1);
  });

  test('tolerates malformed rows and non-array input', () => {
    expect(filterRowsByRetention(null, { keepDays: 7, nowSec })).toEqual({ keep: [], skipped: 0 });
    const { keep, skipped } = filterRowsByRetention(
      [row(nowSec), { timestamp: undefined }, { timestamp: 'junk' }],
      { keepDays: 7, nowSec },
    );
    expect(keep).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  test('negative or fractional keepDays clamps like the config parse does', () => {
    const rows = [row(nowSec - 400 * 24 * 60 * 60), row(nowSec)];
    const { keep } = filterRowsByRetention(rows, { keepDays: -3, nowSec });
    expect(keep).toHaveLength(2);
    const frac = filterRowsByRetention([row(nowSec - 22 * 3600)], { keepDays: 1.5, nowSec });
    expect(frac.keep).toHaveLength(1);
  });
});
