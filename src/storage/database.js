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
import { isSafeAvatarFileName } from '../whatsapp/chat-avatars.js';
import { chatListPreview, higherReceipt, normalizeReceiptStatus } from '../whatsapp/message-receipt.js';
import { STATUS_BROADCAST_JID, isImportedChatJid, sidebarTabForJid } from '../whatsapp/jid-filters.js';
import { isContentPlaceholder, legacyControlFramePlaceholders } from '../whatsapp/message-content.js';
import {
  formatPhoneLocalPart,
  isPlausibleHumanChatTitle,
  looksLikeLidFallbackContactLabel,
  prettyImportedChatTitle,
} from '../whatsapp/chat-display-name.js';
import { MAX_MESSAGES_PAGE } from '../constants/api-limits.js';
import { isChatEligibleForIndex } from '../search/index-eligibility.js';
import { reactionParticipantSlotKey } from '../whatsapp/reaction-counts.js';
import { normalizeUnixSeconds } from '../utils/timestamp.js';

const require = createRequire(import.meta.url);
const SQLite = require('better-sqlite3');

/** True if `name` is a better sidebar title than the bare JID local part (avoids last-outgoing-msg wiping the label). */
function looksLikeContactDisplayName(name, chatJid) {
  if (!isPlausibleHumanChatTitle(name, chatJid)) return false;
  if (looksLikePhoneOnly(name)) return false;
  return true;
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
    this._purgeControlFrameMessages();
    this._migrateChatActionItemsTable();
    this._migrateOllamaCloudModelSettings();
    this._ensureMessageEmbeddingsTable();
    this._ensureThreadFactsStatusColumn();
    this._ensureExpenseReconciliationTables();
    this._ensureSearchConversationTables();
    this._ensureSkillTables();
    this._ensureMessagesFtsUpdateTriggerScoped();
  }

  /**
   * Reindex a message in FTS only when an indexed column changes. Receipt, media-path and
   * index-status updates otherwise delete + reinsert the FTS row on every write.
   *
   * External-content FTS5 needs the *old column values* on 'delete' to remove their tokens;
   * the earlier triggers passed only the rowid, leaving stale tokens behind. Rebuild once so
   * the index matches `messages` before the corrected triggers take over.
   * Runs last because earlier migrations (re)create the unscoped trigger.
   */
  _ensureMessagesFtsUpdateTriggerScoped() {
    const row = this._db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_au'",
    ).get();
    if (!row?.sql || /AFTER\s+UPDATE\s+OF/i.test(row.sql)) return;
    const migrate = this._db.transaction(() => {
      this._db.exec(`
        DROP TRIGGER IF EXISTS messages_au;
        DROP TRIGGER IF EXISTS messages_ad;
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_name, media_caption, media_ai_index)
          VALUES ('delete', old.id, old.text, old.sender, old.chat_name, old.media_caption, old.media_ai_index);
        END;
        CREATE TRIGGER messages_au
        AFTER UPDATE OF text, sender, chat_name, media_caption, media_ai_index ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_name, media_caption, media_ai_index)
          VALUES ('delete', old.id, old.text, old.sender, old.chat_name, old.media_caption, old.media_ai_index);
          INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
          VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
        END;
      `);
      this._db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    });
    migrate();
    console.log('[DB] messages_fts triggers scoped to indexed columns; index rebuilt');
  }

  _ensureMessageEmbeddingsTable() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_rowid INTEGER PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        source_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_message_embeddings_tenant_model
        ON message_embeddings(tenant_id, model);
    `);
  }

  _ensureThreadFactsStatusColumn() {
    const cols = this._db.prepare(`PRAGMA table_info(thread_summaries)`).all();
    if (!cols.some((c) => c.name === 'facts_status')) {
      this._db.exec(`ALTER TABLE thread_summaries ADD COLUMN facts_status TEXT`);
    }
  }

  _ensureExpenseReconciliationTables() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS expense_reconciliation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        chat_name TEXT,
        source_message_id TEXT NOT NULL,
        source_file_name TEXT,
        source_media_path TEXT,
        business_date TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        report_path TEXT,
        report_message_id TEXT,
        totals_json TEXT,
        error TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(tenant_id, source_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_expense_runs_tenant_created
        ON expense_reconciliation_runs(tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_expense_runs_tenant_chat
        ON expense_reconciliation_runs(tenant_id, chat_jid, created_at DESC);

      CREATE TABLE IF NOT EXISTS expense_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_message_id TEXT,
        sheet_row INTEGER,
        date TEXT,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        direction TEXT NOT NULL,
        payee TEXT,
        category TEXT,
        description TEXT,
        reference TEXT,
        raw_json TEXT,
        FOREIGN KEY(run_id) REFERENCES expense_reconciliation_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_expense_entries_tenant_run
        ON expense_entries(tenant_id, run_id);

      CREATE TABLE IF NOT EXISTS expense_discrepancies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        chat_entry_id INTEGER,
        sheet_entry_id INTEGER,
        detail TEXT,
        resolution TEXT,
        resolved_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY(run_id) REFERENCES expense_reconciliation_runs(id) ON DELETE CASCADE,
        FOREIGN KEY(chat_entry_id) REFERENCES expense_entries(id) ON DELETE SET NULL,
        FOREIGN KEY(sheet_entry_id) REFERENCES expense_entries(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_expense_discrepancies_tenant_run
        ON expense_discrepancies(tenant_id, run_id);
    `);
  }

  _ensureSearchConversationTables() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS search_conversations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT,
        chat_jid TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_search_conversations_tenant_updated
        ON search_conversations(tenant_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS search_messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY(conversation_id) REFERENCES search_conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_search_messages_conversation
        ON search_messages(tenant_id, conversation_id, created_at ASC);
    `);
    const cols = this._db.prepare('PRAGMA table_info(search_conversations)').all();
    const add = (name, type) => {
      if (!cols.some((c) => c.name === name)) {
        this._db.exec(`ALTER TABLE search_conversations ADD COLUMN ${name} ${type}`);
      }
    };
    add('memory', 'TEXT');
    add('memory_upto', 'INTEGER DEFAULT 0');
    add('pins_json', 'TEXT');
    add('model_json', 'TEXT');
  }

  getConversationModel(id) {
    const t = getCurrentTenantId();
    const row = this._db.prepare(
      'SELECT model_json AS modelJson FROM search_conversations WHERE tenant_id = ? AND id = ?',
    ).get(t, id);
    try { return row?.modelJson ? JSON.parse(row.modelJson) : null; } catch { return null; }
  }

  setConversationModel(id, selection) {
    const t = getCurrentTenantId();
    this._db.prepare('UPDATE search_conversations SET model_json = ? WHERE tenant_id = ? AND id = ?')
      .run(selection ? JSON.stringify(selection) : null, t, id);
  }

  getConversationMemory(id) {
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT memory, memory_upto AS memoryUpto, pins_json AS pinsJson
      FROM search_conversations WHERE tenant_id = ? AND id = ?
    `).get(t, id);
    if (!row) return null;
    let pins = [];
    try { pins = row.pinsJson ? JSON.parse(row.pinsJson) : []; } catch { pins = []; }
    return { memory: row.memory || '', memoryUpto: row.memoryUpto || 0, pins };
  }

  setConversationMemory(id, { memory, memoryUpto }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      UPDATE search_conversations SET memory = ?, memory_upto = ?
      WHERE tenant_id = ? AND id = ?
    `).run(String(memory || ''), Number(memoryUpto) || 0, t, id);
  }

  setConversationPins(id, pins) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      UPDATE search_conversations SET pins_json = ?
      WHERE tenant_id = ? AND id = ?
    `).run(JSON.stringify(Array.isArray(pins) ? pins : []), t, id);
  }

  /** Cross-chat window for "what happened between X and Y" without loading whole chats. */
  getMessagesInRange({ chatJid = null, startTs, endTs, limit = 200, newestFirst = false }) {
    const t = getCurrentTenantId();
    const safe = Math.max(1, Math.min(Number(limit) || 200, MAX_MESSAGES_PAGE));
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, text, media_type AS mediaType,
             media_path AS mediaPath, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex, timestamp
      FROM messages
      WHERE tenant_id = ? AND (? IS NULL OR chat_jid = ?)
        AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ${newestFirst ? 'DESC' : 'ASC'}, id ${newestFirst ? 'DESC' : 'ASC'}
      LIMIT ?
    `).all(t, chatJid, chatJid, Number(startTs) || 0, Number(endTs) || 4102444800, safe);
  }

  /** A few messages on either side of `messageRowid` in the same chat (uses the chat+timestamp index). */
  getChatNeighbors(chatJid, timestamp, messageRowid, radius = 2) {
    const t = getCurrentTenantId();
    const n = Math.max(0, Math.min(Number(radius) || 0, 20));
    if (!n) return [];
    const cols = `id, message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName, sender, text,
      media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
      media_ai_index AS mediaAiIndex, timestamp`;
    const before = this._db.prepare(`
      SELECT ${cols} FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND (timestamp < ? OR (timestamp = ? AND id < ?))
      ORDER BY timestamp DESC, id DESC LIMIT ?
    `).all(t, chatJid, timestamp, timestamp, messageRowid, n);
    const after = this._db.prepare(`
      SELECT ${cols} FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
      ORDER BY timestamp ASC, id ASC LIMIT ?
    `).all(t, chatJid, timestamp, timestamp, messageRowid, n);
    return [...before.reverse(), ...after];
  }

  /** FTS hits limited to a time window (date filter applied inside SQLite, not after). */
  searchMessagesInRange(query, { chatJid = null, startTs = 0, endTs = 4102444800, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 500));
    const cleaned = this._toFtsQuery(query);
    if (!cleaned) return [];
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT m.id, m.message_id AS messageId, m.chat_jid AS chatJid,
             m.chat_name AS chatName, m.sender, m.text,
             m.media_type AS mediaType, m.media_path AS mediaPath, m.media_caption AS mediaCaption,
             m.media_ai_index AS mediaAiIndex, m.timestamp, bm25(messages_fts) AS rank
      FROM messages_fts
      INNER JOIN messages m ON m.id = messages_fts.rowid
      WHERE m.tenant_id = ?
        AND messages_fts MATCH ?
        AND (? IS NULL OR m.chat_jid = ?)
        AND m.timestamp >= ? AND m.timestamp <= ?
      ORDER BY rank LIMIT ?
    `).all(t, cleaned, chatJid, chatJid, Number(startTs) || 0, Number(endTs) || 4102444800, safeLimit);
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
        media_index_status TEXT DEFAULT NULL,
        media_index_error TEXT DEFAULT NULL,
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
        INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_name, media_caption, media_ai_index) VALUES('delete', old.id, old.text, old.sender, old.chat_name, old.media_caption, old.media_ai_index);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text, sender, chat_name, media_caption, media_ai_index ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_name, media_caption, media_ai_index) VALUES('delete', old.id, old.text, old.sender, old.chat_name, old.media_caption, old.media_ai_index);
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
    this._migrateReceiptStatusColumn();
    this._migrateChatImportTouches();
    this._migrateChatRoster();
    this._migrateIndexOptIn();
    this._migrateChatUnread();
    this._migrateChatCatchup();
    this._migrateChatAvatars();
    this._rebuildFtsIfEmpty();
  }

  /**
   * Earlier builds stored WhatsApp's protocol frames as ordinary messages, leaving rows whose
   * only body was a placeholder like `[protocol]`. Ingestion now drops them, so clear out the
   * ones already synced. Media rows are spared — a placeholder there is a real attachment.
   */
  _purgeControlFrameMessages() {
    try {
      if (this.getState('control_frame_messages_purged')) return;
      const placeholders = legacyControlFramePlaceholders();
      const slots = placeholders.map(() => '?').join(',');
      const n = this._db.prepare(`
        DELETE FROM messages
        WHERE media_type IS NULL AND text IN (${slots})
      `).run(...placeholders).changes;
      this.setState('control_frame_messages_purged', '1');
      if (n > 0) console.log(`[DB] Removed ${n} WhatsApp control-frame message row(s)`);
    } catch (e) {
      console.warn('[DB] control-frame purge:', e.message);
    }
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

  /**
   * Chats WhatsApp reports we are in, including ones with nothing ingested yet.
   *
   * `getChatStats()` is derived from the messages table, so a joined group cannot reach
   * the sidebar until something has been stored for it. Keeping the roster separately
   * lets the chat list show a real title while history is still streaming.
   */
  _migrateChatRoster() {
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS chat_roster (
          tenant_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          chat_name TEXT,
          last_message_ts INTEGER,
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (tenant_id, chat_jid)
        );
      `);
    } catch (e) {
      console.warn('[DB] chat_roster:', e.message);
    }
  }

  /**
   * Chats the user asked to index even though they fail the auto-index size/recency gate.
   * Survives restarts so a one-off request is not lost when the process recycles.
   */
  _migrateIndexOptIn() {
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS index_opt_in (
          tenant_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          opted_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (tenant_id, chat_jid)
        );
      `);
    } catch (e) {
      console.warn('[DB] index_opt_in:', e.message);
    }
  }

  /**
   * Last WhatsApp-reported unread counts. In-memory maps are lost on restart; this
   * keeps group catch-up working until the user opens the chat (mark seen clears it).
   */
  _migrateChatUnread() {
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS chat_unread (
          tenant_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          unread_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (tenant_id, chat_jid)
        );
      `);
    } catch (e) {
      console.warn('[DB] chat_unread:', e.message);
    }
  }

  /**
   * Catch-up dismiss cursor. Unlike last_seen (advanced on every open), this only
   * moves when the user closes the "while you were away" card — so reopening a busy
   * chat still shows the summary until they dismiss it.
   */
  /**
   * Local profile / group pictures. `missing` remembers a chat with no photo so a
   * reconnect does not query WhatsApp again. `rel_path` is a file name, never a directory.
   */
  _migrateChatAvatars() {
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS chat_avatars (
          tenant_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          rel_path TEXT,
          missing INTEGER NOT NULL DEFAULT 0,
          fetched_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (tenant_id, chat_jid)
        );
      `);
    } catch (e) {
      console.warn('[DB] chat_avatars:', e.message);
    }
  }

  _migrateChatCatchup() {
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS chat_catchup (
          tenant_id TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          dismissed_until_ts INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (tenant_id, chat_jid)
        );
      `);
    } catch (e) {
      console.warn('[DB] chat_catchup:', e.message);
    }
  }

  optInChatForIndex(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return false;
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO index_opt_in (tenant_id, chat_jid) VALUES (?, ?)
      ON CONFLICT(tenant_id, chat_jid) DO UPDATE SET opted_at = unixepoch()
    `).run(t, jid);
    return true;
  }

  optOutChatForIndex(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return false;
    const t = getCurrentTenantId();
    this._db.prepare(
      'DELETE FROM index_opt_in WHERE tenant_id = ? AND chat_jid = ?',
    ).run(t, jid);
    return true;
  }

  /** @returns {boolean} whether the chat is now opted in */
  setChatIndexEnabled(chatJid, enabled) {
    return enabled ? this.optInChatForIndex(chatJid) : this.optOutChatForIndex(chatJid);
  }

  listIndexOptInJids() {
    const t = getCurrentTenantId();
    return this._db.prepare(
      'SELECT chat_jid AS chatJid FROM index_opt_in WHERE tenant_id = ?',
    ).all(t).map((r) => r.chatJid);
  }

  /**
   * Restrict pending AI jobs to chats the user toggled on (plus legacy auto-index when enabled).
   * `activityAlias` must expose `msg_count` and `chat_last_ts` when auto-index is on.
   * @returns {{ sql: string, args: Array<number|string> }}
   */
  _indexEligibilitySql(chatJidExpr, activityAlias = 'a') {
    const t = getCurrentTenantId();
    const optedIn = `EXISTS (
      SELECT 1 FROM index_opt_in o
      WHERE o.tenant_id = ? AND o.chat_jid = ${chatJidExpr}
    )`;
    if (!config.indexAutoEnabled) {
      return { sql: `(${optedIn})`, args: [t] };
    }
    const min = Number(config.indexMinMessageCount) || 0;
    const cutoff = Math.floor(Date.now() / 1000)
      - ((Number(config.indexRecentWindowDays) || 0) * 24 * 60 * 60);
    const sql = `(
      (
        ${activityAlias}.msg_count > ?
        AND ${activityAlias}.chat_last_ts >= ?
        AND ${chatJidExpr} NOT LIKE '%@broadcast'
        AND ${chatJidExpr} NOT LIKE '%@newsletter'
        AND ${chatJidExpr} NOT LIKE '%@bot'
      )
      OR ${optedIn}
    )`;
    return { sql, args: [min, cutoff, t] };
  }

  /**
   * Record known chats. A name is only stored when it beats what we already have, so a
   * later roster pass that has not resolved a title cannot erase a good one.
   *
   * @param {Array<{ chatJid: string, chatName?: string|null, lastMessageTs?: number|null }>} entries
   * @returns {number} rows written
   */
  upsertChatRoster(entries) {
    if (!Array.isArray(entries) || !entries.length) return 0;
    const t = getCurrentTenantId();
    const stmt = this._db.prepare(`
      INSERT INTO chat_roster (tenant_id, chat_jid, chat_name, last_message_ts)
      VALUES (@tenantId, @chatJid, @chatName, @lastMessageTs)
      ON CONFLICT(tenant_id, chat_jid) DO UPDATE SET
        chat_name = COALESCE(excluded.chat_name, chat_roster.chat_name),
        last_message_ts = MAX(
          COALESCE(excluded.last_message_ts, 0),
          COALESCE(chat_roster.last_message_ts, 0)
        ),
        updated_at = unixepoch()
    `);
    let written = 0;
    const txn = this._db.transaction((rows) => {
      for (const r of rows) {
        const chatJid = r?.chatJid;
        if (!chatJid) continue;
        const name = looksLikeContactDisplayName(r.chatName, chatJid) ? String(r.chatName).trim() : null;
        stmt.run({
          tenantId: t,
          chatJid,
          chatName: name,
          lastMessageTs: Number(r.lastMessageTs) || null,
        });
        written += 1;
      }
    });
    txn(entries);
    return written;
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

  _migrateReceiptStatusColumn() {
    try {
      const cols = this._db.prepare('PRAGMA table_info(messages)').all();
      if (!cols.some((c) => c.name === 'receipt_status')) {
        this._db.exec('ALTER TABLE messages ADD COLUMN receipt_status INTEGER');
      }
    } catch (e) {
      console.warn('[DB] receipt_status:', e.message);
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
      if (!cols.some((c) => c.name === 'media_index_status')) {
        this._db.exec('ALTER TABLE messages ADD COLUMN media_index_status TEXT DEFAULT NULL');
        console.log('[DB] Added messages.media_index_status');
      }
      if (!cols.some((c) => c.name === 'media_index_error')) {
        this._db.exec('ALTER TABLE messages ADD COLUMN media_index_error TEXT DEFAULT NULL');
        console.log('[DB] Added messages.media_index_error');
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
        INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_name, media_caption, media_ai_index) VALUES('delete', old.id, old.text, old.sender, old.chat_name, old.media_caption, old.media_ai_index);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE OF text, sender, chat_name, media_caption, media_ai_index ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_name, media_caption, media_ai_index) VALUES('delete', old.id, old.text, old.sender, old.chat_name, old.media_caption, old.media_ai_index);
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
        text, media_type, media_path, media_caption, media_ai_index, timestamp, reactions_json, contact_payload,
        receipt_status
      ) VALUES (
        @tenantId, @messageId, @chatJid, @chatName, @sender, @senderJid,
        @text, @mediaType, @mediaPath, @mediaCaption, @mediaAiIndex, @timestamp, @reactionsJson, @contactPayload,
        @receiptStatus
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
    this.clearChatUnread(chatJid);
    return when;
  }

  setChatUnread(chatJid, unreadCount) {
    const jid = String(chatJid || '').trim();
    if (!jid) return;
    const n = Math.max(0, Math.floor(Number(unreadCount) || 0));
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO chat_unread (tenant_id, chat_jid, unread_count, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(tenant_id, chat_jid) DO UPDATE SET
        unread_count = excluded.unread_count,
        updated_at = excluded.updated_at
    `).run(t, jid, n);
  }

  getChatUnread(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return 0;
    const t = getCurrentTenantId();
    const row = this._db.prepare(
      'SELECT unread_count AS unreadCount FROM chat_unread WHERE tenant_id = ? AND chat_jid = ?',
    ).get(t, jid);
    return Math.max(0, Number(row?.unreadCount) || 0);
  }

  /** Map of chatJid → unreadCount for sidebar overlay. */
  getAllChatUnread() {
    const t = getCurrentTenantId();
    const rows = this._db.prepare(
      'SELECT chat_jid AS chatJid, unread_count AS unreadCount FROM chat_unread WHERE tenant_id = ? AND unread_count > 0',
    ).all(t);
    const map = new Map();
    for (const r of rows || []) {
      if (r?.chatJid) map.set(r.chatJid, Math.max(0, Number(r.unreadCount) || 0));
    }
    return map;
  }

  clearChatUnread(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return;
    const t = getCurrentTenantId();
    this._db.prepare('DELETE FROM chat_unread WHERE tenant_id = ? AND chat_jid = ?').run(t, jid);
  }

  getCatchupDismissedUntil(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return null;
    const t = getCurrentTenantId();
    const row = this._db.prepare(
      'SELECT dismissed_until_ts AS dismissedUntilTs FROM chat_catchup WHERE tenant_id = ? AND chat_jid = ?',
    ).get(t, jid);
    if (!row) return null;
    return Math.max(0, Number(row.dismissedUntilTs) || 0);
  }

  /** Mark catch-up as handled up through `ts` (unix seconds). */
  setCatchupDismissedUntil(chatJid, ts = null) {
    const jid = String(chatJid || '').trim();
    if (!jid) return 0;
    const t = getCurrentTenantId();
    const when = ts != null ? Number(ts) : Math.floor(Date.now() / 1000);
    this._db.prepare(`
      INSERT INTO chat_catchup (tenant_id, chat_jid, dismissed_until_ts, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(tenant_id, chat_jid) DO UPDATE SET
        dismissed_until_ts = excluded.dismissed_until_ts,
        updated_at = excluded.updated_at
    `).run(t, jid, when);
    return when;
  }

  /**
   * Window start for catch-up: last dismiss cursor, or (if never dismissed) roughly
   * the last week of traffic so we don't dump the entire archive on first open.
   */
  getCatchupWindowStart(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return 0;
    const dismissed = this.getCatchupDismissedUntil(jid);
    if (dismissed != null) return dismissed;
    const t = getCurrentTenantId();
    const maxTs = this._db.prepare(
      'SELECT MAX(timestamp) AS maxTs FROM messages WHERE tenant_id = ? AND chat_jid = ?',
    ).get(t, jid)?.maxTs || 0;
    if (!maxTs) return 0;
    const weekAgo = Math.max(0, Number(maxTs) - 7 * 86400);
    return weekAgo;
  }

  getChatLastSeen(chatJid) {
    if (!chatJid) return 0;
    const t = getCurrentTenantId();
    return this._stmtGetChatLastSeen.get(t, chatJid)?.lastSeenTs || 0;
  }

  countIncomingMessagesSince(chatJid, sinceTs = 0) {
    if (!chatJid) return 0;
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE tenant_id = ? AND chat_jid = ? AND timestamp > ?
        AND (sender IS NULL OR sender != 'You')
    `).get(t, chatJid, Number(sinceTs) || 0)?.count || 0;
  }

  /** Timestamp immediately before the newest `unreadCount` incoming messages. */
  getUnreadWindowStart(chatJid, unreadCount) {
    if (!chatJid || !Number.isFinite(Number(unreadCount)) || Number(unreadCount) <= 0) return 0;
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT MIN(timestamp) AS earliest
      FROM (
        SELECT timestamp
        FROM messages
        WHERE tenant_id = ? AND chat_jid = ?
          AND (sender IS NULL OR sender != 'You')
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      )
    `).get(t, chatJid, Math.floor(Number(unreadCount)));
    return row?.earliest ? Math.max(0, Number(row.earliest) - 1) : 0;
  }

  getAwayThreadSummaries(chatJid, limit = 3, sinceTs = null) {
    const t = getCurrentTenantId();
    const lastSeen = sinceTs == null ? this.getChatLastSeen(chatJid) : Math.max(0, Number(sinceTs) || 0);
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
    reactionsJson = null, contactPayload = null, receiptStatus = null,
  }) {
    const tenantId = getCurrentTenantId();
    const info = this._stmtInsertMessage.run({
      tenantId,
      messageId, chatJid, chatName, sender, senderJid,
      text, mediaType, mediaPath, mediaCaption, mediaAiIndex,
      timestamp: normalizeUnixSeconds(timestamp, Math.floor(Date.now() / 1000)),
      reactionsJson,
      contactPayload,
      receiptStatus: normalizeReceiptStatus(receiptStatus),
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
          timestamp: normalizeUnixSeconds(row.timestamp, Math.floor(Date.now() / 1000)),
          reactionsJson: row.reactionsJson ?? null,
          contactPayload: row.contactPayload ?? null,
          receiptStatus: normalizeReceiptStatus(row.receiptStatus),
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
        if (info.changes === 0 && row.messageId && row.receiptStatus != null) {
          this.updateMessageReceipt(row.chatJid, row.messageId, row.receiptStatus);
        }
        // History re-sync often re-delivers the same ids; upgrade synthetic bodies like `[Template]`.
        if (info.changes === 0 && row.messageId && row.text) {
          this._upgradePlaceholderMessageBody(tenantId, row);
        }
      }
    });
    run(rows || []);
    const newest = new Map();
    for (const row of rows || []) {
      if (!row?.chatJid) continue;
      const ts = normalizeUnixSeconds(row.timestamp, 0);
      if (ts > (newest.get(row.chatJid) || 0)) newest.set(row.chatJid, ts);
    }
    if (newest.size) {
      this.upsertChatRoster([...newest].map(([chatJid, lastMessageTs]) => ({ chatJid, lastMessageTs })));
    }
    return { count: insertedMessageIds.length, insertedMessageIds };
  }

  /**
   * Raise the delivery tick on a message you sent. Incoming rows are ignored.
   * @returns {{ chatJid: string, messageId: string, receiptStatus: number, isLatest: boolean } | { unchanged: true } | null}
   */
  updateMessageReceipt(chatJid, messageId, receiptStatus) {
    const incoming = normalizeReceiptStatus(receiptStatus);
    let jid = String(chatJid || '').trim();
    const mid = String(messageId || '').trim();
    if (!jid || !mid || incoming == null) return null;
    const t = getCurrentTenantId();
    let row = this._db.prepare(`
      SELECT sender, receipt_status AS receiptStatus, chat_jid AS chatJid
      FROM messages WHERE tenant_id = ? AND chat_jid = ? AND message_id = ?
    `).get(t, jid, mid);
    if (!row) {
      // Group/LID receipts sometimes name a paired JID. Only follow a unique row.
      const alts = this._db.prepare(`
        SELECT sender, receipt_status AS receiptStatus, chat_jid AS chatJid
        FROM messages WHERE tenant_id = ? AND message_id = ? AND sender = 'You'
      `).all(t, mid);
      if (alts.length !== 1) return null;
      row = alts[0];
      jid = row.chatJid;
    }
    if (row.sender !== 'You') return null;
    const merged = higherReceipt(row.receiptStatus, incoming);
    if (merged === normalizeReceiptStatus(row.receiptStatus)) {
      return { unchanged: true };
    }
    this._db.prepare(`
      UPDATE messages SET receipt_status = ?
      WHERE tenant_id = ? AND chat_jid = ? AND message_id = ?
    `).run(merged, t, jid, mid);
    const latest = this._db.prepare(`
      SELECT message_id AS messageId FROM messages
      WHERE tenant_id = ? AND chat_jid = ?
      ORDER BY timestamp DESC, id DESC LIMIT 1
    `).get(t, jid);
    return {
      chatJid: jid,
      messageId: mid,
      receiptStatus: merged,
      isLatest: latest?.messageId === mid,
    };
  }

  /**
   * When we learn a human-readable chat title (from WA), backfill all rows for that chat so the sidebar
   * and search stop showing bare phone / LID after older messages were stored with a numeric label.
   */
  propagateChatDisplayName(chatJid, chatName) {
    if (!chatJid || !chatName || !looksLikeContactDisplayName(chatName, chatJid)) return 0;
    const t = getCurrentTenantId();
    // Skip rows that already carry the name: each rewrite also reindexes the row in FTS.
    const r = this._db.prepare(
      'UPDATE messages SET chat_name = ? WHERE tenant_id = ? AND chat_jid = ? AND chat_name IS NOT ?',
    ).run(chatName, t, chatJid, chatName);
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

  /**
   * Rows with a media type but no file, excluding ids still queued for download.
   * Used when the user refreshes a chat so stuck "Loading…" badges become "unavailable".
   */
  markOrphanedPendingMediaUnavailable(chatJid, keepMessageIds = []) {
    const jid = String(chatJid || '').trim();
    if (!jid) return 0;
    const t = getCurrentTenantId();
    const keep = new Set([...(keepMessageIds || [])].map((id) => String(id)));
    const rows = this._db.prepare(`
      SELECT message_id AS messageId FROM messages
      WHERE tenant_id = ? AND chat_jid = ?
        AND media_type IS NOT NULL AND trim(media_type) != ''
        AND (media_path IS NULL OR trim(media_path) = '')
    `).all(t, jid);
    if (!rows.length) return 0;
    const upd = this._db.prepare(
      'UPDATE messages SET media_path = ? WHERE tenant_id = ? AND message_id = ?',
    );
    let n = 0;
    const txn = this._db.transaction(() => {
      for (const row of rows) {
        const id = String(row.messageId || '');
        if (!id || keep.has(id)) continue;
        upd.run('__unavailable__', t, id);
        n += 1;
      }
    });
    txn();
    return n;
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

  /**
   * Newest stored row — used to request on-demand history that can fill a gap
   * after the archive froze (WhatsApp PDO still keys off a known message id).
   */
  getNewestMessageAnchor(chatJid) {
    if (!chatJid) return null;
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT message_id AS messageId, timestamp,
             CASE WHEN sender = 'You' THEN 1 ELSE 0 END AS fromMe
      FROM messages WHERE tenant_id = ? AND chat_jid = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `).get(t, chatJid);
    return row || null;
  }

  /**
   * Live WhatsApp chats (not imports / status) whose newest stored message is older than `unixSec`.
   */
  countChatsWithNewestBefore(unixSec, { minMessages = 5 } = {}) {
    const t = getCurrentTenantId();
    const cutoff = Number(unixSec) || 0;
    const minN = Math.max(1, Math.floor(Number(minMessages) || 5));
    const row = this._db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT chat_jid
        FROM messages
        WHERE tenant_id = ?
          AND chat_jid NOT LIKE '%@broadcast'
          AND chat_jid NOT LIKE '%@imported'
        GROUP BY chat_jid
        HAVING COUNT(*) >= ? AND MAX(timestamp) < ?
      )
    `).get(t, minN, cutoff);
    return Number(row?.n) || 0;
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
    this._deleteEmbeddingByMessageId(messageId);
    return r.changes ?? 0;
  }

  updateMediaIndexResult(messageId, { text = '', status = 'indexed', error = null } = {}) {
    if (!messageId) return 0;
    const t = getCurrentTenantId();
    const changes = this._db.prepare(`
      UPDATE messages
      SET media_ai_index = ?, media_index_status = ?, media_index_error = ?
      WHERE tenant_id = ? AND message_id = ?
    `).run(text ?? '', status, error ? String(error).slice(0, 500) : null, t, messageId).changes ?? 0;
    this._deleteEmbeddingByMessageId(messageId);
    return changes;
  }

  _deleteEmbeddingByMessageId(messageId) {
    if (!messageId) return;
    const t = getCurrentTenantId();
    this._db.prepare(`
      DELETE FROM message_embeddings
      WHERE tenant_id = ?
        AND message_rowid IN (
          SELECT id FROM messages WHERE tenant_id = ? AND message_id = ?
        )
    `).run(t, t, messageId);
  }

  resetUnsupportedMediaIndexes() {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      UPDATE messages
      SET media_ai_index = NULL, media_index_status = NULL, media_index_error = NULL
      WHERE tenant_id = ? AND media_index_status = 'unsupported'
    `).run(t).changes ?? 0;
  }

  /**
   * Leading ORDER BY tier that puts chats the sidebar can currently show ahead of the rest.
   * Empty while WhatsApp is live, because then every chat is visible.
   * @param {boolean} waLive
   * @param {string} col qualified `chat_jid` column for the surrounding query
   */
  _visibilityOrderSql(waLive, col = 'chat_jid') {
    return waLive ? '' : `CASE WHEN ${col} LIKE '%@imported' THEN 0 ELSE 1 END, `;
  }

  /**
   * ORDER BY tier that pushes Status / broadcast / newsletter / bot feeds behind real
   * conversations. Must stay in sync with `isWhatsAppLowPriorityFeed()` in
   * src/whatsapp/jid-filters.js — `status@broadcast` is covered by the `%@broadcast` match.
   * @param {string} col qualified `chat_jid` column for the surrounding query
   */
  _feedOrderSql(col = 'chat_jid') {
    return `CASE WHEN ${col} LIKE '%@broadcast' OR ${col} LIKE '%@newsletter' OR ${col} LIKE '%@bot' THEN 1 ELSE 0 END, `;
  }

  /**
   * Rows with downloaded media that still need caption/transcribe (media_ai_index IS NULL).
   * When `priorityChatJid` is set, rows in that chat are ordered before others (same global newest-first within each tier).
   */
  getPendingMediaIndexJobs(limit = 12, priorityChatJid = null, opts = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 12, 40));
    const t = getCurrentTenantId();
    const normalizedOpts = typeof opts === 'boolean' ? { waLive: opts } : (opts || {});
    const {
      waLive = true,
      sourceScope = 'all',
      recentCutoffTs = 0,
    } = normalizedOpts;
    const prio = priorityChatJid && String(priorityChatJid).trim()
      ? String(priorityChatJid).trim()
      : null;
    const sourceFilter = sourceScope === 'live'
      ? `AND m.chat_jid NOT LIKE '%@imported'`
      : (sourceScope === 'imported' ? `AND m.chat_jid LIKE '%@imported'` : '');
    const vis = sourceScope === 'all' ? this._visibilityOrderSql(waLive, 'm.chat_jid') : '';
    const feed = this._feedOrderSql('m.chat_jid');
    const recentOrder = Number(recentCutoffTs) > 0
      ? 'CASE WHEN a.chat_last_ts >= ? THEN 0 ELSE 1 END, '
      : '';
    const orderArgs = Number(recentCutoffTs) > 0 ? [Number(recentCutoffTs)] : [];
    const gate = this._indexEligibilitySql('m.chat_jid');
    const select = `
      WITH chat_activity AS (
        SELECT chat_jid, MAX(timestamp) AS chat_last_ts, COUNT(*) AS msg_count
        FROM messages WHERE tenant_id = ? GROUP BY chat_jid
      )
      SELECT m.id, m.message_id AS messageId, m.chat_jid AS chatJid,
             m.media_type AS mediaType, m.media_path AS mediaPath,
             m.media_caption AS mediaCaption, m.text AS text,
             m.media_index_status AS mediaIndexStatus, m.media_index_error AS mediaIndexError
      FROM messages m
      INNER JOIN chat_activity a ON a.chat_jid = m.chat_jid
      WHERE m.tenant_id = ?
        ${sourceFilter}
        AND ${gate.sql}
        AND m.media_path IS NOT NULL AND trim(m.media_path) != ''
        AND m.media_type IN ('image', 'audio', 'video', 'sticker', 'document')
        AND (m.media_ai_index IS NULL OR m.media_index_status IN ('pending', 'failed'))
    `;
    if (prio) {
      return this._db.prepare(`
        ${select}
        ORDER BY CASE WHEN m.chat_jid = ? THEN 0 ELSE 1 END,
                 ${vis}${feed}${recentOrder}a.chat_last_ts DESC, m.timestamp DESC
        LIMIT ?
      `).all(t, t, ...gate.args, prio, ...orderArgs, n);
    }
    return this._db.prepare(`
      ${select}
      ORDER BY ${vis}${feed}${recentOrder}a.chat_last_ts DESC, m.timestamp DESC
      LIMIT ?
    `).all(t, t, ...gate.args, ...orderArgs, n);
  }

  getPendingEmbeddingJobs(limit = 12, priorityChatJid = null, modelId = '', opts = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 12, 40));
    const t = getCurrentTenantId();
    const model = String(modelId || '');
    const normalizedOpts = typeof opts === 'boolean' ? { waLive: opts } : (opts || {});
    const {
      waLive = true,
      sourceScope = 'all',
      recentCutoffTs = 0,
    } = normalizedOpts;
    const prio = priorityChatJid && String(priorityChatJid).trim()
      ? String(priorityChatJid).trim()
      : null;
    const sourceFilter = sourceScope === 'live'
      ? `AND m.chat_jid NOT LIKE '%@imported'`
      : (sourceScope === 'imported' ? `AND m.chat_jid LIKE '%@imported'` : '');
    const hasText = `(
           (text IS NOT NULL AND trim(text) != '')
           OR (media_caption IS NOT NULL AND trim(media_caption) != '')
           OR (media_ai_index IS NOT NULL AND trim(media_ai_index) != '')
         )`;
    const gate = this._indexEligibilitySql('m.chat_jid');
    const select = `
      WITH chat_activity AS (
        SELECT chat_jid, MAX(timestamp) AS chat_last_ts, COUNT(*) AS msg_count
        FROM messages WHERE tenant_id = ? GROUP BY chat_jid
      )
      SELECT m.id, m.message_id AS messageId, m.chat_jid AS chatJid, m.sender, m.text,
             m.media_caption AS mediaCaption, m.media_ai_index AS mediaAiIndex, m.timestamp
      FROM messages m
      INNER JOIN chat_activity a ON a.chat_jid = m.chat_jid
      LEFT JOIN message_embeddings e
        ON e.message_rowid = m.id AND e.model = ?
      WHERE m.tenant_id = ?
        ${sourceFilter}
        AND ${gate.sql}
        AND ${hasText}
        AND e.message_rowid IS NULL
    `;
    const vis = sourceScope === 'all' ? this._visibilityOrderSql(waLive, 'm.chat_jid') : '';
    const feed = this._feedOrderSql('m.chat_jid');
    const recentOrder = Number(recentCutoffTs) > 0
      ? 'CASE WHEN a.chat_last_ts >= ? THEN 0 ELSE 1 END, '
      : '';
    const orderArgs = Number(recentCutoffTs) > 0 ? [Number(recentCutoffTs)] : [];
    if (prio) {
      return this._db.prepare(`
        ${select}
        ORDER BY CASE WHEN m.chat_jid = ? THEN 0 ELSE 1 END,
                 ${vis}${feed}${recentOrder}a.chat_last_ts DESC, m.timestamp DESC
        LIMIT ?
      `).all(t, model, t, ...gate.args, prio, ...orderArgs, n);
    }
    return this._db.prepare(`
      ${select}
      ORDER BY ${vis}${feed}${recentOrder}a.chat_last_ts DESC, m.timestamp DESC
      LIMIT ?
    `).all(t, model, t, ...gate.args, ...orderArgs, n);
  }

  upsertMessageEmbedding({ messageRowid, model, dim, vector, sourceHash }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO message_embeddings (message_rowid, tenant_id, model, dim, vector, source_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_rowid) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        model = excluded.model,
        dim = excluded.dim,
        vector = excluded.vector,
        source_hash = excluded.source_hash,
        created_at = unixepoch()
    `).run(messageRowid, t, model, dim, vector, sourceHash);
  }

  iterateMessageEmbeddings(modelId, chatJid = null) {
    const t = getCurrentTenantId();
    const model = String(modelId || '');
    const sql = chatJid
      ? `SELECT e.message_rowid AS messageRowid, e.vector AS vector
         FROM message_embeddings e
         INNER JOIN messages m ON m.id = e.message_rowid
         WHERE e.tenant_id = ? AND e.model = ? AND e.dim > 0 AND m.chat_jid = ?`
      : `SELECT e.message_rowid AS messageRowid, e.vector AS vector
         FROM message_embeddings e
         WHERE e.tenant_id = ? AND e.model = ? AND e.dim > 0`;
    return chatJid
      ? this._db.prepare(sql).all(t, model, chatJid)
      : this._db.prepare(sql).all(t, model);
  }

  getMessagesByRowIds(ids) {
    const list = (ids || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (!list.length) return [];
    const t = getCurrentTenantId();
    const placeholders = list.map(() => '?').join(',');
    const rows = this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName, sender, text,
             media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex,
             media_index_status AS mediaIndexStatus, media_index_error AS mediaIndexError, timestamp
      FROM messages
      WHERE tenant_id = ? AND id IN (${placeholders})
    `).all(t, ...list);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return list.map((id) => byId.get(id)).filter(Boolean);
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
             m.media_ai_index AS mediaAiIndex,
             m.media_index_status AS mediaIndexStatus, m.media_index_error AS mediaIndexError,
             m.contact_payload AS contactPayload,
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
             media_ai_index AS mediaAiIndex,
             media_index_status AS mediaIndexStatus, media_index_error AS mediaIndexError, timestamp
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

  /**
   * Chats ordered like the sidebar (newest activity first) so picture fetches fill the top of the list first.
   */
  listChatJidsByRecency() {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT chat_jid AS chatJid FROM (
        SELECT chat_jid, MAX(ts) AS ts FROM (
          SELECT chat_jid, MAX(timestamp) AS ts FROM messages WHERE tenant_id = ? GROUP BY chat_jid
          UNION ALL
          SELECT chat_jid, COALESCE(last_message_ts, 0) AS ts FROM chat_roster WHERE tenant_id = ?
        ) AS activity
        GROUP BY chat_jid
      ) AS ranked
      ORDER BY ts DESC
    `).all(t, t).map((r) => r.chatJid).filter(Boolean);
  }

  /** Jids we already resolved — photo saved, or WhatsApp said there isn't one. */
  listChatAvatarJids() {
    const t = getCurrentTenantId();
    return new Set(
      this._db.prepare('SELECT chat_jid AS chatJid FROM chat_avatars WHERE tenant_id = ?')
        .all(t)
        .map((r) => r.chatJid),
    );
  }

  /**
   * @param {string} chatJid
   * @param {{ relPath?: string|null, missing?: boolean, fetchedAt?: number|null }} fields
   */
  setChatAvatar(chatJid, { relPath = null, missing = false, fetchedAt = null } = {}) {
    const jid = String(chatJid || '').trim();
    if (!jid) return null;
    const missingFlag = missing || !relPath ? 1 : 0;
    const path = missingFlag ? null : String(relPath);
    if (path && !isSafeAvatarFileName(path)) return null;
    const t = getCurrentTenantId();
    const prev = this._db.prepare(
      'SELECT rel_path AS relPath FROM chat_avatars WHERE tenant_id = ? AND chat_jid = ?',
    ).get(t, jid);
    const ts = Number(fetchedAt) || Math.floor(Date.now() / 1000);
    this._db.prepare(`
      INSERT INTO chat_avatars (tenant_id, chat_jid, rel_path, missing, fetched_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, chat_jid) DO UPDATE SET
        rel_path = excluded.rel_path,
        missing = excluded.missing,
        fetched_at = excluded.fetched_at
    `).run(t, jid, path, missingFlag, ts);
    return {
      chatJid: jid,
      hasAvatar: missingFlag === 0,
      avatarRev: ts,
      relPath: path,
      previousRelPath: prev?.relPath || null,
    };
  }

  getChatAvatarRelPath(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return null;
    const t = getCurrentTenantId();
    const row = this._db.prepare(
      'SELECT rel_path AS relPath, missing FROM chat_avatars WHERE tenant_id = ? AND chat_jid = ?',
    ).get(t, jid);
    if (!row || row.missing || !row.relPath || !isSafeAvatarFileName(row.relPath)) return null;
    return row.relPath;
  }

  /** Avatar file + the `avatarRev` that `getChatStats()` hands to the UI for cache-busting. */
  getChatAvatarInfo(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return null;
    const t = getCurrentTenantId();
    const row = this._db.prepare(
      'SELECT rel_path AS relPath, missing, fetched_at AS fetchedAt FROM chat_avatars WHERE tenant_id = ? AND chat_jid = ?',
    ).get(t, jid);
    if (!row || row.missing || !row.relPath || !isSafeAvatarFileName(row.relPath)) return null;
    return { relPath: row.relPath, avatarRev: row.fetchedAt || 0 };
  }

  /** True when some chat still displays this file. */
  avatarRelPathInUse(relPath) {
    if (!relPath) return false;
    const row = this._db.prepare(
      'SELECT COUNT(*) AS c FROM chat_avatars WHERE rel_path = ? AND missing = 0',
    ).get(relPath);
    return (row?.c || 0) > 0;
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
    const rosterTsByChat = new Map();
    for (const r of this._db.prepare(
      'SELECT chat_jid AS chatJid, last_message_ts AS lastMessageTs FROM chat_roster WHERE tenant_id = ?',
    ).all(t)) {
      if (r.chatJid) rosterTsByChat.set(r.chatJid, r.lastMessageTs || 0);
    }
    const optedInJids = new Set(this.listIndexOptInJids());
    const avatarByChat = new Map();
    for (const r of this._db.prepare(
      `SELECT chat_jid AS chatJid, rel_path AS relPath, missing AS missing, fetched_at AS fetchedAt
       FROM chat_avatars WHERE tenant_id = ?`,
    ).all(t)) {
      avatarByChat.set(r.chatJid, r);
    }
    const avatarFields = (chatJid) => {
      const a = avatarByChat.get(chatJid);
      if (!a || a.missing || !a.relPath) return { hasAvatar: false, avatarRev: 0 };
      return { hasAvatar: true, avatarRev: a.fetchedAt || 0 };
    };
    const previewByChat = new Map();
    for (const r of this._db.prepare(`
      SELECT chat_jid AS chatJid, text, sender, media_type AS mediaType,
             receipt_status AS receiptStatus, message_id AS messageId
      FROM (
        SELECT chat_jid, text, sender, media_type, receipt_status, message_id,
               ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY timestamp DESC, id DESC) AS rn
        FROM messages WHERE tenant_id = ?
      ) WHERE rn = 1
    `).all(t)) {
      if (r.chatJid) previewByChat.set(r.chatJid, r);
    }
    const previewFields = (chatJid) => {
      const p = previewByChat.get(chatJid);
      if (!p) {
        return {
          lastMessageId: null,
          lastMessagePreview: '',
          lastMessageFromMe: false,
          lastMessageReceipt: null,
        };
      }
      const isGroup = String(chatJid).endsWith('@g.us');
      return {
        lastMessageId: p.messageId || null,
        lastMessagePreview: chatListPreview({
          text: p.text,
          mediaType: p.mediaType,
          sender: p.sender,
          isGroup,
        }),
        lastMessageFromMe: p.sender === 'You',
        lastMessageReceipt: p.sender === 'You' ? normalizeReceiptStatus(p.receiptStatus) : null,
      };
    };

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
      if (isImportedChatJid(chatJid)) {
        title = prettyImportedChatTitle(title) || title;
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
      const rosterTs = rosterTsByChat.get(chatJid) || 0;
      out.push({
        chatJid,
        chatName: resolveTitle(chatJid, titlesByChat.get(chatJid)),
        sidebarTab: sidebarTabForJid(chatJid),
        messageCount: agg.messageCount,
        participantCount: agg.participantCount,
        lastMessageTs: Math.max(msgTs, rosterTs),
        lastImportedAt: touchTs || null,
        totalThreads: estThreads,
        summarizedThreads,
        searchIndexPct,
        aiSearchReady: summarizedThreads > 0,
        aiSearchComplete: summarizedThreads >= estThreads,
        indexOptedIn: optedInJids.has(chatJid),
        indexEligible: isChatEligibleForIndex({
          chatJid,
          messageCount: agg.messageCount,
          lastMessageTs: msgTs,
        }, { optedIn: optedInJids.has(chatJid) }),
        ...avatarFields(chatJid),
        ...previewFields(chatJid),
      });
    }

    // Chats WhatsApp told us about that have nothing ingested yet. They carry no counts,
    // so the sidebar shows a titled but empty row rather than hiding the chat entirely.
    const seenJids = new Set(out.map((r) => r.chatJid));
    for (const r of this._db.prepare(
      'SELECT chat_jid AS chatJid, chat_name AS chatName, last_message_ts AS lastMessageTs FROM chat_roster WHERE tenant_id = ?',
    ).all(t)) {
      if (!r.chatJid || seenJids.has(r.chatJid)) continue;
      out.push({
        chatJid: r.chatJid,
        chatName: r.chatName || r.chatJid,
        sidebarTab: sidebarTabForJid(r.chatJid),
        messageCount: 0,
        participantCount: 0,
        lastMessageTs: r.lastMessageTs || 0,
        lastImportedAt: null,
        totalThreads: 0,
        summarizedThreads: 0,
        searchIndexPct: 0,
        aiSearchReady: false,
        aiSearchComplete: false,
        awaitingSync: true,
        indexOptedIn: optedInJids.has(r.chatJid),
        indexEligible: isChatEligibleForIndex({
          chatJid: r.chatJid,
          messageCount: 0,
          lastMessageTs: r.lastMessageTs || 0,
        }, { optedIn: optedInJids.has(r.chatJid) }),
        ...avatarFields(r.chatJid),
        ...previewFields(r.chatJid),
      });
    }

    out.sort((a, b) => {
      const ta = a.lastMessageTs || 0;
      const tb = b.lastMessageTs || 0;
      if (tb !== ta) return tb - ta;
      return (b.messageCount || 0) - (a.messageCount || 0);
    });
    return out;
  }

  /**
   * One-time repair for imports that parsed a year ahead (e.g. Dec 2026 instead of Dec 2025).
   * @returns {number} rows updated
   */
  repairFutureMessageTimestamps() {
    const t = getCurrentTenantId();
    const now = Math.floor(Date.now() / 1000) + 86400;
    const rows = this._db.prepare(
      'SELECT id, timestamp FROM messages WHERE tenant_id = ? AND timestamp > ?',
    ).all(t, now);
    if (!rows.length) return 0;

    const upd = this._db.prepare(
      'UPDATE messages SET timestamp = ? WHERE id = ? AND tenant_id = ?',
    );
    let fixed = 0;
    const txn = this._db.transaction(() => {
      for (const row of rows) {
        let ts = row.timestamp;
        let guard = 0;
        while (ts > now && guard < 5) {
          const d = new Date(ts * 1000);
          d.setFullYear(d.getFullYear() - 1);
          ts = Math.floor(d.getTime() / 1000);
          guard += 1;
        }
        if (ts !== row.timestamp) {
          upd.run(ts, row.id, t);
          fixed += 1;
        }
      }
    });
    txn();
    return fixed;
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
    let chatName = nameRow?.chat_name || fallbackRow?.chat_name || null;
    if (chatName && isImportedChatJid(chatJid)) {
      chatName = prettyImportedChatTitle(chatName) || chatName;
    }
    return {
      chatJid,
      chatName,
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

  /** Earliest / latest message timestamps (unix seconds) for empty-search UX. */
  getMessageTimeBounds(chatJid = null) {
    const t = getCurrentTenantId();
    if (chatJid) {
      return this._db.prepare(`
        SELECT MIN(timestamp) AS minTs, MAX(timestamp) AS maxTs
        FROM messages WHERE tenant_id = ? AND chat_jid = ?
      `).get(t, chatJid) || { minTs: null, maxTs: null };
    }
    return this._db.prepare(`
      SELECT MIN(timestamp) AS minTs, MAX(timestamp) AS maxTs
      FROM messages WHERE tenant_id = ?
    `).get(t) || { minTs: null, maxTs: null };
  }

  getMessagesPaginated(chatJid, limit = 80, offset = 0) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_path AS mediaPath,
             media_caption AS mediaCaption, media_ai_index AS mediaAiIndex,
             media_index_status AS mediaIndexStatus, media_index_error AS mediaIndexError,
             reactions_json AS reactionsJson, contact_payload AS contactPayload,
             receipt_status AS receiptStatus,
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
             media_index_status AS mediaIndexStatus, media_index_error AS mediaIndexError,
             reactions_json AS reactionsJson, contact_payload AS contactPayload,
             receipt_status AS receiptStatus,
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
      SELECT message_id AS messageId, media_path AS mediaPath, media_type AS mediaType,
             text, media_caption AS mediaCaption
      FROM messages WHERE tenant_id = ? AND message_id = ?
    `).get(t, messageId);
  }

  /**
   * For reactions / quoted send / delete / forward / edit: load the exact row
   * (chat must match) or any row with that id (LID/PN merge).
   * @returns {object | null}
   */
  getMessageForActions(chatJid, messageId) {
    if (!messageId) return null;
    const t = getCurrentTenantId();
    const cols = `message_id AS messageId, chat_jid AS chatJid, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_caption AS mediaCaption, media_path AS mediaPath,
             timestamp`;
    const row = this._db.prepare(`
      SELECT ${cols}
      FROM messages WHERE tenant_id = ? AND chat_jid = ? AND message_id = ?
    `).get(t, chatJid, messageId);
    if (row) return row;
    return this._db.prepare(`
      SELECT ${cols}
      FROM messages WHERE tenant_id = ? AND message_id = ?
      LIMIT 1
    `).get(t, messageId);
  }

  /**
   * Hard-delete one message from local storage (Delete for me).
   * FTS triggers keep the search index in sync.
   * @returns {number} rows removed
   */
  deleteMessage(chatJid, messageId) {
    if (!messageId) return 0;
    const t = getCurrentTenantId();
    let changes = 0;
    if (chatJid) {
      changes = this._db.prepare(
        'DELETE FROM messages WHERE tenant_id = ? AND chat_jid = ? AND message_id = ?',
      ).run(t, chatJid, messageId).changes;
    }
    if (!changes) {
      changes = this._db.prepare(
        'DELETE FROM messages WHERE tenant_id = ? AND message_id = ?',
      ).run(t, messageId).changes;
    }
    return changes;
  }

  /**
   * Soft-delete after "delete for everyone" / remote revoke — keep the bubble,
   * replace body with WhatsApp's placeholder.
   * @returns {boolean}
   */
  markMessageRevoked(chatJid, messageId) {
    if (!messageId) return false;
    const t = getCurrentTenantId();
    const placeholder = 'This message was deleted';
    const sql = `
      UPDATE messages
      SET text = ?, media_type = NULL, media_path = NULL, media_caption = NULL,
          media_ai_index = NULL, contact_payload = NULL, reactions_json = NULL
      WHERE tenant_id = ? AND message_id = ?
        AND (? IS NULL OR chat_jid = ?)
    `;
    const r = this._db.prepare(sql).run(
      placeholder, t, messageId, chatJid || null, chatJid || null,
    );
    return r.changes > 0;
  }

  /**
   * Apply an in-place edit (own message) to the local row.
   * @returns {boolean}
   */
  updateMessageBody(chatJid, messageId, text) {
    if (!messageId) return false;
    const t = getCurrentTenantId();
    const body = text != null ? String(text) : '';
    const r = this._db.prepare(`
      UPDATE messages SET text = ?
      WHERE tenant_id = ? AND message_id = ?
        AND (? IS NULL OR chat_jid = ?)
    `).run(body, t, messageId, chatJid || null, chatJid || null);
    return r.changes > 0;
  }

  /**
   * Replace a synthetic body (`[Template]`, …) when history re-delivers a real body for the same id.
   * @private
   */
  _upgradePlaceholderMessageBody(tenantId, row) {
    const next = String(row?.text || '').trim();
    if (!next || isContentPlaceholder(next)) return false;
    const existing = this._db.prepare(
      'SELECT text FROM messages WHERE tenant_id = ? AND message_id = ?',
    ).get(tenantId, row.messageId);
    if (!existing || !isContentPlaceholder(existing.text)) return false;
    return this.updateMessageBody(row.chatJid, row.messageId, next);
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
                media_ai_index AS mediaAiIndex,
                media_index_status AS mediaIndexStatus, media_index_error AS mediaIndexError, timestamp
         FROM messages
         WHERE tenant_id = ? AND chat_jid = ? AND ${hasContent}
         ORDER BY timestamp DESC LIMIT ?`
      : `SELECT id, message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName, sender, text,
                media_type AS mediaType, media_path AS mediaPath, media_caption AS mediaCaption,
                media_ai_index AS mediaAiIndex,
                media_index_status AS mediaIndexStatus, media_index_error AS mediaIndexError, timestamp
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
             media_caption AS mediaCaption, media_index_status AS mediaIndexStatus,
             media_index_error AS mediaIndexError, timestamp
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
      INSERT INTO thread_summaries (tenant_id, chat_jid, chat_name, thread_start, thread_end, summary, message_count, facts_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(tenant_id, chat_jid, thread_start) DO UPDATE SET
        summary = excluded.summary,
        thread_end = excluded.thread_end,
        message_count = excluded.message_count,
        chat_name = excluded.chat_name,
        facts_status = NULL
    `).run(t, chatJid, chatName, threadStart, threadEnd, summary, messageCount);
  }

  getPendingFactThreads(limit = 12, opts = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 12, 40));
    const t = getCurrentTenantId();
    const normalizedOpts = typeof opts === 'boolean' ? { waLive: opts } : (opts || {});
    const {
      waLive = true,
      sourceScope = 'all',
      recentCutoffTs = 0,
    } = normalizedOpts;
    const sourceFilter = sourceScope === 'live'
      ? `AND s.chat_jid NOT LIKE '%@imported'`
      : (sourceScope === 'imported' ? `AND s.chat_jid LIKE '%@imported'` : '');
    const vis = sourceScope === 'all' ? this._visibilityOrderSql(waLive, 's.chat_jid') : '';
    const feed = this._feedOrderSql('s.chat_jid');
    const recentOrder = Number(recentCutoffTs) > 0
      ? 'CASE WHEN a.chat_last_ts >= ? THEN 0 ELSE 1 END, '
      : '';
    const orderArgs = Number(recentCutoffTs) > 0 ? [Number(recentCutoffTs)] : [];
    const gate = this._indexEligibilitySql('s.chat_jid');
    return this._db.prepare(`
      WITH chat_activity AS (
        SELECT chat_jid, MAX(timestamp) AS chat_last_ts, COUNT(*) AS msg_count
        FROM messages WHERE tenant_id = ? GROUP BY chat_jid
      )
      SELECT s.chat_jid AS chatJid, s.chat_name AS chatName,
             s.thread_start AS threadStart, s.thread_end AS threadEnd
      FROM thread_summaries s
      INNER JOIN chat_activity a ON a.chat_jid = s.chat_jid
      WHERE s.tenant_id = ?
        ${sourceFilter}
        AND ${gate.sql}
        AND (s.facts_status IS NULL OR trim(s.facts_status) = '')
      ORDER BY ${vis}${feed}${recentOrder}a.chat_last_ts DESC, s.thread_end DESC
      LIMIT ?
    `).all(t, t, ...gate.args, ...orderArgs, n);
  }

  setThreadFactsStatus(chatJid, threadStart, status) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      UPDATE thread_summaries SET facts_status = ?
      WHERE tenant_id = ? AND chat_jid = ? AND thread_start = ?
    `).run(status, t, chatJid, threadStart);
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

  createExpenseReconciliationRun({
    chatJid,
    chatName = null,
    sourceMessageId,
    sourceFileName = null,
    sourceMediaPath = null,
    businessDate = null,
  }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT OR IGNORE INTO expense_reconciliation_runs (
        tenant_id, chat_jid, chat_name, source_message_id, source_file_name,
        source_media_path, business_date, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', unixepoch())
    `).run(t, chatJid, chatName, sourceMessageId, sourceFileName, sourceMediaPath, businessDate);
    return this._db.prepare(`
      SELECT id, tenant_id AS tenantId, chat_jid AS chatJid, chat_name AS chatName,
             source_message_id AS sourceMessageId, source_file_name AS sourceFileName,
             source_media_path AS sourceMediaPath, business_date AS businessDate,
             status, report_path AS reportPath, report_message_id AS reportMessageId,
             totals_json AS totalsJson, error, created_at AS createdAt, updated_at AS updatedAt
      FROM expense_reconciliation_runs
      WHERE tenant_id = ? AND source_message_id = ?
    `).get(t, sourceMessageId);
  }

  updateExpenseReconciliationRun(id, {
    status,
    businessDate = null,
    reportPath = null,
    reportMessageId = null,
    totals = null,
    error = null,
  }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      UPDATE expense_reconciliation_runs SET
        status = COALESCE(?, status),
        business_date = COALESCE(?, business_date),
        report_path = COALESCE(?, report_path),
        report_message_id = COALESCE(?, report_message_id),
        totals_json = COALESCE(?, totals_json),
        error = ?,
        updated_at = unixepoch()
      WHERE tenant_id = ? AND id = ?
    `).run(
      status || null,
      businessDate,
      reportPath,
      reportMessageId,
      totals == null ? null : JSON.stringify(totals),
      error,
      t,
      id,
    );
  }

  replaceExpenseReconciliationData(runId, entries, discrepancies) {
    const t = getCurrentTenantId();
    const replace = this._db.transaction(() => {
      this._db.prepare('DELETE FROM expense_discrepancies WHERE tenant_id = ? AND run_id = ?').run(t, runId);
      this._db.prepare('DELETE FROM expense_entries WHERE tenant_id = ? AND run_id = ?').run(t, runId);
      const insertEntry = this._db.prepare(`
        INSERT INTO expense_entries (
          tenant_id, run_id, source, source_message_id, sheet_row, date, amount_minor,
          currency, direction, payee, category, description, reference, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const ids = new Map();
      for (const entry of entries) {
        const info = insertEntry.run(
          t, runId, entry.source, entry.sourceMessageId || null, entry.sheetRow || null,
          entry.date || null, Number(entry.amountMinor), entry.currency || 'INR',
          entry.direction || 'debit', entry.payee || null, entry.category || null,
          entry.description || null, entry.reference || null, entry.rawJson || null,
        );
        ids.set(entry, Number(info.lastInsertRowid));
      }
      const insertDiff = this._db.prepare(`
        INSERT INTO expense_discrepancies (
          tenant_id, run_id, type, chat_entry_id, sheet_entry_id, detail
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of discrepancies) {
        insertDiff.run(
          t,
          runId,
          item.type,
          item.chatEntry ? ids.get(item.chatEntry) || null : null,
          item.sheetEntry ? ids.get(item.sheetEntry) || null : null,
          item.detail || null,
        );
      }
    });
    replace();
  }

  /** Live groups and imported archive chats that can be picked for expense reconciliation. */
  listExpenseSiteChats() {
    return (this.getChatStats() || [])
      .filter((row) => {
        const jid = String(row?.chatJid || '');
        return jid.endsWith('@g.us') || jid.endsWith('@imported');
      })
      .map((row) => ({
        chatJid: row.chatJid,
        chatName: row.chatName || row.chatJid,
        messageCount: row.messageCount || 0,
        lastMessageTs: row.lastMessageTs || 0,
        imported: String(row.chatJid || '').endsWith('@imported'),
      }))
      .sort((a, b) => String(a.chatName).localeCompare(String(b.chatName), undefined, { sensitivity: 'base' }));
  }

  /**
   * Candidate expense documents / photo sheets in a site chat (newest first).
   * Includes imported archives where sheets are often images or PDFs, not only xlsx.
   * Callers still apply isExpenseSheetMessage for report-prefix / import filters.
   */
  listExpenseSheetMessages(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid.endsWith('@g.us') && !jid.endsWith('@imported')) return [];
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName,
             sender, text, media_caption AS mediaCaption, media_path AS mediaPath,
             media_type AS mediaType, timestamp
      FROM messages
      WHERE tenant_id = ?
        AND chat_jid = ?
        AND sender != 'You'
        AND media_type IN ('document', 'image')
        AND media_path IS NOT NULL
        AND lower(media_path) NOT LIKE '%searchable-expense-report-%'
        AND (
          media_type = 'image'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.xlsx%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.xlsm%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.csv%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.tsv%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.txt%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.pdf%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.docx%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.jpg%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.jpeg%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.png%'
          OR lower(coalesce(text, '') || ' ' || coalesce(media_caption, '') || ' ' || media_path) LIKE '%.webp%'
        )
      ORDER BY timestamp DESC, id DESC
    `).all(t, jid);
  }

  listExpenseReconciliationRuns({ chatJid = null, status = null } = {}) {
    const t = getCurrentTenantId();
    const clauses = ['tenant_id = ?'];
    const params = [t];
    if (chatJid) { clauses.push('chat_jid = ?'); params.push(chatJid); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             source_message_id AS sourceMessageId, source_file_name AS sourceFileName,
             business_date AS businessDate, status, report_message_id AS reportMessageId,
             totals_json AS totalsJson, error, created_at AS createdAt, updated_at AS updatedAt
      FROM expense_reconciliation_runs
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC
    `).all(...params).map((row) => ({
      ...row,
      totals: row.totalsJson ? JSON.parse(row.totalsJson) : null,
    }));
  }

  getExpenseReconciliationRun(id) {
    const t = getCurrentTenantId();
    const run = this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             source_message_id AS sourceMessageId, source_file_name AS sourceFileName,
             source_media_path AS sourceMediaPath, business_date AS businessDate,
             status, report_path AS reportPath, report_message_id AS reportMessageId,
             totals_json AS totalsJson, error, created_at AS createdAt, updated_at AS updatedAt
      FROM expense_reconciliation_runs WHERE tenant_id = ? AND id = ?
    `).get(t, Number(id));
    if (!run) return null;
    run.totals = run.totalsJson ? JSON.parse(run.totalsJson) : null;
    run.entries = this._db.prepare(`
      SELECT id, source, source_message_id AS sourceMessageId, sheet_row AS sheetRow,
             date, amount_minor AS amountMinor, currency, direction, payee, category,
             description, reference, raw_json AS rawJson
      FROM expense_entries WHERE tenant_id = ? AND run_id = ? ORDER BY id
    `).all(t, run.id);
    const byId = new Map(run.entries.map((entry) => [entry.id, entry]));
    run.discrepancies = this._db.prepare(`
      SELECT id, type, chat_entry_id AS chatEntryId, sheet_entry_id AS sheetEntryId,
             detail, resolution, resolved_at AS resolvedAt, created_at AS createdAt
      FROM expense_discrepancies WHERE tenant_id = ? AND run_id = ? ORDER BY id
    `).all(t, run.id).map((item) => ({
      ...item,
      chatEntry: byId.get(item.chatEntryId) || null,
      sheetEntry: byId.get(item.sheetEntryId) || null,
    }));
    return run;
  }

  listRecoverableExpenseRuns() {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, source_message_id AS sourceMessageId, status
      FROM expense_reconciliation_runs
      WHERE tenant_id = ? AND status IN ('queued', 'processing')
      ORDER BY created_at ASC
    `).all(t);
  }

  resetExpenseReconciliationRun(id) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      UPDATE expense_reconciliation_runs
      SET status = 'queued', error = NULL, report_path = NULL, report_message_id = NULL, updated_at = unixepoch()
      WHERE tenant_id = ? AND id = ?
    `).run(t, Number(id)).changes > 0;
  }

  resolveExpenseDiscrepancy(id, resolution) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      UPDATE expense_discrepancies
      SET resolution = ?, resolved_at = unixepoch()
      WHERE tenant_id = ? AND id = ?
    `).run(String(resolution || '').trim(), t, Number(id)).changes > 0;
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
    try {
      this._db.prepare(`
        DELETE FROM message_embeddings
        WHERE tenant_id = ?
          AND message_rowid IN (SELECT id FROM messages WHERE tenant_id = ? AND chat_jid = ?)
      `).run(t, t, chatJid);
    } catch { /* table may be missing */ }
    this._db.prepare('DELETE FROM messages WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    this._db.prepare('DELETE FROM daily_summaries WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    this._db.prepare('DELETE FROM thread_summaries WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    this._db.prepare('DELETE FROM thread_facts WHERE tenant_id = ? AND chat_jid = ?').run(t, chatJid);
    const optional = [
      'DELETE FROM chat_action_items WHERE tenant_id = ? AND chat_jid = ?',
      'DELETE FROM chat_import_touches WHERE tenant_id = ? AND chat_jid = ?',
      'DELETE FROM chat_unread WHERE tenant_id = ? AND chat_jid = ?',
      'DELETE FROM index_opt_in WHERE tenant_id = ? AND chat_jid = ?',
      'DELETE FROM expense_reconciliation_runs WHERE tenant_id = ? AND chat_jid = ?',
      // Sidebar lists empty chats from roster — must clear or deletes "come back" on refresh.
      'DELETE FROM chat_roster WHERE tenant_id = ? AND chat_jid = ?',
      'DELETE FROM chat_last_seen WHERE tenant_id = ? AND chat_jid = ?',
      'DELETE FROM chat_avatars WHERE tenant_id = ? AND chat_jid = ?',
      'DELETE FROM chat_catchup WHERE tenant_id = ? AND chat_jid = ?',
    ];
    for (const sql of optional) {
      try { this._db.prepare(sql).run(t, chatJid); } catch { /* older schemas */ }
    }
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

  createSearchConversation({ id, title = null, chatJid = null }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO search_conversations (id, tenant_id, title, chat_jid, created_at, updated_at)
      VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(id, t, title, chatJid);
    return this.getSearchConversation(id);
  }

  touchSearchConversation(id, { title = undefined, chatJid = undefined } = {}) {
    const t = getCurrentTenantId();
    const row = this.getSearchConversation(id);
    if (!row) return null;
    const nextTitle = title !== undefined ? title : row.title;
    const nextChat = chatJid !== undefined ? chatJid : row.chatJid;
    this._db.prepare(`
      UPDATE search_conversations
      SET title = ?, chat_jid = ?, updated_at = unixepoch()
      WHERE tenant_id = ? AND id = ?
    `).run(nextTitle, nextChat, t, id);
    return this.getSearchConversation(id);
  }

  getSearchConversation(id) {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT id, title, chat_jid AS chatJid,
             created_at AS createdAt, updated_at AS updatedAt
      FROM search_conversations
      WHERE tenant_id = ? AND id = ?
    `).get(t, id) || null;
  }

  listSearchConversations(limit = 30) {
    const t = getCurrentTenantId();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
    return this._db.prepare(`
      SELECT id, title, chat_jid AS chatJid,
             created_at AS createdAt, updated_at AS updatedAt
      FROM search_conversations
      WHERE tenant_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(t, safeLimit);
  }

  addSearchMessage({ id, conversationId, role, content, payload = null }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO search_messages (id, tenant_id, conversation_id, role, content, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      id,
      t,
      conversationId,
      role,
      String(content || ''),
      payload == null ? null : JSON.stringify(payload),
    );
    this._db.prepare(`
      UPDATE search_conversations SET updated_at = unixepoch()
      WHERE tenant_id = ? AND id = ?
    `).run(t, conversationId);
    return this.getSearchMessage(id);
  }

  getSearchMessage(id) {
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT id, conversation_id AS conversationId, role, content,
             payload_json AS payloadJson, created_at AS createdAt
      FROM search_messages
      WHERE tenant_id = ? AND id = ?
    `).get(t, id);
    if (!row) return null;
    return {
      ...row,
      payload: row.payloadJson ? JSON.parse(row.payloadJson) : null,
    };
  }

  listSearchMessages(conversationId, limit = 100) {
    const t = getCurrentTenantId();
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    return this._db.prepare(`
      SELECT id, conversation_id AS conversationId, role, content,
             payload_json AS payloadJson, created_at AS createdAt
      FROM search_messages
      WHERE tenant_id = ? AND conversation_id = ?
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `).all(t, conversationId, safeLimit).map((row) => ({
      ...row,
      payload: row.payloadJson ? JSON.parse(row.payloadJson) : null,
    }));
  }

  deleteSearchConversation(id) {
    const t = getCurrentTenantId();
    this._db.prepare('DELETE FROM search_messages WHERE tenant_id = ? AND conversation_id = ?').run(t, id);
    return this._db.prepare('DELETE FROM search_conversations WHERE tenant_id = ? AND id = ?').run(t, id).changes > 0;
  }

  _ensureSkillTables() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS user_skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        slug TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        frontmatter_json TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(tenant_id, namespace, slug)
      );

      CREATE TABLE IF NOT EXISTS skill_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        conversation_id TEXT,
        message_id TEXT,
        namespace TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        inputs_json TEXT,
        coverage_json TEXT,
        tool_calls_json TEXT,
        expense_run_id INTEGER,
        error TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_skill_runs_tenant_created
        ON skill_runs(tenant_id, created_at DESC);
    `);
  }

  listUserSkills() {
    const t = getCurrentTenantId();
    return this._db.prepare(`
      SELECT namespace, slug, version, frontmatter_json AS frontmatterJson, body
      FROM user_skills WHERE tenant_id = ? ORDER BY namespace, slug
    `).all(t).map((row) => ({
      ...row,
      frontmatter: row.frontmatterJson ? JSON.parse(row.frontmatterJson) : {},
    }));
  }

  upsertUserSkill({ namespace, slug, version = 1, frontmatter = {}, body = '' }) {
    const t = getCurrentTenantId();
    const ns = String(namespace || '').trim().toLowerCase();
    const sl = String(slug || '').trim().toLowerCase();
    this._db.prepare(`
      INSERT INTO user_skills (tenant_id, namespace, slug, version, frontmatter_json, body)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, namespace, slug) DO UPDATE SET
        version = excluded.version,
        frontmatter_json = excluded.frontmatter_json,
        body = excluded.body,
        updated_at = unixepoch()
    `).run(t, ns, sl, Number(version) || 1, JSON.stringify(frontmatter), String(body || ''));
    return this.listUserSkills().find((row) => row.namespace === ns && row.slug === sl) || null;
  }

  deleteUserSkill(namespace, slug) {
    const t = getCurrentTenantId();
    const ns = String(namespace || '').trim().toLowerCase();
    const sl = String(slug || '').trim().toLowerCase();
    if (!ns || !sl) return false;
    const result = this._db.prepare(
      'DELETE FROM user_skills WHERE tenant_id = ? AND namespace = ? AND slug = ?',
    ).run(t, ns, sl);
    return result.changes > 0;
  }

  _skillRunFromRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversationId,
      messageId: row.messageId,
      namespace: row.namespace,
      slug: row.slug,
      kind: row.kind,
      version: row.version,
      status: row.status,
      inputs: row.inputsJson ? JSON.parse(row.inputsJson) : null,
      coverage: row.coverageJson ? JSON.parse(row.coverageJson) : null,
      toolCalls: row.toolCallsJson ? JSON.parse(row.toolCallsJson) : null,
      expenseRunId: row.expenseRunId,
      error: row.error,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  createSkillRun({
    id, conversationId = null, messageId = null, namespace, slug, kind, version,
    status, inputs = null, coverage = null, toolCalls = null, expenseRunId = null, error = null,
  }) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      INSERT INTO skill_runs (
        id, tenant_id, conversation_id, message_id, namespace, slug, kind, version,
        status, inputs_json, coverage_json, tool_calls_json, expense_run_id, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, t, conversationId, messageId, namespace, slug, kind, Number(version) || 1, status,
      inputs == null ? null : JSON.stringify(inputs),
      coverage == null ? null : JSON.stringify(coverage),
      toolCalls == null ? null : JSON.stringify(toolCalls),
      expenseRunId, error,
    );
    return this.getSkillRun(id);
  }

  getSkillRun(id) {
    const t = getCurrentTenantId();
    const row = this._db.prepare(`
      SELECT id, conversation_id AS conversationId, message_id AS messageId,
             namespace, slug, kind, version, status,
             inputs_json AS inputsJson, coverage_json AS coverageJson,
             tool_calls_json AS toolCallsJson, expense_run_id AS expenseRunId,
             error, created_at AS createdAt, updated_at AS updatedAt
      FROM skill_runs WHERE tenant_id = ? AND id = ?
    `).get(t, id);
    return this._skillRunFromRow(row);
  }

  updateSkillRun(id, { status = null, messageId = null, error = null } = {}) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      UPDATE skill_runs SET
        status = COALESCE(?, status),
        message_id = COALESCE(?, message_id),
        error = COALESCE(?, error),
        updated_at = unixepoch()
      WHERE tenant_id = ? AND id = ?
    `).run(status, messageId, error, t, id);
    return this.getSkillRun(id);
  }

  updateSearchMessagePayload(id, payload) {
    const t = getCurrentTenantId();
    this._db.prepare(`
      UPDATE search_messages SET payload_json = ? WHERE tenant_id = ? AND id = ?
    `).run(payload == null ? null : JSON.stringify(payload), t, id);
    return this.getSearchMessage(id);
  }

  /** Raw better-sqlite3 handle (e.g. auth routes for `tenants` table). */
  getSqliteDatabase() {
    return this._db;
  }

  close() {
    this._db.close();
  }
}
