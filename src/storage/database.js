import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import config from '../config.js';
import { buildSearchText } from '../search/fact-extract.js';
import { segmentIntoThreads } from '../search/thread-segment.js';

const require = createRequire(import.meta.url);
const SQLite = require('better-sqlite3');

/** True if `name` is a better sidebar title than the bare JID local part (avoids last-outgoing-msg wiping the label). */
function looksLikeContactDisplayName(name, chatJid) {
  if (!name || !chatJid) return false;
  const local = String(chatJid).split('@')[0];
  if (name === local) return false;
  const digitsOnly = String(name).replace(/\s/g, '').replace(/^\+/, '');
  const localDigits = local.replace(/^\+/, '');
  if (/^\d{8,16}$/.test(digitsOnly) && digitsOnly === localDigits) return false;
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
    this._prepareStatements();
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
    this._migrateChatActionItemsTable();
    this._rebuildFtsIfEmpty();
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
          'SELECT chat_jid AS chatJid, message_id AS messageId, action_suggestions AS raw FROM messages WHERE action_suggestions IS NOT NULL AND trim(action_suggestions) NOT IN (\'\', \'[]\')',
        ).all();
        const ins = this._db.prepare(`
          INSERT OR REPLACE INTO chat_action_items (chat_jid, source_message_id, items_json, created_at)
          VALUES (?, ?, ?, unixepoch())
        `);
        for (const r of rows) {
          try {
            const arr = JSON.parse(r.raw);
            if (Array.isArray(arr) && arr.length) ins.run(r.chatJid, r.messageId, JSON.stringify(arr));
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
        message_id, chat_jid, chat_name, sender, sender_jid,
        text, media_type, media_path, media_caption, media_ai_index, timestamp
      ) VALUES (
        @messageId, @chatJid, @chatName, @sender, @senderJid,
        @text, @mediaType, @mediaPath, @mediaCaption, @mediaAiIndex, @timestamp
      )
    `);
    this._stmtSelectIdByMessageId = this._db.prepare(
      'SELECT id FROM messages WHERE message_id = ?'
    );
    this._stmtGetState = this._db.prepare('SELECT value FROM agent_state WHERE key = ?');
    this._stmtUpsertState = this._db.prepare(`
      INSERT INTO agent_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this._stmtUpsertSummary = this._db.prepare(`
      INSERT INTO daily_summaries (chat_jid, chat_name, date, summary, message_count)
      VALUES (@chatJid, @chatName, @date, @summary, @messageCount)
      ON CONFLICT(chat_jid, date) DO UPDATE SET
        summary = excluded.summary, chat_name = excluded.chat_name,
        message_count = excluded.message_count
    `);
    this._stmtGetSetting = this._db.prepare('SELECT value FROM settings WHERE key = ?');
    this._stmtUpsertSetting = this._db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  // ── Settings ──────────────────────────────────────────────────────────

  getSetting(key) {
    const row = this._stmtGetSetting.get(key);
    return row ? row.value : null;
  }

  setSetting(key, value) {
    this._stmtUpsertSetting.run(key, String(value));
  }

  getAllSettings() {
    return this._db.prepare('SELECT key, value FROM settings').all()
      .reduce((acc, r) => { acc[r.key] = r.value; return acc; }, {});
  }

  // ── Messages ──────────────────────────────────────────────────────────

  insertMessage({
    messageId, chatJid, chatName = null, sender = null, senderJid = null,
    text = null, mediaType = null, mediaPath = null, mediaCaption = null, mediaAiIndex = null, timestamp,
  }) {
    const info = this._stmtInsertMessage.run({
      messageId, chatJid, chatName, sender, senderJid,
      text, mediaType, mediaPath, mediaCaption, mediaAiIndex, timestamp,
    });
    if (info.changes > 0) return Number(info.lastInsertRowid);
    const row = this._stmtSelectIdByMessageId.get(messageId);
    return row ? row.id : Number(info.lastInsertRowid);
  }

  /**
   * @returns {{ count: number, insertedMessageIds: string[] }}
   */
  insertMessageBatch(rows) {
    const insertedMessageIds = [];
    const run = this._db.transaction((batch) => {
      for (const row of batch) {
        const info = this._stmtInsertMessage.run({
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
        });
        if (info.changes > 0 && row.messageId) insertedMessageIds.push(row.messageId);
      }
    });
    run(rows);
    return { count: insertedMessageIds.length, insertedMessageIds };
  }

  /**
   * When we learn a human-readable chat title (from WA), backfill all rows for that chat so the sidebar
   * and search stop showing bare phone / LID after older messages were stored with a numeric label.
   */
  propagateChatDisplayName(chatJid, chatName) {
    if (!chatJid || !chatName || !looksLikeContactDisplayName(chatName, chatJid)) return 0;
    const r = this._db.prepare('UPDATE messages SET chat_name = ? WHERE chat_jid = ?').run(chatName, chatJid);
    return r.changes ?? 0;
  }

  updateMediaCaption(messageId, caption) {
    this._db.prepare('UPDATE messages SET media_caption = ? WHERE message_id = ?')
      .run(caption, messageId);
  }

  updateMessageMediaPath(messageId, mediaPath) {
    if (!messageId) return 0;
    const r = this._db.prepare('UPDATE messages SET media_path = ? WHERE message_id = ?')
      .run(mediaPath, messageId);
    return r.changes ?? 0;
  }

  /** @param jsonStr JSON array string e.g. `["…","…"]` or `[]` after processing */
  updateMessageActionSuggestions(messageId, jsonStr) {
    if (!messageId) return 0;
    const r = this._db.prepare('UPDATE messages SET action_suggestions = ? WHERE message_id = ?')
      .run(jsonStr ?? '', messageId);
    return r.changes ?? 0;
  }

  getMessageRowByMessageId(messageId) {
    if (!messageId) return null;
    return this._db.prepare(`
      SELECT message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName,
             sender, text, media_caption AS mediaCaption, timestamp
      FROM messages WHERE message_id = ?
    `).get(messageId);
  }

  /** Per-chat action list; each row ties suggestions to a source message. */
  upsertChatActionItems(chatJid, sourceMessageId, itemsArray) {
    if (!chatJid || !sourceMessageId) return;
    const items = (itemsArray || []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!items.length) {
      this._db.prepare('DELETE FROM chat_action_items WHERE chat_jid = ? AND source_message_id = ?').run(chatJid, sourceMessageId);
      return;
    }
    this._db.prepare(`
      INSERT INTO chat_action_items (chat_jid, source_message_id, items_json, created_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(chat_jid, source_message_id) DO UPDATE SET
        items_json = excluded.items_json,
        created_at = unixepoch()
    `).run(chatJid, sourceMessageId, JSON.stringify(items));
  }

  getChatActionItemsWithContext(chatJid) {
    if (!chatJid) return [];
    const rows = this._db.prepare(`
      SELECT c.source_message_id AS sourceMessageId, c.items_json AS itemsJson, c.created_at AS createdAt,
             m.text AS snippet, m.timestamp AS messageTs
      FROM chat_action_items c
      LEFT JOIN messages m ON m.message_id = c.source_message_id AND m.chat_jid = c.chat_jid
      WHERE c.chat_jid = ?
      ORDER BY c.created_at DESC
    `).all(chatJid);
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
   * Persists AI-generated searchable text for image/video/sticker captions and audio transcripts.
   * Empty string means "indexed but nothing usable" (avoids infinite retries).
   */
  updateMediaAiIndex(messageId, text) {
    if (!messageId) return 0;
    const r = this._db.prepare('UPDATE messages SET media_ai_index = ? WHERE message_id = ?')
      .run(text ?? '', messageId);
    return r.changes ?? 0;
  }

  /**
   * Rows with downloaded media that still need caption/transcribe (media_ai_index IS NULL).
   */
  getPendingMediaIndexJobs(limit = 12) {
    const n = Math.max(1, Math.min(Number(limit) || 12, 40));
    return this._db.prepare(`
      SELECT id, message_id AS messageId, media_type AS mediaType, media_path AS mediaPath
      FROM messages
      WHERE media_path IS NOT NULL AND trim(media_path) != ''
        AND media_type IN ('image', 'audio', 'video', 'sticker')
        AND media_ai_index IS NULL
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(n);
  }

  // ── Daily Summaries ───────────────────────────────────────────────────

  upsertDailySummary({ chatJid, chatName = null, date, summary, messageCount = 0 }) {
    this._stmtUpsertSummary.run({ chatJid, chatName, date, summary, messageCount });
  }

  getDailySummaries(chatJid) {
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries WHERE chat_jid = ? ORDER BY date ASC
    `).all(chatJid);
  }

  getAllDailySummaries() {
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries ORDER BY date ASC
    `).all();
  }

  countDailySummaries() {
    return this._db.prepare('SELECT COUNT(*) AS c FROM daily_summaries').get()?.c || 0;
  }

  getDailySummary(chatJid, date) {
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries
      WHERE chat_jid = ? AND date = ?
    `).get(chatJid, date);
  }

  /** Recent days (chronological) — FTS-empty fallback without loading all rows. */
  getRecentDailySummaries(chatJid = null, limit = 32) {
    const safe = Math.max(1, Math.min(Number(limit) || 32, 200));
    if (chatJid) {
      const rows = this._db.prepare(`
        SELECT id, chat_jid AS chatJid, chat_name AS chatName,
               date, summary, message_count AS messageCount
        FROM daily_summaries
        WHERE chat_jid = ?
        ORDER BY date DESC
        LIMIT ?
      `).all(chatJid, safe);
      return rows.reverse();
    }
    const rows = this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             date, summary, message_count AS messageCount
      FROM daily_summaries
      ORDER BY date DESC
      LIMIT ?
    `).all(safe);
    return rows.reverse();
  }

  /** Recent threads (chronological order) without loading the full table — FTS-empty fallback. */
  getRecentThreadSummaries(chatJid = null, limit = 32) {
    const safe = Math.max(1, Math.min(Number(limit) || 32, 200));
    if (chatJid) {
      const rows = this._db.prepare(`
        SELECT id, chat_jid AS chatJid, chat_name AS chatName,
               thread_start AS threadStart, thread_end AS threadEnd,
               summary, message_count AS messageCount
        FROM thread_summaries
        WHERE chat_jid = ?
        ORDER BY thread_start DESC
        LIMIT ?
      `).all(chatJid, safe);
      return rows.reverse();
    }
    const rows = this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries
      ORDER BY thread_start DESC
      LIMIT ?
    `).all(safe);
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
    return this._db.prepare(`
      SELECT ds.id, ds.chat_jid AS chatJid, ds.chat_name AS chatName,
             ds.date, ds.summary, ds.message_count AS messageCount,
             bm25(summaries_fts) AS rank
      FROM summaries_fts
      INNER JOIN daily_summaries ds ON ds.id = summaries_fts.rowid
      WHERE summaries_fts MATCH ?
        AND (? IS NULL OR ds.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(cleaned, chatJid, chatJid, safeLimit);
  }

  searchMessages(query, chatJid = null, limit = 20) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 500));
    const cleaned = this._toFtsQuery(query);
    if (!cleaned) return [];
    return this._db.prepare(`
      SELECT m.id, m.message_id AS messageId, m.chat_jid AS chatJid,
             m.chat_name AS chatName, m.sender, m.text,
             m.media_type AS mediaType, m.media_caption AS mediaCaption,
             m.media_ai_index AS mediaAiIndex,
             m.timestamp, bm25(messages_fts) AS rank
      FROM messages_fts
      INNER JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ?
        AND (? IS NULL OR m.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(cleaned, chatJid, chatJid, safeLimit);
  }

  getMessagesForDay(chatJid, dateStr) {
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex, timestamp
      FROM messages
      WHERE chat_jid = ? AND date(timestamp, 'unixepoch', 'localtime') = ?
      ORDER BY timestamp ASC
    `).all(chatJid, dateStr);
  }

  getUnsummarizedDays(chatJid) {
    return this._db.prepare(`
      SELECT date(timestamp, 'unixepoch', 'localtime') AS date, COUNT(*) AS messageCount
      FROM messages
      WHERE chat_jid = ?
        AND date(timestamp, 'unixepoch', 'localtime') NOT IN (
          SELECT date FROM daily_summaries WHERE chat_jid = ?
        )
      GROUP BY date(timestamp, 'unixepoch', 'localtime')
      HAVING messageCount >= 1 ORDER BY date ASC
    `).all(chatJid, chatJid);
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
    const rows = this._db.prepare('SELECT DISTINCT chat_jid AS chatJid FROM messages').all();
    return rows.map((r) => r.chatJid).filter(Boolean);
  }

  getChatStats() {
    const rows = this._db.prepare(`
      SELECT chat_jid AS chatJid, chat_name AS chatName, sender, timestamp
      FROM messages ORDER BY chat_jid ASC, timestamp ASC
    `).all();

    const summaryRows = this._db.prepare(`
      SELECT chat_jid AS chatJid, COUNT(*) AS c FROM thread_summaries GROUP BY chat_jid
    `).all();
    const summarizedByChat = new Map(summaryRows.map((r) => [r.chatJid, r.c]));

    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.chatJid)) {
        groups.set(r.chatJid, {
          messages: [],
          anyChatName: null,
          displayChatName: null,
          /** For 1:1 chats: latest non-"You" sender (often phone if pushName missing). */
          peerSenderName: null,
          /** Latest peer sender that is not phone-only (push name / business name). */
          peerHumanSenderName: null,
          /** First non–phone-only peer sender in chronological order (stable title when recent rows only have digits). */
          firstHumanPeerName: null,
          /** Longest non-phone peer sender string in the chat (best pushName / saved name seen). */
          bestHumanPeerName: null,
          senders: new Set(),
        });
      }
      const g = groups.get(r.chatJid);
      g.messages.push({ timestamp: r.timestamp });
      if (r.chatName) {
        g.anyChatName = r.chatName;
        if (looksLikeContactDisplayName(r.chatName, r.chatJid)) {
          g.displayChatName = r.chatName;
        }
      }
      if (r.sender) g.senders.add(r.sender);
      const isGroup = r.chatJid.endsWith('@g.us');
      if (!isGroup && r.sender && r.sender !== 'You') {
        g.peerSenderName = r.sender;
        if (!looksLikePhoneOnly(r.sender)) {
          const sn = r.sender.trim();
          g.peerHumanSenderName = r.sender;
          if (!g.firstHumanPeerName) g.firstHumanPeerName = r.sender;
          if (!g.bestHumanPeerName || sn.length > g.bestHumanPeerName.length) {
            g.bestHumanPeerName = sn;
          }
        }
      }
    }

    const out = [];
    for (const [chatJid, g] of groups) {
      const threads = segmentIntoThreads(g.messages);
      const totalThreads = threads.length;
      let summarizedThreads = summarizedByChat.get(chatJid) || 0;
      if (summarizedThreads > totalThreads) summarizedThreads = totalThreads;
      const searchIndexPct =
        totalThreads === 0 ? 100 : Math.min(100, Math.round((summarizedThreads / totalThreads) * 100));
      const lastMessageTs = g.messages.length ? g.messages[g.messages.length - 1].timestamp : 0;
      const isGroup = chatJid.endsWith('@g.us');
      // 1:1: do not let a numeric chat_name (stored on every row) hide the peer's pushName on incoming msgs.
      const title = isGroup
        ? (g.displayChatName || g.anyChatName || chatJid)
        : (g.displayChatName
          || g.bestHumanPeerName
          || g.firstHumanPeerName
          || g.peerHumanSenderName
          || (looksLikePhoneOnly(g.anyChatName) ? null : g.anyChatName)
          || g.peerSenderName
          || g.anyChatName
          || chatJid);
      out.push({
        chatJid,
        chatName: title,
        messageCount: g.messages.length,
        participantCount: g.senders.size,
        lastMessageTs,
        totalThreads,
        summarizedThreads,
        searchIndexPct,
        /** At least one thread summary exists — hierarchical AI search can use this chat. */
        aiSearchReady: summarizedThreads > 0,
        /** All segments that qualify for summaries have been summarized. */
        aiSearchComplete: totalThreads === 0 ? true : summarizedThreads >= totalThreads,
      });
    }
    out.sort((a, b) => b.lastMessageTs - a.lastMessageTs);
    return out;
  }

  getTotalStats() {
    const row = this._db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages) AS totalMessages,
        (SELECT COUNT(DISTINCT chat_jid) FROM messages) AS totalChats,
        (SELECT COUNT(*) FROM daily_summaries) AS dailySummaries,
        (SELECT COUNT(*) FROM thread_summaries) AS threadSummaries,
        (SELECT COUNT(*) FROM thread_facts) AS threadFacts
    `).get();
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
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_path AS mediaPath,
             media_caption AS mediaCaption, media_ai_index AS mediaAiIndex,
             timestamp, indexed_at AS indexedAt
      FROM messages WHERE chat_jid = ?
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(chatJid, Math.min(Number(limit) || 80, 500), Math.max(0, Number(offset) || 0));
  }

  /**
   * Loads a window of messages so `messageId` appears near the middle (for “jump to source”).
   */
  getMessagesAroundMessageId(chatJid, messageId, limit = 200) {
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 40), 500);
    const half = Math.floor(safeLimit / 2);
    const anchor = this._db.prepare(
      'SELECT id, timestamp FROM messages WHERE chat_jid = ? AND message_id = ? LIMIT 1',
    ).get(chatJid, messageId);
    if (!anchor) return this.getMessagesPaginated(chatJid, safeLimit, 0);

    const rankRow = this._db.prepare(`
      SELECT COUNT(*) AS c FROM messages
      WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
    `).get(chatJid, anchor.timestamp, anchor.timestamp, anchor.id);
    const newerCount = rankRow?.c ?? 0;
    const offset = Math.max(0, newerCount - half);
    return this.getMessagesPaginated(chatJid, safeLimit, offset);
  }

  getMediaMessages(chatJid = null, mediaType = null, limit = 50) {
    let sql = `SELECT id, message_id AS messageId, chat_jid AS chatJid,
      chat_name AS chatName, sender, text, media_type AS mediaType,
      media_caption AS mediaCaption, timestamp
      FROM messages WHERE media_type IS NOT NULL`;
    const params = [];
    if (chatJid) { sql += ' AND chat_jid = ?'; params.push(chatJid); }
    if (mediaType) { sql += ' AND media_type = ?'; params.push(mediaType); }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(Math.min(Number(limit) || 50, 200));
    return this._db.prepare(sql).all(...params);
  }

  getAllMessagesLight(chatJid = null, limit = 5000) {
    const hasContent = `(
           (text IS NOT NULL AND trim(text) != '')
           OR (media_caption IS NOT NULL AND trim(media_caption) != '')
           OR (media_ai_index IS NOT NULL AND trim(media_ai_index) != '')
           OR (media_type IS NOT NULL AND trim(media_type) != '')
         )`;
    const sql = chatJid
      ? `SELECT id, message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName, sender, text,
                media_type AS mediaType, media_caption AS mediaCaption,
                media_ai_index AS mediaAiIndex, timestamp
         FROM messages
         WHERE chat_jid = ? AND ${hasContent}
         ORDER BY timestamp DESC LIMIT ?`
      : `SELECT id, message_id AS messageId, chat_jid AS chatJid, chat_name AS chatName, sender, text,
                media_type AS mediaType, media_caption AS mediaCaption,
                media_ai_index AS mediaAiIndex, timestamp
         FROM messages
         WHERE ${hasContent}
         ORDER BY timestamp DESC LIMIT ?`;
    return chatJid
      ? this._db.prepare(sql).all(chatJid, limit)
      : this._db.prepare(sql).all(limit);
  }

  clearAllSummaries() {
    const count = this._db.prepare('SELECT COUNT(*) AS c FROM daily_summaries').get()?.c || 0;
    this._db.prepare('DELETE FROM daily_summaries').run();
    try {
      this._db.exec("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')");
    } catch (err) {
      console.error('[DB] FTS rebuild after summary clear failed:', err.message);
    }
    return count;
  }

  // ── Thread Summaries ──────────────────────────────────────────────────

  upsertThreadSummary({ chatJid, chatName = null, threadStart, threadEnd, summary, messageCount = 0 }) {
    this._db.prepare(`
      INSERT INTO thread_summaries (chat_jid, chat_name, thread_start, thread_end, summary, message_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_jid, thread_start) DO UPDATE SET
        summary = excluded.summary,
        thread_end = excluded.thread_end,
        message_count = excluded.message_count,
        chat_name = excluded.chat_name
    `).run(chatJid, chatName, threadStart, threadEnd, summary, messageCount);
  }

  getAllThreadSummaries() {
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries ORDER BY thread_start ASC
    `).all();
  }

  countThreadSummaries() {
    return this._db.prepare('SELECT COUNT(*) AS c FROM thread_summaries').get()?.c || 0;
  }

  /** One thread row by natural key (for merging fact hits into the candidate pool). */
  getThreadSummary(chatJid, threadStart) {
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries
      WHERE chat_jid = ? AND thread_start = ?
    `).get(chatJid, threadStart);
  }

  /** Thread whose time range covers a message timestamp (for lexical message → thread expansion). */
  getThreadSummaryCoveringTimestamp(chatJid, timestamp) {
    return this._db.prepare(`
      SELECT id, chat_jid AS chatJid, chat_name AS chatName,
             thread_start AS threadStart, thread_end AS threadEnd,
             summary, message_count AS messageCount
      FROM thread_summaries
      WHERE chat_jid = ? AND ? >= thread_start AND ? <= thread_end
      LIMIT 1
    `).get(chatJid, timestamp, timestamp);
  }

  getSummarizedThreadStarts(chatJid) {
    const rows = this._db.prepare(
      'SELECT thread_start FROM thread_summaries WHERE chat_jid = ?'
    ).all(chatJid);
    return new Set(rows.map(r => r.thread_start));
  }

  getMessagesByTimeRange(chatJid, startTs, endTs) {
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, sender_jid AS senderJid,
             text, media_type AS mediaType, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex, timestamp
      FROM messages
      WHERE chat_jid = ? AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(chatJid, startTs, endTs);
  }

  getAllMessagesForChat(chatJid) {
    return this._db.prepare(`
      SELECT id, message_id AS messageId, chat_jid AS chatJid,
             chat_name AS chatName, sender, text,
             media_type AS mediaType, media_caption AS mediaCaption,
             media_ai_index AS mediaAiIndex, timestamp
      FROM messages WHERE chat_jid = ? ORDER BY timestamp ASC
    `).all(chatJid);
  }

  /** Replace all facts for one thread (after re-extraction). */
  replaceThreadFacts({ chatJid, chatName = null, threadStart, threadEnd, facts }) {
    this._db.prepare('DELETE FROM thread_facts WHERE chat_jid = ? AND thread_start = ?').run(chatJid, threadStart);
    if (!facts?.length) return 0;
    const ins = this._db.prepare(`
      INSERT INTO thread_facts (chat_jid, chat_name, thread_start, thread_end, fact_type, payload_json, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let n = 0;
    for (const f of facts) {
      const factType = String(f.type || 'other').slice(0, 64);
      const payload = JSON.stringify(f);
      const st = f.search_text ? String(f.search_text) : buildSearchText(f);
      ins.run(chatJid, chatName, threadStart, threadEnd, factType, payload, st);
      n++;
    }
    return n;
  }

  searchFacts(query, chatJid = null, limit = 15) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 15, 100));
    const cleaned = this._toFtsQuery(query);
    if (!cleaned) return [];
    return this._db.prepare(`
      SELECT tf.id, tf.chat_jid AS chatJid, tf.chat_name AS chatName,
             tf.thread_start AS threadStart, tf.thread_end AS threadEnd,
             tf.fact_type AS factType, tf.payload_json AS payloadJson,
             bm25(thread_facts_fts) AS rank
      FROM thread_facts_fts
      INNER JOIN thread_facts tf ON tf.id = thread_facts_fts.rowid
      WHERE thread_facts_fts MATCH ?
        AND (? IS NULL OR tf.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(cleaned, chatJid, chatJid, safeLimit);
  }

  clearAllThreadFacts() {
    const c = this._db.prepare('SELECT COUNT(*) AS n FROM thread_facts').get()?.n || 0;
    this._db.prepare('DELETE FROM thread_facts').run();
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
    return this._db.prepare(`
      SELECT ts.id, ts.chat_jid AS chatJid, ts.chat_name AS chatName,
             ts.thread_start AS threadStart, ts.thread_end AS threadEnd,
             ts.summary, ts.message_count AS messageCount,
             bm25(thread_summaries_fts) AS rank
      FROM thread_summaries_fts
      INNER JOIN thread_summaries ts ON ts.id = thread_summaries_fts.rowid
      WHERE thread_summaries_fts MATCH ?
        AND (? IS NULL OR ts.chat_jid = ?)
      ORDER BY rank LIMIT ?
    `).all(cleaned, chatJid, chatJid, safeLimit);
  }

  clearAllThreadSummaries() {
    const count = this._db.prepare('SELECT COUNT(*) AS c FROM thread_summaries').get()?.c || 0;
    this._db.prepare('DELETE FROM thread_summaries').run();
    try {
      this._db.exec("INSERT INTO thread_summaries_fts(thread_summaries_fts) VALUES('rebuild')");
    } catch (err) {
      console.error('[DB] FTS rebuild after thread summary clear failed:', err.message);
    }
    this.clearAllThreadFacts();
    return count;
  }

  deleteChat(chatJid) {
    const msgCount = this._db.prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_jid = ?').get(chatJid)?.c || 0;
    this._db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
    this._db.prepare('DELETE FROM daily_summaries WHERE chat_jid = ?').run(chatJid);
    this._db.prepare('DELETE FROM thread_summaries WHERE chat_jid = ?').run(chatJid);
    this._db.prepare('DELETE FROM thread_facts WHERE chat_jid = ?').run(chatJid);
    try {
      this._db.prepare('DELETE FROM chat_action_items WHERE chat_jid = ?').run(chatJid);
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

  close() {
    this._db.close();
  }
}
