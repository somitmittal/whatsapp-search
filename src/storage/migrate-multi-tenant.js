/**
 * Shared SQLite + row-level tenant isolation (tenant_id on all user data).
 * Idempotent; safe to run on every Database open.
 */
import { LEGACY_TENANT_ID } from './tenant-constants.js';

const MT_KEY = 'mt_v4_tenant_rows';
const MT_KEY_AWAY = 'mt_v5_chat_last_seen';
const MT_KEY_CONTACTS = 'mt_v6_contact_directory';

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col);
  } catch {
    return false;
  }
}

function isComplete(db) {
  try {
    const row = db.prepare(`SELECT value FROM schema_migrations WHERE key = ?`).get(MT_KEY);
    return row?.value === '1';
  } catch {
    return false;
  }
}

function markComplete(db) {
  db.prepare(`INSERT OR REPLACE INTO schema_migrations (key, value) VALUES (?, '1')`).run(MT_KEY);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function migrateMultiTenant(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS tenant_settings (
      tenant_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (tenant_id, key)
    );
  `);

  if (isComplete(db)) return;

  const run = db.transaction(() => {
    if (!hasColumn(db, 'messages', 'tenant_id')) {
      rebuildMessagesTable(db);
      rebuildDailySummariesTable(db);
      rebuildThreadSummariesTable(db);
      rebuildChatActionItemsTable(db);
      addTenantToThreadFacts(db);
    }

    try {
      const n = db.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='settings'`).get()?.c;
      if (n) {
        db.prepare(`
          INSERT OR IGNORE INTO tenant_settings (tenant_id, key, value)
          SELECT ?, key, value FROM settings
        `).run(LEGACY_TENANT_ID);
      }
    } catch { /* */ }

    rebuildFtsAux(db);
    markComplete(db);
  });

  run();
  console.log('[DB] Multi-tenant migration applied (' + MT_KEY + ').');
}

/**
 * Per-tenant “last seen” marker for “while you were away” summaries.
 * Safe to run on every open.
 */
export function migrateAwaySummaries(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_last_seen (
      tenant_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      last_seen_ts INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_last_seen_tenant ON chat_last_seen(tenant_id);
  `);
  try {
    const row = db.prepare(`SELECT value FROM schema_migrations WHERE key = ?`).get(MT_KEY_AWAY);
    if (row?.value === '1') return;
  } catch { /* ignore */ }
  try {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations (key, value) VALUES (?, '1')`).run(MT_KEY_AWAY);
  } catch { /* ignore */ }
}

/**
 * Per-tenant contact directory (hashed phone keys + encrypted names at rest).
 * Safe to run on every open.
 */
export function migrateContactDirectory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_directory (
      tenant_id TEXT NOT NULL,
      phone_hash TEXT NOT NULL,
      enc_name TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (tenant_id, phone_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_contact_directory_tenant ON contact_directory(tenant_id);
  `);
  try {
    const row = db.prepare(`SELECT value FROM schema_migrations WHERE key = ?`).get(MT_KEY_CONTACTS);
    if (row?.value === '1') return;
  } catch { /* ignore */ }
  try {
    db.prepare(`INSERT OR REPLACE INTO schema_migrations (key, value) VALUES (?, '1')`).run(MT_KEY_CONTACTS);
  } catch { /* ignore */ }
}

function rebuildFtsAux(db) {
  try {
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  } catch { /* */ }
  try {
    db.exec("INSERT INTO summaries_fts(summaries_fts) VALUES('rebuild')");
  } catch { /* */ }
  try {
    db.exec("INSERT INTO thread_summaries_fts(thread_summaries_fts) VALUES('rebuild')");
  } catch { /* */ }
  try {
    db.exec("INSERT INTO thread_facts_fts(thread_facts_fts) VALUES('rebuild')");
  } catch { /* */ }
}

function rebuildMessagesTable(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    DROP TABLE IF EXISTS messages_fts;
  `);

  db.exec(`ALTER TABLE messages RENAME TO messages_old`);

  const oldCols = db.prepare(`PRAGMA table_info(messages_old)`).all();
  const oldNames = oldCols.map((c) => c.name).filter((n) => n !== 'tenant_id');
  const ddlParts = [
    'id INTEGER PRIMARY KEY AUTOINCREMENT',
    'tenant_id TEXT NOT NULL',
  ];
  for (const c of oldCols) {
    if (c.name === 'id' || c.name === 'tenant_id') continue;
    let part = `"${c.name}" ${c.type || 'TEXT'}`;
    if (String(c.name) === 'chat_jid' || String(c.name) === 'timestamp') part += ' NOT NULL';
    ddlParts.push(part);
  }
  ddlParts.push('UNIQUE(tenant_id, message_id)');
  db.exec(`CREATE TABLE messages (${ddlParts.join(',')});`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_tenant_chat ON messages(tenant_id, chat_jid);`);

  const selectList = oldNames.map((n) => `o."${n}"`).join(', ');
  const insertCols = ['tenant_id', ...oldNames].join(', ');
  db.exec(`
    INSERT INTO messages (${insertCols})
    SELECT '${LEGACY_TENANT_ID}', ${selectList}
    FROM messages_old o
  `);
  db.exec(`DROP TABLE messages_old`);

  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      text, sender, chat_name, media_caption, media_ai_index,
      content='messages', content_rowid='id',
      tokenize='porter unicode61'
    );
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
}

function rebuildDailySummariesTable(db) {
  if (!tableExists(db, 'daily_summaries')) return;
  db.exec(`
    DROP TRIGGER IF EXISTS summaries_ai;
    DROP TRIGGER IF EXISTS summaries_ad;
    DROP TRIGGER IF EXISTS summaries_au;
    DROP TABLE IF EXISTS summaries_fts;
  `);
  db.exec(`ALTER TABLE daily_summaries RENAME TO daily_summaries_old`);
  db.exec(`
    CREATE TABLE daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      chat_name TEXT,
      date TEXT NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, chat_jid, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_summaries_tenant ON daily_summaries(tenant_id);
  `);
  const oldCols = db.prepare(`PRAGMA table_info(daily_summaries_old)`).all().map((c) => c.name);
  const selectList = oldCols.map((n) => `o."${n}"`).join(', ');
  const insertCols = ['tenant_id', ...oldCols].join(', ');
  db.exec(`
    INSERT INTO daily_summaries (${insertCols})
    SELECT '${LEGACY_TENANT_ID}', ${selectList}
    FROM daily_summaries_old o
  `);
  db.exec(`DROP TABLE daily_summaries_old`);
  db.exec(`
    CREATE VIRTUAL TABLE summaries_fts USING fts5(
      summary, chat_name, date,
      content='daily_summaries', content_rowid='id',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER summaries_ai AFTER INSERT ON daily_summaries BEGIN
      INSERT INTO summaries_fts(rowid, summary, chat_name, date)
      VALUES (new.id, new.summary, new.chat_name, new.date);
    END;
    CREATE TRIGGER summaries_ad AFTER DELETE ON daily_summaries BEGIN
      INSERT INTO summaries_fts(summaries_fts, rowid) VALUES('delete', old.id);
    END;
    CREATE TRIGGER summaries_au AFTER UPDATE ON daily_summaries BEGIN
      INSERT INTO summaries_fts(summaries_fts, rowid) VALUES('delete', old.id);
      INSERT INTO summaries_fts(rowid, summary, chat_name, date)
      VALUES (new.id, new.summary, new.chat_name, new.date);
    END;
  `);
}

function rebuildThreadSummariesTable(db) {
  if (!tableExists(db, 'thread_summaries')) return;
  db.exec(`
    DROP TRIGGER IF EXISTS thread_summaries_ai;
    DROP TRIGGER IF EXISTS thread_summaries_ad;
    DROP TRIGGER IF EXISTS thread_summaries_au;
    DROP TABLE IF EXISTS thread_summaries_fts;
  `);
  db.exec(`ALTER TABLE thread_summaries RENAME TO thread_summaries_old`);
  db.exec(`
    CREATE TABLE thread_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      chat_name TEXT,
      thread_start INTEGER NOT NULL,
      thread_end INTEGER NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(tenant_id, chat_jid, thread_start)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_summaries_tenant ON thread_summaries(tenant_id);
  `);
  const oldCols = db.prepare(`PRAGMA table_info(thread_summaries_old)`).all().map((c) => c.name);
  const selectList = oldCols.map((n) => `o."${n}"`).join(', ');
  const insertCols = ['tenant_id', ...oldCols].join(', ');
  db.exec(`
    INSERT INTO thread_summaries (${insertCols})
    SELECT '${LEGACY_TENANT_ID}', ${selectList}
    FROM thread_summaries_old o
  `);
  db.exec(`DROP TABLE thread_summaries_old`);
  db.exec(`
    CREATE VIRTUAL TABLE thread_summaries_fts USING fts5(
      summary, chat_name,
      content='thread_summaries', content_rowid='id',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER thread_summaries_ai AFTER INSERT ON thread_summaries BEGIN
      INSERT INTO thread_summaries_fts(rowid, summary, chat_name)
      VALUES (new.id, new.summary, new.chat_name);
    END;
    CREATE TRIGGER thread_summaries_ad AFTER DELETE ON thread_summaries BEGIN
      INSERT INTO thread_summaries_fts(thread_summaries_fts, rowid) VALUES('delete', old.id);
    END;
    CREATE TRIGGER thread_summaries_au AFTER UPDATE ON thread_summaries BEGIN
      INSERT INTO thread_summaries_fts(thread_summaries_fts, rowid) VALUES('delete', old.id);
      INSERT INTO thread_summaries_fts(rowid, summary, chat_name)
      VALUES (new.id, new.summary, new.chat_name);
    END;
  `);
}

function rebuildChatActionItemsTable(db) {
  if (!tableExists(db, 'chat_action_items')) {
    db.exec(`
      CREATE TABLE chat_action_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        items_json TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(tenant_id, chat_jid, source_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_action_items_tenant ON chat_action_items(tenant_id);
    `);
    return;
  }
  if (!hasColumn(db, 'chat_action_items', 'tenant_id')) {
    db.exec(`ALTER TABLE chat_action_items RENAME TO chat_action_items_old`);
    db.exec(`
      CREATE TABLE chat_action_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        items_json TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(tenant_id, chat_jid, source_message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chat_action_items_tenant ON chat_action_items(tenant_id);
    `);
    const oldCols = db.prepare(`PRAGMA table_info(chat_action_items_old)`).all().map((c) => c.name);
    const selectList = oldCols.map((n) => `o."${n}"`).join(', ');
    const insertCols = ['tenant_id', ...oldCols].join(', ');
    db.exec(`
      INSERT INTO chat_action_items (${insertCols})
      SELECT '${LEGACY_TENANT_ID}', ${selectList}
      FROM chat_action_items_old o
    `);
    db.exec(`DROP TABLE chat_action_items_old`);
  }
}

function addTenantToThreadFacts(db) {
  if (!tableExists(db, 'thread_facts')) return;
  if (hasColumn(db, 'thread_facts', 'tenant_id')) return;
  db.exec(`
    DROP TRIGGER IF EXISTS thread_facts_ai;
    DROP TRIGGER IF EXISTS thread_facts_ad;
    DROP TRIGGER IF EXISTS thread_facts_au;
    DROP TABLE IF EXISTS thread_facts_fts;
  `);
  db.exec(`ALTER TABLE thread_facts RENAME TO thread_facts_old`);
  db.exec(`
    CREATE TABLE thread_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      chat_name TEXT,
      thread_start INTEGER NOT NULL,
      thread_end INTEGER NOT NULL,
      fact_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      search_text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_facts_tenant ON thread_facts(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_thread_facts_chat_thread ON thread_facts(chat_jid, thread_start);
  `);
  const oldCols = db.prepare(`PRAGMA table_info(thread_facts_old)`).all().map((c) => c.name);
  const selectList = oldCols.map((n) => `o."${n}"`).join(', ');
  const insertCols = ['tenant_id', ...oldCols].join(', ');
  db.exec(`
    INSERT INTO thread_facts (${insertCols})
    SELECT '${LEGACY_TENANT_ID}', ${selectList}
    FROM thread_facts_old o
  `);
  db.exec(`DROP TABLE thread_facts_old`);
  db.exec(`
    CREATE VIRTUAL TABLE thread_facts_fts USING fts5(
      search_text, fact_type, chat_name,
      content='thread_facts', content_rowid='id',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER thread_facts_ai AFTER INSERT ON thread_facts BEGIN
      INSERT INTO thread_facts_fts(rowid, search_text, fact_type, chat_name)
      VALUES (new.id, new.search_text, new.fact_type, COALESCE(new.chat_name, ''));
    END;
    CREATE TRIGGER thread_facts_ad AFTER DELETE ON thread_facts BEGIN
      INSERT INTO thread_facts_fts(thread_facts_fts, rowid) VALUES('delete', old.id);
    END;
    CREATE TRIGGER thread_facts_au AFTER UPDATE ON thread_facts BEGIN
      INSERT INTO thread_facts_fts(thread_facts_fts, rowid) VALUES('delete', old.id);
      INSERT INTO thread_facts_fts(rowid, search_text, fact_type, chat_name)
      VALUES (new.id, new.search_text, new.fact_type, COALESCE(new.chat_name, ''));
    END;
  `);
}

function tableExists(db, name) {
  const n = db.prepare(
    `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(name)?.c;
  return n > 0;
}
