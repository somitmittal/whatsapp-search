import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import config from '../config.js';
import { buildSearchText } from '../search/fact-extract.js';
import { getCurrentTenantId } from './tenant-context.js';
import {
  migrateAwaySummaries,
  migrateContactDirectory,
  migrateMultiTenant,
  migrateSessionTransfers,
  migrateWhatsAppIdentities,
  migrateUserSessionsAndNullableTenants,
} from './migrate-multi-tenant.js';
import { LEGACY_TENANT_ID } from './tenant-constants.js';
import { decryptName, deriveTenantContactKey, encryptName, hashPhone, normalizePhone } from '../privacy/contact-directory.js';
import { groupStatusBroadcastRows } from '../status/status-feed.js';
import { STATUS_BROADCAST_JID, sidebarTabForJid } from '../whatsapp/jid-filters.js';
import {
  formatPhoneLocalPart,
  isPlausibleHumanChatTitle,
  looksLikeLidFallbackContactLabel,
} from '../whatsapp/chat-display-name.js';
import { MAX_MESSAGES_PAGE } from '../constants/api-limits.js';
import { reactionParticipantSlotKey } from '../whatsapp/reaction-counts.js';

const require = createRequire(import.meta.url);
const SQLite = require('better-sqlite3');

/** True if `name` is a better sidebar title than the bare JID local part (avoids last-outgoing-msg wiping the label). */
function looksLikeContactDisplayName(name, chatJid) {
  return isPlausibleHumanChatTitle(name, chatJid);
}

/** True if the string is only a phone number (no letters) — poor sidebar title vs push names / saved names. */
function looksLikePhoneOnly(str) {
  if (!str || typeof str !== 'string') return false;
  const d = str.replace(/\s/g, '').replace(/^\+/, '');
  return /^\d{8,20}$/.test(d);
}

export default class Database {
  constructor() {
    const dir = dirname(config.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this._db = new SQLite(config.dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._initSchema();
    migrateMultiTenant(this._db);
    migrateUserSessionsAndNullableTenants(this._db);
    migrateSessionTransfers(this._db);
    migrateWhatsAppIdentities(this._db);
    migrateAwaySummaries(this._db);
    migrateContactDirectory(this._db);
    this._ensureMessagesTenantChatTsIndex();
    this._prepareStatements();
    this._migrateChatActionItemsTable();
    this._migrateOllamaCloudModelSettings();
  }

  /**
   * Ollama Cloud model IDs are the same strings as `ollama run name:tag` (e.g. qwen3.5:4b, glm-5.1:cloud).
   * `:cloud` is part of the official model name for some GLM routes — not a separate "cloud suffix" you add yourself.
   * This migration only rewrites known-bad *exact* IDs stored from older app defaults; it does not strip `:cloud`.
   */
  _migrateOllamaCloudModelSettings() {
    const rename = {
      'deepseek-r1:8b': 'deepseek-r1:7b',
      'mistral-small3.1:24b': 'mistral-small3.2:24b',
    };
    const fix = (providerKey, modelKey) => {
      if (this.getSetting(providerKey) !== 'ollama_cloud') return;
      const cur = this.getSetting(modelKey);
      if (!cur) return;
      const next = rename[cur];
      if (next) {
        this.setSetting(modelKey, next);
        console.log(`[DB] Ollama Cloud ${modelKey}: "${cur}" → "${next}"`);
      }
    };
    fix('summary_provider', 'summary_model');
    fix('llm_provider', 'llm_model');
  }

  _initSchema() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        chat_jid TEXT NOT NULL,
        chat_name TEXT,
        sender TEXT,
        sender_jid TEXT,
        text TEXT,
        media_type TEXT,
        media_path TEXT,
        media_caption TEXT,
        media_ai_index TEXT,
        timestamp INTEGER NOT NULL,
        indexed_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS daily_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        chat_name TEXT,
        date TEXT NOT NULL,
        summary TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(chat_jid, date)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_state (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS thread_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        chat_name TEXT,
        thread_start INTEGER NOT NULL,
        thread_end INTEGER NOT NULL,
        summary TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(chat_jid, thread_start)
      );
    `);

    this._migrateFtsToPorter();

    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text, sender, chat_name, media_caption, media_ai_index,
        content='messages', content_rowid='id',
        tokenize='porter unicode61'
      );
    `);

    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
        summary, chat_name, date,
        content='daily_summaries', content_rowid='id',
        tokenize='porter unicode61'
      );
    `);

    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thread_summaries_fts USING fts5(
        summary, chat_name,
        content='thread_summaries', content_rowid='id',
        tokenize='porter unicode61'
      );
    `);

    this._db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
        VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.id);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.id);
        INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
        VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
      END;
      CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON daily_summaries BEGIN
        INSERT INTO summaries_fts(rowid, summary, chat_name, date)
        VALUES (new.id, new.summary, new.chat_name, new.date);
      END;
      CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON daily_summaries BEGIN
        INSERT INTO summaries_fts(summaries_fts, rowid) VALUES('delete', old.id);
      END;
      CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON daily_summaries BEGIN
        INSERT INTO summaries_fts(summaries_fts, rowid) VALUES('delete', old.id);
        INSERT INTO summaries_fts(rowid, summary, chat_name, date)
        VALUES (new.id, new.summary, new.chat_name, new.date);
      END;
      CREATE TRIGGER IF NOT EXISTS thread_summaries_ai AFTER INSERT ON thread_summaries BEGIN
        INSERT INTO thread_summaries_fts(rowid, summary, chat_name)
        VALUES (new.id, new.summary, new.chat_name);
      END;
      CREATE TRIGGER IF NOT EXISTS thread_summaries_ad AFTER DELETE ON thread_summaries BEGIN
        INSERT INTO thread_summaries_fts(thread_summaries_fts, rowid) VALUES('delete', old.id);
      END;
      CREATE TRIGGER IF NOT EXISTS thread_summaries_au AFTER UPDATE ON thread_summaries BEGIN
        INSERT INTO thread_summaries_fts(thread_summaries_fts, rowid) VALUES('delete', old.id);
        INSERT INTO thread_summaries_fts(rowid, summary, chat_name)
        VALUES (new.id, new.summary, new.chat_name);
      END;

      CREATE TABLE IF NOT EXISTS thread_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid TEXT NOT NULL,
        chat_name TEXT,
        thread_start INTEGER NOT NULL,
        thread_end INTEGER NOT NULL,
        fact_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        search_text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_facts_chat_thread ON thread_facts(chat_jid, thread_start);
    `);

    this._db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS thread_facts_fts USING fts5(
        search_text, fact_type, chat_name,
        content='thread_facts', content_rowid='id',
        tokenize='porter unicode61'
      );
    `);

    this._db.exec(`
      CREATE TRIGGER IF NOT EXISTS thread_facts_ai AFTER INSERT ON thread_facts BEGIN
        INSERT INTO thread_facts_fts(rowid, search_text, fact_type, chat_name)
        VALUES (new.id, new.search_text, new.fact_type, COALESCE(new.chat_name, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS thread_facts_ad AFTER DELETE ON thread_facts BEGIN
        INSERT INTO thread_facts_fts(thread_facts_fts, rowid) VALUES('delete', old.id);
      END;
      CREATE TRIGGER IF NOT EXISTS thread_facts_au AFTER UPDATE ON thread_facts BEGIN
        INSERT INTO thread_facts_fts(thread_facts_fts, rowid) VALUES('delete', old.id);
        INSERT INTO thread_facts_fts(rowid, search_text, fact_type, chat_name)
        VALUES (new.id, new.search_text, new.fact_type, COALESCE(new.chat_name, ''));
      END;
    `);

    this._migrateMediaAiIndexAndFts();
    this._migrateActionSuggestionsColumn();
    this._migrateReactionsJsonAndDedupe();
    this._migrateContactPayloadColumn();
    this._migrateChatImportTouches();
    this._rebuildFtsIfEmpty();
  }

  _migrateChatImportTouches() {
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS chat_import_touches (
          tenant_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          touched_at INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, chat_jid)
        );
      `);
    } catch (e) {
      console.warn('[DB] chat_import_touches:', e.message);
    }
  }

  /** Bump sidebar sort order after every successful import parse (including re-imports). */
  recordChatImportTouch(chatJid, touchedAt = Math.floor(Date.now() / 1000)) {
    if (!chatJid) return;
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO chat_import_touches (tenant_id, chat_jid, touched_at)
      VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, chat_jid) DO UPDATE SET touched_at = excluded.touched_at
    `).run(t, chatJid, touchedAt);
  }

  /** Speeds up getChatStats() and per-chat timeline queries (tenant-scoped ordered scan). */
  _ensureMessagesTenantChatTsIndex() {
    try {
      const cols = this._db.prepare('PRAGMA table_info(messages)').all();
      if (!cols.some((c) => c.name === 'tenant_id')) return;
      this._db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_tenant_chat_ts
        ON messages(tenant_id, chat_jid, timestamp)
      `);
    } catch (e) {
      console.warn('[DB] idx_messages_tenant_chat_ts:', e.message);
    }
  }

  _migrateContactPayloadColumn() {
    try {
      const cols = this._db.prepare('PRAGMA table_info(messages)').all();
      if (!cols.some((c) => c.name === 'contact_payload')) {
        this._db.exec('ALTER TABLE messages ADD COLUMN contact_payload TEXT');
        console.log('[DB] Added messages.contact_payload');
      }
    } catch (e) {
      console.warn('[DB] contact_payload column:', e.message);
    }
  }

  _migrateReactionsJsonAndDedupe() {
    try {
      const cols = this._db.prepare('PRAGMA table_info(messages)').all();
      if (!cols.some((c) => c.name === 'reactions_json')) {
        this._db.exec('ALTER TABLE messages ADD COLUMN reactions_json TEXT');
        console.log('[DB] Added messages.reactions_json');
      }
    } catch (e) {
      console.warn('[DB] reactions_json column:', e.message);
    }
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS wa_reaction_dedupe (
          tenant_id TEXT NOT NULL,
          reaction_msg_id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, reaction_msg_id)
        );
      `);
    } catch (e) {
      console.warn('[DB] wa_reaction_dedupe:', e.message);
    }
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS wa_reaction_slot (
          tenant_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          slot_key TEXT NOT NULL,
          last_emoji TEXT NOT NULL,
          PRIMARY KEY (tenant_id, message_id, slot_key)
        );
      `);
    } catch (e) {
      console.warn('[DB] wa_reaction_slot:', e.message);
    }
  }

  /**
   * Merge one reaction ack into `messages.reactions_json` (flat emoji → count).
   * Uses per-participant slots so emoji changes and removals adjust counts correctly.
   * @param {string} chatJid
   * @param {string} messageId — target message id
   * @param {string} emoji — empty when reaction removed (Baileys: reaction.text falsey)
   * @param {string} reactionMsgId — id of the reaction message (dedupe)
   * @param {{ groupingKey?: string, reactionKey?: { participant?: string|null, fromMe?: boolean|null } }} [meta]
   * @returns {Record<string, number>|null} updated counts, or null if skipped / no row / no-op
   */
  mergeReactionEvent(chatJid, messageId, emoji, reactionMsgId, meta = {}) {
    if (!chatJid || !messageId || !reactionMsgId) return null;
    const t = getCurrentTenantId();
    const newEmoji = emoji != null ? String(emoji).trim() : '';
    const slotKey = reactionParticipantSlotKey(meta.groupingKey, meta.reactionKey);

    const insDedupe = this._db.prepare(
      'INSERT OR IGNORE INTO wa_reaction_dedupe (tenant_id, reaction_msg_id) VALUES (?, ?)',
    );
    const rowFind = this._db.prepare(`
      SELECT id, reactions_json AS reactionsJson FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND message_id = ?
      LIMIT 1
    `);
    const rowFindLoose = this._db.prepare(`
      SELECT id, reactions_json AS reactionsJson FROM messages
      WHERE tenant_id = ? AND message_id = ?
      LIMIT 1
    `);
    const selSlot = this._db.prepare(`
      SELECT last_emoji AS lastEmoji FROM wa_reaction_slot
      WHERE tenant_id = ? AND message_id = ? AND slot_key = ?
      LIMIT 1
    `);
    const delSlot = this._db.prepare(
      'DELETE FROM wa_reaction_slot WHERE tenant_id = ? AND message_id = ? AND slot_key = ?',
    );
    const insSlot = this._db.prepare(`
      INSERT INTO wa_reaction_slot (tenant_id, message_id, slot_key, last_emoji)
      VALUES (?, ?, ?, ?)
    `);
    const upd = this._db.prepare('UPDATE messages SET reactions_json = ? WHERE id = ?');

    const parseCounts = (raw) => {
      let counts = {};
      try {
        counts = raw ? JSON.parse(raw) : {};
      } catch {
        counts = {};
      }
      if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) counts = {};
      return counts;
    };

    const run = this._db.transaction(() => {
      const d = insDedupe.run(t, reactionMsgId);
      if (!d.changes) return null;

      let row = rowFind.get(t, chatJid, messageId);
      if (!row) row = rowFindLoose.get(t, messageId);
      if (!row) return null;

      const counts = parseCounts(row.reactionsJson);
      const slotRow = selSlot.get(t, messageId, slotKey);
      const oldEmoji = slotRow?.lastEmoji != null ? String(slotRow.lastEmoji).trim() : '';

      let changed = false;

      if (oldEmoji) {
        const next = (Number(counts[oldEmoji]) || 0) - 1;
        if (next <= 0) {
          if (counts[oldEmoji] !== undefined) changed = true;
          delete counts[oldEmoji];
        } else if (counts[oldEmoji] !== next) {
          counts[oldEmoji] = next;
          changed = true;
        }
      }

      if (newEmoji) {
        const prev = Number(counts[newEmoji]) || 0;
        counts[newEmoji] = prev + 1;
        changed = true;
        delSlot.run(t, messageId, slotKey);
        insSlot.run(t, messageId, slotKey, newEmoji);
      } else {
        delSlot.run(t, messageId, slotKey);
        if (oldEmoji) changed = true;
      }

      if (!changed) return null;

      upd.run(JSON.stringify(counts), row.id);
      return counts;
    });

    try {
      return run();
    } catch (err) {
      console.warn('[DB] mergeReactionEvent:', err.message);
      return null;
    }
  }

  /**
   * Replace slot rows for a message (after history sync). Does not touch counts — pair with UPDATE reactions_json.
   * @param {string} messageId
   * @param {Array<{ groupingKey?: string|null, reactionKey?: object, text?: string|null }>} slots
   */
  replaceReactionSlotsForMessage(messageId, slots) {
    if (!messageId) return;
    const t = getCurrentTenantId();
    const delAll = this._db.prepare(
      'DELETE FROM wa_reaction_slot WHERE tenant_id = ? AND message_id = ?',
    );
    const ins = this._db.prepare(`
      INSERT INTO wa_reaction_slot (tenant_id, message_id, slot_key, last_emoji)
      VALUES (?, ?, ?, ?)
    `);
    try {
      delAll.run(t, messageId);
      for (const s of slots || []) {
        const te = s?.text != null ? String(s.text).trim() : '';
        if (!te) continue;
        const sk = reactionParticipantSlotKey(s.groupingKey, s.reactionKey);
        ins.run(t, messageId, sk, te);
      }
    } catch (e) {
      console.warn('[DB] replaceReactionSlotsForMessage:', e.message);
    }
  }

  /**
   * Apply reactions + slots from a synced WA row when the message already existed (INSERT OR IGNORE).
   * @param {object} row — must include messageId; optional reactionsJson (string), reactionSlots (array)
   */
  applySyncedMessageReactions(messageId, row) {
    if (!messageId || !row) return;
    const t = getCurrentTenantId();
    const hasSlots = row.reactionSlots !== undefined;
    const hasJson = row.reactionsJson != null;
    if (!hasSlots && !hasJson) return;

    try {
      if (hasSlots) {
        this.replaceReactionSlotsForMessage(messageId, row.reactionSlots || []);
      }
      if (hasJson) {
        this._db
          .prepare('UPDATE messages SET reactions_json = ? WHERE tenant_id = ? AND message_id = ?')
          .run(row.reactionsJson, t, messageId);
      } else if (hasSlots && (!row.reactionSlots || row.reactionSlots.length === 0)) {
        this._db
          .prepare('UPDATE messages SET reactions_json = NULL WHERE tenant_id = ? AND message_id = ?')
          .run(t, messageId);
      }
    } catch (e) {
      console.warn('[DB] applySyncedMessageReactions:', e.message);
    }
  }

  _migrateActionSuggestionsColumn() {
    try {
      const cols = this._db.prepare('PRAGMA table_info(messages)').all();
      if (cols.some((c) => c.name === 'action_suggestions')) return;
      this._db.exec('ALTER TABLE messages ADD COLUMN action_suggestions TEXT');
      console.log('[DB] Added messages.action_suggestions');
    } catch (e) {
      console.warn('[DB] action_suggestions column:', e.message);
    }
  }

  _migrateChatActionItemsTable() {
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS chat_action_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_jid TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          items_json TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          UNIQUE(chat_jid, source_message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_action_items_jid ON chat_action_items(chat_jid);
      `);
      const migrated = this.getState('chat_action_items_migrated');
      if (!migrated) {
        const rows = this._db.prepare(
          `SELECT chat_jid AS chatJid, message_id AS messageId, action_suggestions AS raw FROM messages
           WHERE tenant_id = ? AND action_suggestions IS NOT NULL AND trim(action_suggestions) NOT IN ('', '[]')`,
        ).all(LEGACY_TENANT_ID);
        const ins = this._db.prepare(`
          INSERT OR REPLACE INTO chat_action_items (tenant_id, chat_jid, source_message_id, items_json, created_at)
          VALUES (?, ?, ?, ?, unixepoch())
        `);
        for (const r of rows) {
          try {
            const arr = JSON.parse(r.raw);
            if (Array.isArray(arr) && arr.length) ins.run(LEGACY_TENANT_ID, r.chatJid, r.messageId, JSON.stringify(arr));
          } catch { /* skip */ }
        }
        this.setState('chat_action_items_migrated', '1');
        if (rows.length) console.log(`[DB] Migrated ${rows.length} row(s) into chat_action_items`);
      }
    } catch (e) {
      console.warn('[DB] chat_action_items:', e.message);
    }
  }

  /**
   * Adds `media_ai_index` on legacy DBs and rebuilds `messages_fts` when it was created
   * without the fifth column (image/audio transcript + vision caption text for search).
   */
  _migrateMediaAiIndexAndFts() {
    try {
      const cols = this._db.prepare('PRAGMA table_info(messages)').all();
      const hasCol = cols.some((c) => c.name === 'media_ai_index');
      if (!hasCol) {
        this._db.exec('ALTER TABLE messages ADD COLUMN media_ai_index TEXT');
        console.log('[DB] Added messages.media_ai_index');
      }
    } catch (e) {
      console.warn('[DB] media_ai_index column:', e.message);
    }

    const row = this._db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'",
    ).get();
    const sql = row?.sql ? String(row.sql) : '';
    if (sql.includes('media_ai_index')) return;

    console.log('[DB] Rebuilding messages_fts for media_ai_index...');
    this._db.exec('DROP TRIGGER IF EXISTS messages_ai');
    this._db.exec('DROP TRIGGER IF EXISTS messages_ad');
    this._db.exec('DROP TRIGGER IF EXISTS messages_au');
    this._db.exec('DROP TABLE IF EXISTS messages_fts');
    this._db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text, sender, chat_name, media_caption, media_ai_index,
        content='messages', content_rowid='id',
        tokenize='porter unicode61'
      );
    `);
    this._db.exec(`
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
        VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
      END;
      CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.id);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.id);
        INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
        VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
      END;
    `);
    try {
      this._db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    } catch (e) {
      console.warn('[DB] FTS rebuild:', e.message);
    }
    console.log('[DB] messages_fts media_ai_index migration done');
  }

  _rebuildFtsIfEmpty() {
    const msgCount = this._db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    if (msgCount === 0) return;

    try {
      const sample = this._db.prepare(
        "SELECT rowid FROM messages_fts LIMIT 1"
      ).get();
      if (sample) return;
    } catch {
      // FTS table was just created — needs rebuild
    }

    console.log(`[DB] Rebuilding FTS index for ${msgCount} messages...`);
    this._db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    this._db.exec("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')");
    console.log('[DB] FTS rebuild complete.');
  }

  _migrateFtsToPorter() {
    const needsMigration = (() => {
      try {
        const row = this._db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'"
        ).get();
        if (!row) return false;
        return !row.sql.toLowerCase().includes('porter');
      } catch {
        return false;
      }
    })();

    if (!needsMigration) return;

    console.log('[DB] Upgrading FTS tables to porter stemmer...');
    this._db.exec('DROP TABLE IF EXISTS messages_fts');
    this._db.exec('DROP TABLE IF EXISTS summaries_fts');
    this._db.exec('DROP TRIGGER IF EXISTS messages_ai');
    this._db.exec('DROP TRIGGER IF EXISTS messages_ad');
    this._db.exec('DROP TRIGGER IF EXISTS messages_au');
    this._db.exec('DROP TRIGGER IF EXISTS summaries_ai');
    this._db.exec('DROP TRIGGER IF EXISTS summaries_ad');
    this._db.exec('DROP TRIGGER IF EXISTS summaries_au');
  }

  _prepareStatements() {
    this._stmtInsertMessage = this._db.prepare(`
      INSERT OR IGNORE INTO messages (
        tenant_id, message_id, chat_jid, chat_name, sender, sender_jid,
        text, media_type, media_path, media_caption, media_ai_index, timestamp, reactions_json, contact_payload
      ) VALUES (
        @tenantId, @messageId, @chatJid, @chatName, @sender, @senderJid,
        @text, @mediaType, @mediaPath, @mediaCaption, @mediaAiIndex, @timestamp, @reactionsJson, @contactPayload
      )
    `);
    this._stmtSelectIdByMessageId = this._db.prepare(
      'SELECT id FROM messages WHERE tenant_id = ? AND message_id = ?'
    );
    this._stmtGetState = this._db.prepare('SELECT value FROM agent_state WHERE key = ?');
    this._stmtUpsertState = this._db.prepare(`
      INSERT INTO agent_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this._stmtUpsertSummary = this._db.prepare(`
      INSERT INTO daily_summaries (tenant_id, chat_jid, chat_name, date, summary, message_count)
      VALUES (@tenantId, @chatJid, @chatName, @date, @summary, @messageCount)
      ON CONFLICT(tenant_id, chat_jid, date) DO UPDATE SET
        summary = excluded.summary, chat_name = excluded.chat_name,
        message_count = excluded.message_count
    `);
    this._stmtGetSetting = this._db.prepare(
      'SELECT value FROM tenant_settings WHERE tenant_id = ? AND key = ?',
    );
    this._stmtUpsertSetting = this._db.prepare(`
      INSERT INTO tenant_settings (tenant_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value
    `);

    this._stmtUpsertChatLastSeen = this._db.prepare(`
      INSERT INTO chat_last_seen (tenant_id, chat_jid, last_seen_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(tenant_id, chat_jid) DO UPDATE SET last_seen_ts = excluded.last_seen_ts
    `);
    this._stmtGetChatLastSeen = this._db.prepare(
      `SELECT last_seen_ts AS lastSeenTs FROM chat_last_seen WHERE tenant_id = ? AND chat_jid = ?`,
    );
    this._stmtGetThreadSummariesSince = this._db.prepare(`
      SELECT chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount, created_at AS createdAt
      FROM thread_summaries
      WHERE tenant_id = ? AND chat_jid = ? AND thread_end > ?
      ORDER BY thread_end DESC
      LIMIT ?
    `);

    this._stmtUpsertContact = this._db.prepare(`
      INSERT INTO contact_directory (tenant_id, phone_hash, enc_name, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(tenant_id, phone_hash) DO UPDATE SET
        enc_name = excluded.enc_name,
        updated_at = unixepoch()
    `);
    this._stmtGetContactByHash = this._db.prepare(
      'SELECT enc_name AS encName FROM contact_directory WHERE tenant_id = ? AND phone_hash = ?',
    );
  }

  // ── Contacts (hashed at rest) ─────────────────────────────────────────

  /**
   * Upsert a list of contacts from a phone directory.
   * @param {Array<{ name: string, phones: string[] }>} contacts
   * @returns {{ inserted: number, updatedChats: number }}
   */
  syncContactDirectory(contacts) {
    const t = getCurrentTenantId();
    const key = deriveTenantContactKey(t);
    let inserted = 0;
    const run = this._db.transaction((rows) => {
      for (const c of rows || []) {
        const name = String(c?.name || '').trim();
        if (!name) continue;
        const enc = encryptName(key, name);
        if (!enc) continue;
        const phones = Array.isArray(c?.phones) ? c.phones : [];
        for (const p of phones) {
          const digits = normalizePhone(p);
          if (!digits) continue;
          const h = hashPhone(key, digits);
          if (!h) continue;
          const info = this._stmtUpsertContact.run(t, h, enc);
          if (info?.changes) inserted += 1;
        }
      }
    });
    run(contacts || []);
    const updatedChats = this.backfillChatNamesFromContactDirectory();
    return { inserted, updatedChats };
  }

  /**
   * Backfill chat_name for 1:1 chats where chat_name is missing/phone-only using the contact directory.
   * Stores the plain display name in `messages.chat_name` for UX (directory itself stays encrypted+hashed).
   */
  backfillChatNamesFromContactDirectory(limitChats = 2500) {
    const t = getCurrentTenantId();
    const key = deriveTenantContactKey(t);
    const rows = this._db.prepare(
      `SELECT chat_jid AS chatJid, MAX(timestamp) AS lastTs
       FROM messages
       WHERE tenant_id = ?
         AND chat_jid NOT LIKE '%@g.us'
       GROUP BY chat_jid
       ORDER BY lastTs DESC
       LIMIT ?`,
    ).all(t, Math.max(1, Math.min(Number(limitChats) || 2500, 10000)));

    let updated = 0;
    const upd = this._db.prepare('UPDATE messages SET chat_name = ? WHERE tenant_id = ? AND chat_jid = ?');
    for (const r of rows) {
      const chatJid = r.chatJid;
      if (!chatJid) continue;
      const digits = normalizePhone(String(chatJid).split('@')[0]);
      if (!digits) continue;
      const h = hashPhone(key, digits);
      const enc = this._stmtGetContactByHash.get(t, h)?.encName || '';
      if (!enc) continue;
      const name = decryptName(key, enc);
      if (!name) continue;
      const info = upd.run(name, t, chatJid);
      updated += info?.changes || 0;
    }
    if (updated > 0) console.log(`[DB] Backfilled chat_name from contact directory on ${updated} message row(s)`);
    return updated;
  }

  // ── While-you-were-away ───────────────────────────────────────────────

  markChatSeen(chatJid, ts = null) {
    if (!chatJid) return 0;
    const t = getCurrentTenantId();
    const when = ts != null ? Number(ts) : Math.floor(Date.now() / 1000);
    this._stmtUpsertChatLastSeen.run(t, chatJid, when);
    return when;
  }

  getChatLastSeen(chatJid) {
    if (!chatJid) return 0;
    const t = getCurrentTenantId();
    return this._stmtGetChatLastSeen.get(t, chatJid)?.lastSeenTs || 0;
  }

  getAwayThreadSummaries(chatJid, limit = 3) {
    const t = getCurrentTenantId();
    const lastSeen = this.getChatLastSeen(chatJid);
    const rows = this._stmtGetThreadSummariesSince.all(
      t,
    chatJid,
      lastSeen,
      Math.max(1, Math.min(Number(limit) || 3, 10)),
    );
    return { lastSeenTs: lastSeen, summaries: rows || [] };
  }

  // ── Settings ──────────────────────────────────────────────────────────

  getSetting(key) {
    const row = this._stmtGetSetting.get(getCurrentTenantId(), key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this._stmtUpsertSetting.run(getCurrentTenantId(), key, String(value));
  }

  getAllSettings() {
    return this._db.prepare('SELECT key, value FROM tenant_settings WHERE tenant_id = ?').all(getCurrentTenantId())
      .reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  }

  /**
   * Resolve tenant for WABA webhooks (Meta has no session cookie).
   * @param {string} key
   * @param {string} value
   * @returns {string | null}
   */
  findTenantIdBySetting(key, value) {
    if (!key || value == null) return null;
    const row = this._db.prepare(
      'SELECT tenant_id AS tenantId FROM tenant_settings WHERE key = ? AND value = ? LIMIT 1',
    ).get(key, String(value));
    return row?.tenantId || null;
  }

  /**
   * @param {string[]} factTypes
   * @param {number} [limit]
   */
  listThreadFactsByTypes(factTypes, limit = 50) {
    const types = (factTypes || []).filter(Boolean);
    if (!types.length) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const t = getCurrentTenantId();
    const placeholders = types.map(() => '?').join(',');
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             fact_type AS factType, payload_json AS payloadJson
      FROM thread_facts
      WHERE tenant_id = ? AND fact_type IN (${placeholders})
      ORDER BY thread_end DESC
      LIMIT ?
    `).all(t, ...types, safeLimit);
  }

  // ── Messages ──────────────────────────────────────────────────────────

  insertMessage({
    messageId, chatJid, chatName = null, sender = null, senderJid = null,
    text = null, mediaType = null, mediaPath = null, mediaCaption = null, mediaAiIndex = null, timestamp,
    reactionsJson = null, contactPayload = null,
  }) {
    const tenantId = getCurrentTenantId();
    const info = this._stmtInsertMessage.run({
      tenantId,
      messageId, chatJid, chatName, sender, senderJid,
      text, mediaType, mediaPath, mediaCaption, mediaAiIndex, timestamp,
      reactionsJson,
      contactPayload,
    });
    if (info.changes > 0) return Number(info.lastInsertRowid);
    const row = this._stmtSelectIdByMessageId.get(tenantId, messageId);
    return row ? row.id : Number(info.lastInsertRowid);
  }

  /**
   * @returns {{ count: number, insertedMessageIds: string[] }}
   */
  insertMessageBatch(rows) {
    const tenantId = getCurrentTenantId();
    const insertedMessageIds = [];
    const run = this._db.transaction((batch) => {
      for (const row of batch) {
        const info = this._stmtInsertMessage.run({
          tenantId,
          messageId: row.messageId,
          chatJid: row.chatJid,
          chatName: row.chatName ?? null,
          sender: row.sender ?? null,
          senderJid: row.senderJid ?? null,
          text: row.text ?? null,
          mediaType: row.mediaType ?? null,
          mediaPath: row.mediaPath ?? null,
          mediaCaption: row.mediaCaption ?? null,
          mediaAiIndex: row.mediaAiIndex ?? null,
          timestamp: row.timestamp,
          reactionsJson: row.reactionsJson ?? null,
          contactPayload: row.contactPayload ?? null,
        });
        const hasRx = row.reactionsJson != null || row.reactionSlots !== undefined;
        if (info.changes > 0 && row.messageId) {
          insertedMessageIds.push(row.messageId);
          if (hasRx) {
            if (row.reactionSlots !== undefined) {
              this.replaceReactionSlotsForMessage(row.messageId, row.reactionSlots || []);
            }
          }
        } else if (info.changes === 0 && row.messageId && hasRx) {
          this.applySyncedMessageReactions(row.messageId, row);
        }
      }
    });
    run(rows || []);
    return { count: insertedMessageIds.length, insertedMessageIds };
  }

  /**
   * When we learn a human-readable chat title (from WA), backfill all rows for that chat so the sidebar
   * and search stop showing bare phone / LID after older messages were stored with a numeric label.
   */
  propagateChatDisplayName(chatJid, chatName) {
    if (!chatJid || !chatName || !looksLikeContactDisplayName(chatName, chatJid)) return 0;
    const t = getCurrentTenantId();
    const r = this._db.prepare('UPDATE messages SET chat_name = ? WHERE tenant_id = ? AND chat_jid = ?').run(chatName, t, chatJid);
    return r.changes ?? 0;
  }

  updateMediaCaption(messageId, caption) {
    const t = getCurrentTenantId();
    this._db.prepare('UPDATE messages SET media_caption = ? WHERE tenant_id = ? AND message_id = ?')
      .run(caption, t, messageId);
  }

  updateMessageMediaPath(messageId, mediaPath) {
    if (!messageId) return 0;
    const t = getCurrentTenantId();
    const r = this._db.prepare('UPDATE messages SET media_path = ? WHERE tenant_id = ? AND message_id = ?')
      .run(mediaPath, t, messageId);
    return r.changes ?? 0;
  }

  updateMessageMedia(messageId, mediaType, mediaPath) {
    if (!messageId || !mediaPath) return 0;
    const r = this._db.prepare(
      `UPDATE messages SET media_type = ?, media_path = ?
       WHERE message_id = ? AND (media_path IS NULL OR trim(media_path) = '')`
    ).run(mediaType, mediaPath, messageId);
    return r.changes ?? 0;
  }

  /** Chat JID for a message id (WebSocket media-ready, etc.). */
  getMessageChatJid(messageId) {
    if (!messageId) return null;
    const t = getCurrentTenantId();
    const row = this._db.prepare(
      'SELECT chat_jid AS chatJid FROM messages WHERE tenant_id = ? AND message_id = ? LIMIT 1',
    ).get(t, messageId);
    return row?.chatJid || null;
  }

  /**
   * Oldest stored row for Baileys `fetchMessageHistory` (on-demand history before that message).
   */
  getOldestMessageAnchor(chatJid) {
    if (!chatJid) return null;
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT message_id AS messageId, timestamp,
             CASE WHEN sender = 'You' THEN 1 ELSE 0 END AS fromMe
      FROM messages WHERE tenant_id = ? AND chat_jid = ?
      ORDER BY timestamp ASC, id ASC
      LIMIT 1
    `).get(t, chatJid);
    return row || null;
  }

  /** @param jsonStr JSON array string e.g. `["…","…"]` or `[]` after processing */
  updateMessageActionSuggestions(messageId, jsonStr) {
    if (!messageId) return 0;
    const t = getCurrentTenantId();
    const r = this._db.prepare('UPDATE messages SET action_suggestions = ? WHERE tenant_id = ? AND message_id = ?')
      .run(jsonStr ?? '', t, messageId);
    return r.changes ?? 0;
  }

  getMessageRowByMessageId(messageId) {
    if (!messageId) return null;
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName,
             sender, text, media_caption AS mediaCaption, timestamp
      FROM messages WHERE tenant_id = ? AND message_id = ?
    `).get(t, messageId);
  }

  /** Per-chat action list; each row ties suggestions to a source message. */
  upsertChatActionItems(chatJid, sourceMessageId, itemsArray) {
    if (!chatJid || !sourceMessageId) return;
    const t = getCurrentTenantId();
    const items = (itemsArray || []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!items.length) {
      this._db.prepare('DELETE FROM chat_action_items WHERE tenant_id = ? AND chat_jid = ? AND source_message_id = ?').run(t, chatJid, sourceMessageId);
      return;
    }
    this._db.prepare(`
      INSERT INTO chat_action_items (tenant_id, chat_jid, source_message_id, items_json, created_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(tenant_id, chat_jid, source_message_id) DO UPDATE SET
        items_json = excluded.items_json,
        created_at = unixepoch()
    `).run(t, chatJid, sourceMessageId, JSON.stringify(items));
  }

  getChatActionItemsWithContext(chatJid) {
    if (!chatJid) return [];
    const t = getCurrentTenantId();
    const rows = this._db.prepare(`
      SELECT c.source_message_id AS sourceMessageId, c.items_json AS itemsJson, c.created_at AS createdAt,
             m.text AS snippet, m.timestamp AS messageTs
      FROM chat_action_items c
      LEFT JOIN messages m ON m.tenant_id = c.tenant_id AND m.message_id = c.source_message_id AND m.chat_jid = c.chat_jid
      WHERE c.tenant_id = ? AND c.chat_jid = ?
      ORDER BY c.created_at DESC
    `).all(t, chatJid);
    return rows.map((r) => {
      let items = [];
      try {
        items = JSON.parse(r.itemsJson || '[]');
      } catch { /* */ }
      if (!Array.isArray(items) || !items.length) return null;
      return {
        sourceMessageId: r.sourceMessageId,
        items,
        createdAt: r.createdAt,
        messageTimestamp: r.messageTs ?? null,
        snippet: String(r.snippet || '').slice(0, 140),
      };
    }).filter(Boolean);
  }

  /**
   * 1:1 customer chats where the latest message is not from the business ("You").
   * Excludes WhatsApp groups (@g.us).
   */
  getChatsAwaitingReply(limit = 15) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 15, 50));
    const t = getCurrentTenantId();
    const rows = this._db.prepare(`
      WITH latest AS (
        SELECT chat_jid AS chatJid, sender, text, timestamp,
               ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) AS rn
        FROM messages
        WHERE tenant_id = ?
          AND chat_jid NOT LIKE '%@g.us'
      ),
      names AS (
        SELECT chat_jid AS chatJid, chat_name AS chatName
        FROM (
          SELECT chat_jid, chat_name,
                 ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) AS rn
          FROM messages
          WHERE tenant_id = ? AND chat_name IS NOT NULL AND chat_name != ''
        ) WHERE rn = 1
      )
      SELECT l.chatJid, COALESCE(n.chatName, l.chatJid) AS chatName,
             l.sender AS lastSender, l.text AS lastText, l.timestamp AS lastMessageTs
      FROM latest l
      LEFT JOIN names n ON n.chatJid = l.chatJid
      WHERE l.rn = 1
        AND (l.sender IS NULL OR l.sender = '' OR l.sender != 'You')
      ORDER BY l.timestamp DESC
      LIMIT ?
    `).all(t, t, safeLimit);
    return rows.map((r) => ({
      chatJid: r.chatJid,
      chatName: r.chatName,
      lastSender: r.lastSender || 'Customer',
      lastText: String(r.lastText || '').slice(0, 160),
      lastMessageTs: r.lastMessageTs,
    }));
  }

  /** Open follow-up suggestions across all chats (newest first). */
  getAllActionItemsAcrossChats(limit = 20) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 60));
    const t = getCurrentTenantId();
    const rows = this._db.prepare(`
      SELECT c.chat_jid AS chatJid, c.source_message_id AS sourceMessageId,
             c.items_json AS itemsJson, c.created_at AS createdAt,
             m.text AS snippet, m.timestamp AS messageTs, m.chat_name AS chatName
      FROM chat_action_items c
      LEFT JOIN messages m ON m.tenant_id = c.tenant_id AND m.message_id = c.source_message_id AND m.chat_jid = c.chat_jid
      WHERE c.tenant_id = ?
      ORDER BY c.created_at DESC
      LIMIT ?
    `).all(t, safeLimit * 3);
    const out = [];
    for (const r of rows) {
      if (out.length >= safeLimit) break;
      let items = [];
      try {
        items = JSON.parse(r.itemsJson || '[]');
      } catch { /* */ }
      if (!Array.isArray(items) || !items.length) continue;
      out.push({
        chatJid: r.chatJid,
        chatName: r.chatName || r.chatJid,
        sourceMessageId: r.sourceMessageId,
        items: items.slice(0, 3),
        createdAt: r.createdAt,
        messageTimestamp: r.messageTs ?? null,
        snippet: String(r.snippet || '').slice(0, 140),
      });
    }
    return out;
  }

  /**
   * Persists AI-generated searchable text for image/video/sticker captions and audio transcripts.
   * Empty string means "indexed but nothing usable" (avoids infinite retries).
   */
  updateMediaAiIndex(messageId, text) {
    if (!messageId) return 0;
    const t = getCurrentTenantId();
    const r = this._db.prepare('UPDATE messages SET media_ai_index = ? WHERE tenant_id = ? AND message_id = ?')
      .run(text ?? '', t, messageId);
    return r.changes ?? 0;
  }

  /**
   * Rows with downloaded media that still need caption/transcribe (media_ai_index IS NULL).
   * When `priorityChatJid` is set, rows in that chat are ordered before others (same global newest-first within each tier).
   */
  getPendingMediaIndexJobs(limit = 12, priorityChatJid = null) {
    const n = Math.max(1, Math.min(Number(limit) || 12, 40));
    const t = getCurrentTenantId();
    const prio = priorityChatJid && String(priorityChatJid).trim()
      ? String(priorityChatJid).trim()
      : null;
    if (prio) {
      return this._db.prepare(`
        SELECT id, message_id AS messageId, chat_jid AS chatJid, media_type AS mediaType, media_path AS mediaPath,
               media_caption AS mediaCaption, text AS text
        FROM messages
        WHERE tenant_id = ?
          AND media_path IS NOT NULL AND trim(media_path) != ''
          AND media_type IN ('image', 'audio', 'video', 'sticker', 'document')
          AND media_ai_index IS NULL
        ORDER BY CASE WHEN chat_jid = ? THEN 0 ELSE 1 END, timestamp DESC
        LIMIT ?
      `).all(t, prio, n);
    }
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid, media_type AS mediaType, media_path AS mediaPath,
             media_caption AS mediaCaption, text AS text
      FROM messages
      WHERE tenant_id = ?
        AND media_path IS NOT NULL AND trim(media_path) != ''
        AND media_type IN ('image', 'audio', 'video', 'sticker', 'document')
        AND media_ai_index IS NULL
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(t, n);
  }

  // ── Daily Summaries ───────────────────────────────────────────────────

  upsertDailySummary({ chatJid, chatName = null, date, summary, messageCount = 0 }) {
    this._stmtUpsertSummary.run({
      tenantId: getCurrentTenantId(), chatJid, chatName, date, summary, messageCount,
    });
  }

  getDailySummaries(chatJid) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries WHERE tenant_id = ? AND chat_jid = ? ORDER BY date ASC
    `).all(t, chatJid);
  }

  getAllDailySummaries() {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries WHERE tenant_id = ? ORDER BY date ASC
    `).all(t);
  }

  countDailySummaries() {
    const t = getCurrentTenantId();
    return this._db.prepare('SELECT COUNT(*) AS c FROM daily_summaries WHERE tenant_id = ?').get(t)?.c || 0;
  }

  getDailySummary(chatJid, date) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries
      WHERE tenant_id = ? AND chat_jid = ? AND date = ?
    `).get(t, chatJid, date);
  }

  /** Recent days (chronological) — FTS-empty fallback without loading all rows. */
  getRecentDailySummaries(chatJid = null, limit = 32) {
    const safe = Math.max(1, Math.min(Number(limit) || 32, 200));
    const t = getCurrentTenantId();
    if (chatJid) {
      const rows = this._db.prepare(`
        SELECT id, chat_jid AS chatJid, chat_name AS chatName,
               date, summary, message_count AS messageCount
        FROM daily_summaries
        WHERE tenant_id = ? AND chat_jid = ?
        ORDER BY date DESC
        LIMIT ?
      `).all(t, chatJid, safe);
      return rows.reverse();
    }
    const rows = this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries
      WHERE tenant_id = ?
      ORDER BY date DESC
      LIMIT ?
    `).all(t, safe);
    return rows.reverse();
  }

  /** Recent threads (chronological order) without loading the full table — FTS-empty fallback. */
  getRecentThreadSummaries(chatJid = null, limit = 32) {
    const safe = Math.max(1, Math.min(Number(limit) || 32, 200));
    const t = getCurrentTenantId();
    if (chatJid) {
      const rows = this._db.prepare(`
        SELECT id, chat_jid AS chatJid, chat_name AS chatName,
               thread_start AS threadStart, thread_end AS threadEnd,
               summary, message_count AS messageCount
        FROM thread_summaries
        WHERE tenant_id = ? AND chat_jid = ?
        ORDER BY thread_start DESC
        LIMIT ?
      `).all(t, chatJid, safe);
      return rows.reverse();
    }
    const rows = this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries
      WHERE tenant_id = ?
      ORDER BY thread_start DESC
      LIMIT ?
    `).all(t, safe);
    return rows.reverse();
  }

  _toFtsQuery(query) {
    const STOP_WORDS = new Set([
      'a','an','the','is','are','was','were','be','been','being','have','has','had',
      'do','does','did','will','would','shall','should','may','might','must','can','could',
      'i','me','my','we','our','you','your','he','she','it','they','them','their',
      'what','which','who','whom','this','that','these','those','am','or','and','but',
      'if','then','else','when','where','how','why','all','each','every','both','few',
      'more','most','some','any','no','not','only','very','just','about','also','so',
      'than','too','of','in','on','at','to','for','with','from','by','as','into',
      'through','during','before','after','above','below','between','up','down','out',
      'off','over','under','again','further','once','here','there','find','get','tell',
      'discussed','recently','today','yesterday','sent','said',
    ]);
    const words = String(query)
      .replace(/[^\w\s]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w));
    if (words.length === 0) return null;
    return words.map(w => `"${w}" OR ${w}*`).join(' OR ');
  }

  searchSummaries(query, chatJid = null, limit = 10) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
    const cleaned = this._toFtsQuery(query);
    if (!cleaned) return [];
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT ds.id, ds.chat_jid AS chatJid, ds.chat_name AS chatName,
             ds.date, ds.summary, ds.message_count AS messageCount,
             bm25(summaries_fts) AS rank
      FROM summaries_fts
      INNER JOIN daily_summaries ds ON ds.id = summaries_fts.rowid
      WHERE ds.tenant_id = ?
        AND summaries_fts MATCH ?
        AND (? IS NULL OR ds.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(t, cleaned, chatJid, chatJid, safeLimit);
  }

  searchMessages(query, chatJid = null, limit = 20) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 500));
    const cleaned = this._toFtsQuery(query);
    if (!cleaned) return [];
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT m.id, m.message_id AS messageId, m.chat_jid AS chatJid,
             m.chat_name AS chatName, m.sender, m.text,
             m.media_type AS mediaType, m.media_path AS mediaPath, m.media_caption AS mediaCaption,
             m.media_ai_index AS mediaAiIndex, m.contact_payload AS contactPayload,
             m.timestamp, bm25(messages_fts) AS rank
      FROM messages_fts
      INNER JOIN messages m ON m.id = messages_fts.rowid
      WHERE m.tenant_id = ?
        AND messages_fts MATCH ?
        AND (? IS NULL OR m.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(t, cleaned, chatJid, chatJid, safeLimit);
  }

  getMessagesForDay(chatJid, dateStr) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex, timestamp
      FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND date(timestamp, 'unixepoch', 'localtime') = ?
      ORDER BY timestamp ASC
    `).all(t, chatJid, dateStr);
  }

  getUnsummarizedDays(chatJid) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT date(timestamp, 'unixepoch', 'localtime') AS date, COUNT(*) AS messageCount
      FROM messages
      WHERE tenant_id = ? AND chat_jid = ?
        AND date(timestamp, 'unixepoch', 'localtime') NOT IN (
          SELECT date FROM daily_summaries WHERE tenant_id = ? AND chat_jid = ?
        )
      GROUP BY date(timestamp, 'unixepoch', 'localtime')
      HAVING messageCount >= 1 ORDER BY date ASC
    `).all(t, chatJid, t, chatJid);
  }

  // ── General Queries ───────────────────────────────────────────────────

  getState(key) {
    const row = this._stmtGetState.get(key);
    return row === undefined ? undefined : row.value;
  }

  setState(key, value) {
    this._stmtUpsertState.run(key, String(value));
  }

  /** Distinct chat JIDs with at least one message (for WA name backfill). */
  getDistinctChatJids() {
    const t = getCurrentTenantId();
    const rows = this._db.prepare('SELECT DISTINCT chat_jid AS chatJid FROM messages WHERE tenant_id = ?').all(t);
    return rows.map((r) => r.chatJid).filter(Boolean);
  }

  getChatStats() {
    const t = getCurrentTenantId();

    const summaryRows = this._db.prepare(
      'SELECT chat_jid AS chatJid, COUNT(*) AS c FROM thread_summaries WHERE tenant_id = ? GROUP BY chat_jid',
    ).all(t);
    const summarizedByChat = new Map(summaryRows.map((r) => [r.chatJid, r.c]));

    const aggRows = this._db.prepare(`
        SELECT
        chat_jid   AS chatJid,
        COUNT(*)   AS messageCount,
        MAX(timestamp) AS lastMessageTs,
        COUNT(DISTINCT sender) AS participantCount
      FROM messages WHERE tenant_id = ?
        GROUP BY chat_jid
    `).all(t);

    const touchRows = this._db.prepare(
      'SELECT chat_jid AS chatJid, touched_at AS touchedAt FROM chat_import_touches WHERE tenant_id = ?',
    ).all(t);
    const importTouchedAt = new Map(touchRows.map((r) => [r.chatJid, r.touchedAt]));

    const goodNameRows = this._db.prepare(`
      SELECT chat_jid AS chatJid, chat_name AS chatName, sender
      FROM (
        SELECT chat_jid, chat_name, sender,
               ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) AS rn
        FROM messages WHERE tenant_id = ?
          AND chat_name IS NOT NULL AND chat_name != ''
          AND chat_name NOT LIKE 'Contact (%'
          AND NOT (LENGTH(chat_name) <= 25 AND chat_name GLOB '[0-9-]*')
      ) WHERE rn <= 3
    `).all(t);

    const fallbackNameRows = this._db.prepare(`
      SELECT chat_jid AS chatJid, chat_name AS chatName, sender
      FROM (
        SELECT chat_jid, chat_name, sender,
               ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) AS rn
        FROM messages WHERE tenant_id = ?
          AND chat_name IS NOT NULL AND chat_name != ''
      ) WHERE rn = 1
    `).all(t);

    const peerRows = this._db.prepare(`
      SELECT chat_jid AS chatJid, sender
      FROM (
        SELECT chat_jid, sender,
               ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) AS rn
        FROM messages WHERE tenant_id = ?
          AND sender IS NOT NULL AND sender != '' AND sender != 'You'
          AND NOT (LENGTH(sender) <= 20 AND sender GLOB '[0-9]*')
      ) WHERE rn <= 2
    `).all(t);

    const fallbackPeerRows = this._db.prepare(`
      SELECT chat_jid AS chatJid, sender
      FROM (
        SELECT chat_jid, sender,
               ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC) AS rn
        FROM messages WHERE tenant_id = ?
          AND sender IS NOT NULL AND sender != '' AND sender != 'You'
      ) WHERE rn = 1
    `).all(t);

    const titlesByChat = new Map();
    const addRow = (jid, row) => {
      if (!titlesByChat.has(jid)) titlesByChat.set(jid, []);
      titlesByChat.get(jid).push(row);
    };
    for (const r of goodNameRows) addRow(r.chatJid, r);
    for (const r of fallbackNameRows) {
      if (!titlesByChat.has(r.chatJid)) addRow(r.chatJid, r);
    }
    for (const r of peerRows) addRow(r.chatJid, { chatJid: r.chatJid, chatName: null, sender: r.sender });
    for (const r of fallbackPeerRows) {
      const existing = titlesByChat.get(r.chatJid) || [];
      if (!existing.some(e => e.sender && e.sender !== 'You')) {
        addRow(r.chatJid, { chatJid: r.chatJid, chatName: null, sender: r.sender });
      }
    }

    const resolveTitle = (chatJid, rows) => {
      const isGroup = chatJid.endsWith('@g.us');
      let displayChatName = null;
      let anyChatName = null;
      let peerSenderName = null;
      let bestHumanPeerName = null;

      for (const r of (rows || [])) {
        if (r.chatName) {
          anyChatName = r.chatName;
          if (looksLikeContactDisplayName(r.chatName, chatJid)) {
            const cn = String(r.chatName).trim();
            if (!displayChatName || cn.length > displayChatName.length) displayChatName = cn;
          }
        }
        if (!isGroup && r.sender && r.sender !== 'You') {
          peerSenderName = r.sender;
          if (!looksLikePhoneOnly(r.sender) && isPlausibleHumanChatTitle(r.sender, chatJid)) {
            const sn = r.sender.trim();
            if (!bestHumanPeerName || sn.length > bestHumanPeerName.length) bestHumanPeerName = sn;
          }
        }
      }

      let title = isGroup
        ? (displayChatName || anyChatName || chatJid)
        : (displayChatName
          || bestHumanPeerName
          || ((looksLikePhoneOnly(anyChatName) || looksLikeLidFallbackContactLabel(anyChatName)) ? null : anyChatName)
          || peerSenderName
          || anyChatName
          || chatJid);

      if (
        !isGroup
        && (chatJid.endsWith('@s.whatsapp.net') || chatJid.endsWith('@hosted'))
        && looksLikeLidFallbackContactLabel(title)
      ) {
        title = formatPhoneLocalPart(chatJid.split('@')[0]);
      }
      return title;
    };

    const out = [];
    for (const agg of aggRows) {
      if (!agg.chatJid) continue;
      const chatJid = agg.chatJid;
      let summarizedThreads = summarizedByChat.get(chatJid) || 0;
      const estThreads = Math.max(1, Math.ceil(agg.messageCount / 12));
      if (summarizedThreads > estThreads) summarizedThreads = estThreads;
      const searchIndexPct = summarizedThreads > 0
        ? Math.min(100, Math.round((summarizedThreads / estThreads) * 100))
        : 0;

      const msgTs = agg.lastMessageTs || 0;
      const touchTs = importTouchedAt.get(chatJid) || 0;
      out.push({
        chatJid,
        chatName: resolveTitle(chatJid, titlesByChat.get(chatJid)),
        sidebarTab: sidebarTabForJid(chatJid),
        messageCount: agg.messageCount,
        participantCount: agg.participantCount,
        lastMessageTs: msgTs,
        lastImportedAt: touchTs || null,
        totalThreads: estThreads,
        summarizedThreads,
        searchIndexPct,
        aiSearchReady: summarizedThreads > 0,
        aiSearchComplete: summarizedThreads >= estThreads,
      });
    }

    let pinImportJid = null;
    let pinImportTs = 0;
    for (const [jid, ts] of importTouchedAt) {
      if (ts > pinImportTs) {
        pinImportTs = ts;
        pinImportJid = jid;
      }
    }

    const chatListRank = (c) => {
      const lm = c.lastMessageTs || 0;
      const n = Math.max(1, c.messageCount || 0);
      return lm * Math.log1p(n);
    };
    out.sort((a, b) => {
      if (pinImportJid) {
        if (a.chatJid === pinImportJid) return -1;
        if (b.chatJid === pinImportJid) return 1;
      }
      const ia = a.lastImportedAt || 0;
      const ib = b.lastImportedAt || 0;
      if (ib !== ia) return ib - ia;
      const ra = chatListRank(a);
      const rb = chatListRank(b);
      if (rb !== ra) return rb - ra;
      return (b.lastMessageTs || 0) - (a.lastMessageTs || 0);
    });
    return out;
  }

  getQuickChatInfo(chatJid) {
    const t = getCurrentTenantId();
    const agg = this._db.prepare(`
      SELECT COUNT(*) AS messageCount, MAX(timestamp) AS lastMessageTs,
             COUNT(DISTINCT sender) AS participantCount
      FROM messages WHERE tenant_id = ? AND chat_jid = ?
    `).get(t, chatJid);
    const nameRow = this._db.prepare(`
      SELECT chat_name FROM messages
      WHERE tenant_id = ? AND chat_jid = ?
        AND chat_name IS NOT NULL AND chat_name != '' AND chat_name NOT LIKE 'Contact (%'
      ORDER BY timestamp DESC LIMIT 1
    `).get(t, chatJid);
    const fallbackRow = !nameRow ? this._db.prepare(`
      SELECT chat_name FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND chat_name IS NOT NULL AND chat_name != ''
      ORDER BY timestamp DESC LIMIT 1
    `).get(t, chatJid) : null;
    return {
      chatJid,
      chatName: nameRow?.chat_name || fallbackRow?.chat_name || null,
      messageCount: agg?.messageCount || 0,
      participantCount: agg?.participantCount || 0,
      lastMessageTs: agg?.lastMessageTs || null,
    };
  }

  getTotalStats() {
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE tenant_id = ?) AS totalMessages,
        (SELECT COUNT(DISTINCT chat_jid) FROM messages WHERE tenant_id = ?) AS totalChats,
        (SELECT COUNT(*) FROM daily_summaries WHERE tenant_id = ?) AS dailySummaries,
        (SELECT COUNT(*) FROM thread_summaries WHERE tenant_id = ?) AS threadSummaries,
        (SELECT COUNT(*) FROM thread_facts WHERE tenant_id = ?) AS threadFacts
    `).get(t, t, t, t, t);
    return {
      totalMessages: row.totalMessages,
      totalChats: row.totalChats,
      totalSummaries: row.dailySummaries + row.threadSummaries,
      threadSummaries: row.threadSummaries,
      dailySummaries: row.dailySummaries,
      threadFacts: row.threadFacts || 0,
    };
  }

  getMessagesPaginated(chatJid, limit = 80, offset = 0) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_path AS mediaPath,
             media_caption AS mediaCaption, media_ai_index AS mediaAiIndex,
             reactions_json AS reactionsJson, contact_payload AS contactPayload,
             timestamp, indexed_at AS indexedAt
      FROM messages WHERE tenant_id = ? AND chat_jid = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(t, chatJid, Math.min(Number(limit) || 80, MAX_MESSAGES_PAGE), Math.max(0, Number(offset) || 0));
  }

  /**
   * Same as getMessagesPaginated but merge rows indexed under multiple JIDs (e.g. @lid vs @s.whatsapp.net).
   */
  getMessagesPaginatedForJids(chatJids, limit = 80, offset = 0) {
    const jids = [...new Set((chatJids || []).filter(Boolean))];
    if (jids.length === 0) return [];
    if (jids.length === 1) return this.getMessagesPaginated(jids[0], limit, offset);
    const t = getCurrentTenantId();
    const lim = Math.min(Number(limit) || 80, MAX_MESSAGES_PAGE);
    const off = Math.max(0, Number(offset) || 0);
    const ph = jids.map(() => '?').join(',');
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_path AS mediaPath,
             media_caption AS mediaCaption, media_ai_index AS mediaAiIndex,
             reactions_json AS reactionsJson, contact_payload AS contactPayload,
             timestamp, indexed_at AS indexedAt
      FROM messages WHERE tenant_id = ? AND chat_jid IN (${ph})
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(t, ...jids, lim, off);
  }

  /**
   * Loads a window of messages so `messageId` appears near the middle (for “jump to source”).
   */
  getMessagesAroundMessageId(chatJid, messageId, limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 40), MAX_MESSAGES_PAGE);
    const half = Math.floor(safeLimit / 2);
    const t = getCurrentTenantId();
    const anchor = this._db.prepare(
      'SELECT id, timestamp FROM messages WHERE tenant_id = ? AND chat_jid = ? AND message_id = ? LIMIT 1',
    ).get(t, chatJid, messageId);
    if (!anchor) return this.getMessagesPaginated(chatJid, safeLimit, 0);

    const rankRow = this._db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
    `).get(t, chatJid, anchor.timestamp, anchor.timestamp, anchor.id);
    const newerCount = rankRow?.c ?? 0;
    const offset = Math.max(0, newerCount - half);
    return this.getMessagesPaginated(chatJid, safeLimit, offset);
  }

  /**
   * Jump-to-message across merged LID + phone JIDs for one contact.
   */
  getMessagesAroundMessageIdForJids(chatJids, messageId, limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 40), MAX_MESSAGES_PAGE);
    const half = Math.floor(safeLimit / 2);
    const jids = [...new Set((chatJids || []).filter(Boolean))];
    if (jids.length === 0) return [];
    if (jids.length === 1) return this.getMessagesAroundMessageId(jids[0], messageId, safeLimit);
    const t = getCurrentTenantId();
    const ph = jids.map(() => '?').join(',');
    const anchor = this._db.prepare(`
      SELECT id, timestamp FROM messages
      WHERE tenant_id = ? AND message_id = ? AND chat_jid IN (${ph}) LIMIT 1
    `).get(t, messageId, ...jids);
    if (!anchor) return this.getMessagesPaginatedForJids(jids, safeLimit, 0);
    const rankRow = this._db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE tenant_id = ? AND chat_jid IN (${ph}) AND (timestamp > ? OR (timestamp = ? AND id > ?))
    `).get(t, ...jids, anchor.timestamp, anchor.timestamp, anchor.id);
    const newerCount = rankRow?.c ?? 0;
    const offset = Math.max(0, newerCount - half);
    return this.getMessagesPaginatedForJids(jids, safeLimit, offset);
  }

  getMediaMessages(chatJid = null, mediaType = null, limit = 50) {
    const t = getCurrentTenantId();
    let sql = `SELECT id, message_id AS messageId, chat_jid AS chatJid,
      chat_name AS chatName, sender, text, media_type AS mediaType,
      media_caption AS mediaCaption, timestamp
      FROM messages WHERE tenant_id = ? AND media_type IS NOT NULL`;
    const params = [t];
    if (chatJid) { sql += ' AND chat_jid = ?'; params.push(chatJid); }
    if (mediaType) { sql += ' AND media_type = ?'; params.push(mediaType); }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(Math.min(Number(limit) || 50, 200));
    return this._db.prepare(sql).all(...params);
  }

  /** WhatsApp Status / Stories: grouped stacks from indexed `status@broadcast` messages. */
  getStatusBroadcastFeed(limitPeers = 80) {
    const t = getCurrentTenantId();
    const rows = this._db.prepare(`
      SELECT message_id AS messageId, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_path AS mediaPath,
             media_caption AS mediaCaption, timestamp
      FROM messages
      WHERE tenant_id = ? AND chat_jid = ?
      ORDER BY timestamp ASC
    `).all(t, STATUS_BROADCAST_JID);
    return groupStatusBroadcastRows(rows, limitPeers);
  }

  /** Lookup for serving downloaded media bytes (path validated against media dir in HTTP layer). */
  getMessageMediaRecord(messageId) {
    if (!messageId) return null;
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT message_id AS messageId, media_path AS mediaPath, media_type AS mediaType
      FROM messages WHERE tenant_id = ? AND message_id = ?
    `).get(t, messageId);
  }

  /**
   * For reactions / quoted send: load the exact row (chat must match) or any row with that id (LID/PN merge).
   * @returns {object | null}
   */
  getMessageForActions(chatJid, messageId) {
    if (!messageId) return null;
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT message_id AS messageId, chat_jid AS chatJid, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_caption AS mediaCaption, timestamp
      FROM messages WHERE tenant_id = ? AND chat_jid = ? AND message_id = ?
    `).get(t, chatJid, messageId);
    if (row) return row;
    return this._db.prepare(`
      SELECT message_id AS messageId, chat_jid AS chatJid, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_caption AS mediaCaption, timestamp
      FROM messages WHERE tenant_id = ? AND message_id = ?
      LIMIT 1
    `).get(t, messageId);
  }

  getAllMessagesLight(chatJid = null, limit = 5000) {
    const t = getCurrentTenantId();
    const hasContent = `(
           (text IS NOT NULL AND trim(text) != '')
           OR (media_caption IS NOT NULL AND trim(media_caption) != '')
           OR (media_ai_index IS NOT NULL AND trim(media_ai_index) != '')
           OR (media_type IS NOT NULL AND trim(media_type) != '')
         )`;
    const sql = chatJid
      ? `SELECT id, message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName, sender, text,
                media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
                media_ai_index AS mediaAiIndex, timestamp
         FROM messages
         WHERE tenant_id = ? AND chat_jid = ? AND ${hasContent}
         ORDER BY timestamp DESC LIMIT ?`
      : `SELECT id, message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName, sender, text,
                media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
                media_ai_index AS mediaAiIndex, timestamp
         FROM messages
         WHERE tenant_id = ? AND ${hasContent}
         ORDER BY timestamp DESC LIMIT ?`;
    return chatJid
      ? this._db.prepare(sql).all(t, chatJid, limit)
      : this._db.prepare(sql).all(t, limit);
  }

  /**
   * Group messages with media, detected links, and documents for the chat attachments UI.
   */
  getChatAttachmentsGrouped(chatJid, rowLimit = 1200) {
    const safe = Math.max(50, Math.min(Number(rowLimit) || 1200, 5000));
    const t = getCurrentTenantId();
    const rows = this._db.prepare(`
      SELECT message_id AS messageId, sender, text, media_type AS mediaType, media_path AS mediaPath,
             media_caption AS mediaCaption, timestamp
      FROM messages
      WHERE tenant_id = ? AND chat_jid = ?
      ORDER BY timestamp DESC
        LIMIT ?
    `).all(t, chatJid, safe);

    const urlRe = /https?:\/\/[^\s<>"')\]}]+/gi;
    const mediaKinds = new Set(['image', 'video', 'sticker', 'audio']);
    const media = [];
    const docs = [];
    const links = [];
    const seenLink = new Set();

    for (const r of rows) {
      const mt = r.mediaType || '';
      const hasFile = !!(r.mediaPath && String(r.mediaPath).trim());
      if (mediaKinds.has(mt) && hasFile) media.push(r);
      else if (mt === 'document' && hasFile) docs.push(r);

      const hay = `${r.text || ''}\n${r.mediaCaption || ''}`;
      let m;
      const re = new RegExp(urlRe.source, 'gi');
      while ((m = re.exec(hay))) {
        let u = m[0].replace(/[.,;:!?)]+$/, '');
        u = u.replace(/\]+$/g, '');
        if (u.length < 8 || seenLink.has(u)) continue;
        seenLink.add(u);
        links.push({
          messageId: r.messageId,
          sender: r.sender,
          url: u,
          timestamp: r.timestamp,
          snippet: (r.text || r.mediaCaption || '').slice(0, 160),
        });
      }
    }

    return { media, docs, links };
  }

  clearAllSummaries() {
    const t = getCurrentTenantId();
    const count = this._db.prepare('SELECT COUNT(*) AS c FROM daily_summaries WHERE tenant_id = ?').get(t)?.c || 0;
    this._db.prepare('DELETE FROM daily_summaries WHERE tenant_id = ?').run(t);
    try {
      this._db.exec("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')");
    } catch (err) {
      console.error('[DB] FTS rebuild after summary clear failed:', err.message);
    }
    return count;
  }

  // ── Thread Summaries ──────────────────────────────────────────────────

  upsertThreadSummary({ chatJid, chatName = null, threadStart, threadEnd, summary, messageCount = 0 }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO thread_summaries (tenant_id, chat_jid, chat_name, thread_start, thread_end, summary, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, chat_jid, thread_start) DO UPDATE SET
        summary = excluded.summary,
        thread_end = excluded.thread_end,
        message_count = excluded.message_count,
        chat_name = excluded.chat_name
    `).run(t, chatJid, chatName, threadStart, threadEnd, summary, messageCount);
  }

  getAllThreadSummaries() {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries WHERE tenant_id = ? ORDER BY thread_start ASC
    `).all(t);
  }

  countThreadSummaries() {
    const t = getCurrentTenantId();
    return this._db.prepare('SELECT COUNT(*) AS c FROM thread_summaries WHERE tenant_id = ?').get(t)?.c || 0;
  }

  /** One thread row by natural key (for merging fact hits into the candidate pool). */
  getThreadSummary(chatJid, threadStart) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries
      WHERE tenant_id = ? AND chat_jid = ? AND thread_start = ?
    `).get(t, chatJid, threadStart);
  }

  /** Thread whose time range covers a message timestamp (for lexical message → thread expansion). */
  getThreadSummaryCoveringTimestamp(chatJid, timestamp) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries
      WHERE tenant_id = ? AND chat_jid = ? AND ? >= thread_start AND ? <= thread_end
      LIMIT 1
    `).get(t, chatJid, timestamp, timestamp);
  }

  getSummarizedThreadStarts(chatJid) {
    const t = getCurrentTenantId();
    const rows = this._db.prepare(
      'SELECT thread_start FROM thread_summaries WHERE tenant_id = ? AND chat_jid = ?',
    ).all(t, chatJid);
    return new Set(rows.map(r => r.thread_start));
  }

  getMessagesByTimeRange(chatJid, startTs, endTs) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex, timestamp
      FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(t, chatJid, startTs, endTs);
  }

  getAllMessagesForChat(chatJid) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, text,
             media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex, timestamp
      FROM messages WHERE tenant_id = ? AND chat_jid = ? ORDER BY timestamp ASC
    `).all(t, chatJid);
  }

  getMessageTimestampsForChat(chatJid) {
    const t = getCurrentTenantId();
    return this._db.prepare(
      'SELECT timestamp FROM messages WHERE tenant_id = ? AND chat_jid = ? ORDER BY timestamp ASC',
    ).all(t, chatJid);
  }

  /** Replace all facts for one thread (after re-extraction). */
  replaceThreadFacts({ chatJid, chatName = null, threadStart, threadEnd, facts }) {
    const t = getCurrentTenantId();
    this._db.prepare('DELETE FROM thread_facts WHERE tenant_id = ? AND chat_jid = ? AND thread_start = ?').run(t, chatJid, threadStart);
    if (!facts?.length) return 0;
    const ins = this._db.prepare(`
      INSERT INTO thread_facts (tenant_id, chat_jid, chat_name, thread_start, thread_end, fact_type, payload_json, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let n = 0;
    for (const f of facts) {
      const factType = String(f.type || 'other').slice(0, 64);
      const payload = JSON.stringify(f);
      const st = f.search_text ? String(f.search_text) : buildSearchText(f);
      ins.run(t, chatJid, chatName, threadStart, threadEnd, factType, payload, st);
      n++;
    }
    return n;
  }

  searchFacts(query, chatJid = null, limit = 15) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 15, 100));
    const cleaned = this._toFtsQuery(query);
    if (!cleaned) return [];
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT tf.id, tf.chat_jid AS chatJid, tf.chat_name AS chatName,
             tf.thread_start AS threadStart, tf.thread_end AS threadEnd,
             tf.fact_type AS factType, tf.payload_json AS payloadJson,
             bm25(thread_facts_fts) AS rank
      FROM thread_facts_fts
      INNER JOIN thread_facts tf ON tf.id = thread_facts_fts.rowid
      WHERE tf.tenant_id = ?
        AND thread_facts_fts MATCH ?
        AND (? IS NULL OR tf.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(t, cleaned, chatJid, chatJid, safeLimit);
  }

  clearAllThreadFacts() {
    const t = getCurrentTenantId();
    const c = this._db.prepare('SELECT COUNT(*) AS n FROM thread_facts WHERE tenant_id = ?').get(t)?.n || 0;
    this._db.prepare('DELETE FROM thread_facts WHERE tenant_id = ?').run(t);
    try {
      this._db.exec("INSERT INTO thread_facts_fts(thread_facts_fts) VALUES('rebuild')");
    } catch (err) {
      console.error('[DB] thread_facts FTS rebuild failed:', err.message);
    }
    return c;
  }

  searchThreadSummaries(query, chatJid = null, limit = 10) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
    const cleaned = this._toFtsQuery(query);
    if (!cleaned) return [];
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT ts.id, ts.chat_jid AS chatJid, ts.chat_name AS chatName,
             ts.thread_start AS threadStart, ts.thread_end AS threadEnd,
             ts.summary, ts.message_count AS messageCount,
             bm25(thread_summaries_fts) AS rank
      FROM thread_summaries_fts
      INNER JOIN thread_summaries ts ON ts.id = thread_summaries_fts.rowid
      WHERE ts.tenant_id = ?
        AND thread_summaries_fts MATCH ?
        AND (? IS NULL OR ts.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(t, cleaned, chatJid, chatJid, safeLimit);
  }

  clearAllThreadSummaries() {
    const t = getCurrentTenantId();
    const count = this._db.prepare('SELECT COUNT(*) AS c FROM thread_summaries WHERE tenant_id = ?').get(t)?.c || 0;
    this._db.prepare('DELETE FROM thread_summaries WHERE tenant_id = ?').run(t);
    try {
      this._db.exec("INSERT INTO thread_summaries_fts(thread_summaries_fts) VALUES('rebuild')");
    } catch (err) {
      console.error('[DB] FTS rebuild after thread summary clear failed:', err.message);
    }
    this.clearAllThreadFacts();
    return count;
  }

  deleteChat(chatJid) {
    const t = getCurrentTenantId();
    const msgCount = this._db.prepare('SELECT COUNT(*) AS c FROM messages WHERE tenant_id = ? AND chat_jid = ?').get(t, chatJid)?.c || 0;
    this._db.prepare('DELETE FROM messages WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    this._db.prepare('DELETE FROM daily_summaries WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    this._db.prepare('DELETE FROM thread_summaries WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    this._db.prepare('DELETE FROM thread_facts WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    try {
      this._db.prepare('DELETE FROM chat_action_items WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    } catch { /* table may be missing on very old DBs */ }
    try {
      this._db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      this._db.exec("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')");
      this._db.exec("INSERT INTO thread_summaries_fts(thread_summaries_fts) VALUES('rebuild')");
      this._db.exec("INSERT INTO thread_facts_fts(thread_facts_fts) VALUES('rebuild')");
    } catch (err) {
      console.error('[DB] FTS rebuild after delete failed:', err.message);
    }
    return msgCount;
  }

  /** Raw better-sqlite3 handle (e.g. auth routes for `tenants` table). */
  getSqliteDatabase() {
    return this._db;
  }

  close() {
    this._db.close();
  }
}
