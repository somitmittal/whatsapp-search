import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'wa-fts-triggers-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');

const GROUP = '120363000000000001@g.us';
const LEGACY_TRIGGERS = `
  DROP TRIGGER IF EXISTS messages_au;
  DROP TRIGGER IF EXISTS messages_ad;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.id);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid) VALUES('delete', old.id);
    INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
    VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
  END;
`;

function ftsIntact(db) {
  try {
    db._db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)");
    return true;
  } catch {
    return false;
  }
}

function ftsHits(db, query) {
  return db._db.prepare('SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH ?').get(query).c;
}

let db;
beforeAll(() => {
  const seed = new Database();
  seed.insertMessageBatch(Array.from({ length: 40 }, (_, i) => ({
    messageId: `m-${i}`,
    chatJid: GROUP,
    chatName: 'Old Site Name',
    sender: 'Asha',
    text: `cement delivery note ${i}`,
    timestamp: 1_700_000_000 + i,
  })));
  // Simulate a database created before the trigger fix, then corrupted by a rename.
  seed._db.exec(LEGACY_TRIGGERS);
  seed._db.prepare('UPDATE messages SET chat_name = ? WHERE chat_jid = ?').run('Renamed Once', GROUP);
  expect(ftsIntact(seed)).toBe(false);
  seed.close();
  db = new Database();
});
afterAll(() => {
  db?.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('messages_fts trigger migration', () => {
  test('rebuilds an index left inconsistent by the legacy triggers', () => {
    expect(ftsIntact(db)).toBe(true);
  });

  test('scopes the update trigger to indexed columns', () => {
    const sql = db._db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages_au'").get().sql;
    expect(sql).toMatch(/AFTER UPDATE OF text, sender, chat_name, media_caption, media_ai_index/);
  });

  test('keeps the index consistent through renames, edits and deletes', () => {
    db.propagateChatDisplayName(GROUP, 'Tower B Site');
    db._db.prepare("UPDATE messages SET text = 'scaffolding invoice' WHERE message_id = 'm-3'").run();
    db._db.prepare("DELETE FROM messages WHERE message_id = 'm-39'").run();
    expect(ftsIntact(db)).toBe(true);
    expect(ftsHits(db, 'scaffolding')).toBe(1);
    expect(ftsHits(db, 'chat_name:Tower')).toBe(39);
    expect(ftsHits(db, 'chat_name:Renamed')).toBe(0);
  });
});

describe('propagateChatDisplayName', () => {
  test('rewrites only rows whose name actually changes', () => {
    expect(db.propagateChatDisplayName(GROUP, 'Tower C Site')).toBe(39);
    expect(db.propagateChatDisplayName(GROUP, 'Tower C Site')).toBe(0);
  });
});
