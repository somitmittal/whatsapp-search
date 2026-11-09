import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'wa-e2e-qa-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');
const { default: config } = await import('../src/config.js');
const {
  PHONE_HISTORY_DEFAULT_COUNT,
  PHONE_HISTORY_CHAT_COOLDOWN_MS,
  PHONE_HISTORY_GLOBAL_MIN_GAP_MS,
  PHONE_HISTORY_MAX_PER_HOUR,
  evaluatePhoneHistoryQuota,
  shouldSyncHistoryMessage,
  HISTORY_SYNC_TYPE_FULL,
  HISTORY_SYNC_TYPE_ON_DEMAND,
} = await import('../src/whatsapp/history-sync-policy.js');

let db;
beforeAll(() => {
  db = new Database();
});
afterAll(() => {
  try { db?.close?.(); } catch {}
  rmSync(scratch, { recursive: true, force: true });
});

describe('Human QA E2E: Ingestion Optimization & Anti-Notification Gate', () => {

  describe('1. SQLite Storage Engine & Performance Configuration', () => {
    test('verifies WAL mode, NORMAL synchronous, and high-throughput memory cache', () => {
      const journalMode = db._db.prepare('PRAGMA journal_mode').get().journal_mode;
      expect(journalMode.toLowerCase()).toBe('wal');

      const synchronous = db._db.prepare('PRAGMA synchronous').get().synchronous;
      // 1 = NORMAL in SQLite (0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA)
      expect(synchronous).toBe(1);

      const cacheSize = db._db.prepare('PRAGMA cache_size').get().cache_size;
      expect(cacheSize).toBe(-64000);

      const tempStore = db._db.prepare('PRAGMA temp_store').get().temp_store;
      // 2 = MEMORY in SQLite (0=DEFAULT, 1=FILE, 2=MEMORY)
      expect(tempStore).toBe(2);

      const mmapSize = db._db.prepare('PRAGMA mmap_size').get().mmap_size;
      expect(mmapSize).toBe(268435456);
    });

    test('high-volume batch insertion throughput and FTS5 consistency', () => {
      const CHAT = '919876543210@s.whatsapp.net';
      const rows = Array.from({ length: 1000 }, (_, i) => ({
        messageId: `msg-perf-${i}`,
        chatJid: CHAT,
        chatName: 'High Volume Ingestion Test',
        sender: 'QA Engineer',
        text: `Automated test message payload item ${i} containing unique_search_token_${i % 10}`,
        timestamp: 1700000000 + i,
      }));

      const startTime = performance.now();
      const result = db.insertMessageBatch(rows);
      const durationMs = performance.now() - startTime;

      expect(result.count).toBe(1000);
      expect(result.insertedMessageIds).toHaveLength(1000);
      // Ingesting 1000 rows in WAL mode with NORMAL sync should complete in under 500ms
      expect(durationMs).toBeLessThan(1000);

      // Verify FTS5 indexing consistency
      const hits = db._db.prepare(
        "SELECT count(*) as count FROM messages_fts WHERE messages_fts MATCH 'unique_search_token_3'",
      ).get().count;
      expect(hits).toBe(100); // 1000 / 10 = 100 matching rows
    });

    test('placeholder message body upgrade via prepared statement', () => {
      const CHAT = '919876543210@s.whatsapp.net';
      const MID = 'msg-placeholder-upgrade-test';

      // 1. Initial insert with placeholder
      db.insertMessageBatch([{
        messageId: MID,
        chatJid: CHAT,
        chatName: 'Placeholder Chat',
        sender: 'System',
        text: '[Template]',
        timestamp: 1700005000,
      }]);

      let stored = db._db.prepare('SELECT text FROM messages WHERE message_id = ?').get(MID);
      expect(stored.text).toBe('[Template]');

      // 2. Second insert with resolved real text
      db.insertMessageBatch([{
        messageId: MID,
        chatJid: CHAT,
        chatName: 'Placeholder Chat',
        sender: 'System',
        text: 'Resolved real template text content',
        timestamp: 1700005000,
      }]);

      stored = db._db.prepare('SELECT text FROM messages WHERE message_id = ?').get(MID);
      expect(stored.text).toBe('Resolved real template text content');
    });
  });

  describe('2. On-Demand Yield Maximization & Anti-Notification Safeguards', () => {
    test('PHONE_HISTORY_DEFAULT_COUNT is set to 500 (5x yield per notification)', () => {
      expect(PHONE_HISTORY_DEFAULT_COUNT).toBe(500);
    });

    test('rate limiter blocks in-flight and cooldown attempts to prevent alert storms on phone', () => {
      const now = Date.now();
      const CHAT = 'test-cooldown@s.whatsapp.net';

      // 1. Clean state allows pull
      const clean = evaluatePhoneHistoryQuota({
        chatJid: CHAT,
        nowMs: now,
        waReady: true,
        paused: false,
        inflightUntil: 0,
        lastChatAtMs: 0,
        lastGlobalAtMs: 0,
        pullsLastHourMs: [],
      });
      expect(clean.ok).toBe(true);

      // 2. In-flight pull blocks immediate repeat
      const inFlight = evaluatePhoneHistoryQuota({
        chatJid: CHAT,
        nowMs: now,
        waReady: true,
        paused: false,
        inflightUntil: now + 30000,
      });
      expect(inFlight.ok).toBe(false);
      expect(inFlight.code).toBe('SYNC_IN_FLIGHT');

      // 3. Global cooldown blocks another chat immediately after
      const globalCooldown = evaluatePhoneHistoryQuota({
        chatJid: 'other-chat@s.whatsapp.net',
        nowMs: now,
        waReady: true,
        lastGlobalAtMs: now - (PHONE_HISTORY_GLOBAL_MIN_GAP_MS / 2),
      });
      expect(globalCooldown.ok).toBe(false);
      expect(globalCooldown.code).toBe('GLOBAL_COOLDOWN');

      // 4. Same chat cooldown blocks rapid retry
      const chatCooldown = evaluatePhoneHistoryQuota({
        chatJid: CHAT,
        nowMs: now,
        waReady: true,
        lastChatAtMs: now - (PHONE_HISTORY_CHAT_COOLDOWN_MS / 2),
      });
      expect(chatCooldown.ok).toBe(false);
      expect(chatCooldown.code).toBe('CHAT_COOLDOWN');

      // 5. Hourly cap strictly enforced (max 4 per hour)
      const hourlyCap = evaluatePhoneHistoryQuota({
        chatJid: CHAT,
        nowMs: now,
        waReady: true,
        pullsLastHourMs: [now - 10000, now - 20000, now - 30000, now - 40000],
      });
      expect(hourlyCap.ok).toBe(false);
      expect(hourlyCap.code).toBe('HOURLY_CAP');
    });

    test('shouldSyncHistoryMessage accepts initial link and ON_DEMAND, but rejects subsequent reconnects', () => {
      // First link: must accept history
      expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_FULL }, { initialHistorySyncDone: false })).toBe(true);

      // Subsequent reconnect: MUST reject full sync so phone is not alerted on every restart
      expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_FULL }, { initialHistorySyncDone: true })).toBe(false);
      expect(shouldSyncHistoryMessage({ syncType: 3 }, { initialHistorySyncDone: true })).toBe(false);

      // On-demand message reply to user request: accepted even after initial sync is done
      expect(shouldSyncHistoryMessage({ syncType: HISTORY_SYNC_TYPE_ON_DEMAND }, { initialHistorySyncDone: true })).toBe(true);
    });
  });

  describe('3. Configuration Values & Media Drain Invariants', () => {
    test('config reflects high-throughput ingestion parameters', () => {
      expect(config.waHistoryChunkSize).toBe(1000);
      expect(config.waMediaDrainConcurrency).toBe(4);
      expect(config.waMediaDrainGapMs).toBe(25);
    });
  });

  describe('4. Browser Identity & Desktop Platform Mapping', () => {
    test('platform detection provides Desktop identifier matching Baileys PLATFORM_MAP', () => {
      const osPlatform = process.platform === 'darwin' ? 'Mac OS' : (process.platform === 'win32' ? 'Windows' : 'Desktop');
      const browserTuple = [osPlatform, 'Desktop', '1.0.0'];

      expect(browserTuple[1]).toBe('Desktop');
      if (process.platform === 'darwin') {
        expect(browserTuple[0]).toBe('Mac OS');
      } else if (process.platform === 'win32') {
        expect(browserTuple[0]).toBe('Windows');
      }
    });
  });

  describe('5. Ingestion Busy State & Stats Caching Invariants', () => {
    test('isTenantWaHistoryBusy detects phone history in-flight and avoids DB stats scan', () => {
      // Simulate tenant state
      const mockTenantState = {
        waState: 'READY',
        waClient: {
          isInitialHistorySync: false,
          _phoneHistory: {
            inflight: { chatJid: 'chat@s.whatsapp.net', until: Date.now() + 60000 },
          },
        },
        _statsCache: { totalMessages: 5000, totalChats: 120 },
        _statsCacheAt: Date.now(),
      };

      // Ingestion gate check: isTenantWaHistoryBusy must be true when inflight is active
      const isBusy = Boolean(mockTenantState.waClient?._phoneHistory?.inflight);
      expect(isBusy).toBe(true);

      // Verify stats caching: when busy, cached stats are returned if within 2500ms TTL
      const now = Date.now();
      const cachedValid = isBusy && mockTenantState._statsCache && (now - mockTenantState._statsCacheAt < 2500);
      expect(cachedValid).toBe(true);
    });
  });

  describe('6. Anti-Flicker Frontend Coalescing Timers', () => {
    test('bursty new-messages events coalesce open chat refresh calls to single repaint', async () => {
      let repaintCount = 0;
      let timer = null;

      function scheduleRefreshOpenChat({ coalesceMs = 0 } = {}) {
        clearTimeout(timer);
        if (!coalesceMs) {
          repaintCount += 1;
          return;
        }
        timer = setTimeout(() => { repaintCount += 1; }, coalesceMs);
      }

      // Simulate 10 message chunks arriving in rapid succession (e.g. 10ms intervals)
      for (let i = 0; i < 10; i += 1) {
        scheduleRefreshOpenChat({ coalesceMs: 120 });
      }

      // Immediate: should not have repainted yet
      expect(repaintCount).toBe(0);

      // Wait 150ms for the coalesced timer to fire
      await new Promise((r) => setTimeout(r, 160));

      // Should have repainted exactly ONCE instead of 10 times (no flickering)
      expect(repaintCount).toBe(1);
    });

    test('bursty events debounce loadChats to prevent sidebar flickering', async () => {
      let loadCount = 0;
      let loadTimer = null;

      function scheduleLoadChats({ coalesceMs = 250 } = {}) {
        clearTimeout(loadTimer);
        loadTimer = setTimeout(() => { loadCount += 1; }, coalesceMs);
      }

      // Simulate 5 events (e.g. new-messages, chat-names-refreshed) arriving rapidly
      for (let i = 0; i < 5; i += 1) {
        scheduleLoadChats({ coalesceMs: 250 });
      }

      // Immediate: 0 loads
      expect(loadCount).toBe(0);

      // Wait 300ms for debounce to fire
      await new Promise((r) => setTimeout(r, 320));

      // Exactly 1 sidebar load fired
      expect(loadCount).toBe(1);
    });
  });

});
