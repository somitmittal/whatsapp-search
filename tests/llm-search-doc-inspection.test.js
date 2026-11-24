import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { heuristicDecompose } from '../src/gpt/query-decomposer.js';
import { createToolbox, TOOL_SPECS } from '../src/gpt/tools.js';
import { parseToolCalls } from '../src/gpt/agent.js';
import { defaultPaddleOcr } from '../src/ocr/paddle-ocr.js';

describe('LLM Search & Document Inspection Harness', () => {
  let dbPath;
  let db;

  beforeEach(() => {
    dbPath = join(tmpdir(), `test-doc-inspect-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL DEFAULT 0,
        message_id TEXT NOT NULL UNIQUE,
        chat_jid TEXT NOT NULL,
        chat_name TEXT,
        sender TEXT,
        text TEXT,
        media_type TEXT,
        media_path TEXT,
        media_caption TEXT,
        media_ai_index TEXT,
        media_index_status TEXT,
        media_index_error TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        text, sender, chat_name, media_caption, media_ai_index,
        content='messages', content_rowid='id'
      );
      CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
        VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
      END;
      CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text, sender, chat_name, media_caption, media_ai_index)
        VALUES ('delete', old.id, old.text, old.sender, old.chat_name, old.media_caption, old.media_ai_index);
        INSERT INTO messages_fts(rowid, text, sender, chat_name, media_caption, media_ai_index)
        VALUES (new.id, new.text, new.sender, new.chat_name, new.media_caption, new.media_ai_index);
      END;
    `);

    db.getMessagesByRowIds = function (ids) {
      const list = (ids || []).map(Number).filter(Number.isFinite);
      if (!list.length) return [];
      const placeholders = list.map(() => '?').join(',');
      return db.prepare(`SELECT * FROM messages WHERE id IN (${placeholders})`).all(...list);
    };

    db.searchMessages = function (query, chatJid = null, limit = 10) {
      return db.prepare(`SELECT * FROM messages WHERE text LIKE ? OR media_caption LIKE ? OR media_ai_index LIKE ? LIMIT ?`)
        .all(`%${query}%`, `%${query}%`, `%${query}%`, limit);
    };

    db.updateMediaIndexResult = function (messageId, { text, status }) {
      db.prepare(`UPDATE messages SET media_ai_index = ?, media_index_status = ? WHERE message_id = ?`)
        .run(text, status, messageId);
    };
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('Taxonomic Query Decomposer', () => {
    it('expands manicure and pedicure into nail care and hands & feet parent categories', () => {
      const decomposed = heuristicDecompose('can u check the manicure and pedicure prices');
      expect(decomposed.lexicalQueries).toContain('manicure');
      expect(decomposed.lexicalQueries).toContain('pedicure');
      expect(decomposed.lexicalQueries).toContain('nail care');
      expect(decomposed.lexicalQueries).toContain('nail services');
      expect(decomposed.lexicalQueries.some((q) => q.includes('hands'))).toBe(true);
      expect(decomposed.lexicalQueries).toContain('price');
    });

    it('expands hair styling services into category and styling synonyms', () => {
      const decomposed = heuristicDecompose('how much for a haircut and beard trim?');
      expect(decomposed.lexicalQueries).toContain('hair styling');
      expect(decomposed.lexicalQueries).toContain('hair care');
      expect(decomposed.lexicalQueries).toContain('haircut');
    });
  });

  describe('Agent inspect_document Tool', () => {
    it('is registered in TOOL_SPECS and parsed by parseToolCalls', () => {
      const spec = TOOL_SPECS.find((t) => t.name === 'inspect_document');
      expect(spec).toBeDefined();
      expect(spec.about).toMatch(/inspect and read/i);

      const parsed = parseToolCalls('CALL {"tool":"inspect_document","args":{"message":"m87577"}}');
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('inspect_document');
      expect(parsed[0].args.message).toBe('m87577');
    });

    it('reads pre-indexed document text and returns citable message handle', async () => {
      const mockDir = {
        resolve: () => ({ chatJid: 'salon@s.whatsapp.net', chatName: 'Krisumi Spa And Salon' }),
      };

      db.prepare(`
        INSERT INTO messages (id, message_id, chat_jid, chat_name, sender, text, media_type, media_path, media_caption, media_ai_index, media_index_status, timestamp)
        VALUES (87577, 'MSG_SALON_01', 'salon@s.whatsapp.net', 'Krisumi Spa And Salon', 'Salon', '10_April_KRISUMI_SALON_Vj.pdf', 'document', '/tmp/nonexistent.pdf', '10_April_KRISUMI_SALON_Vj.pdf', '[Page 4] NAIL CARE Express Manicure ₹350 · Express Pedicure ₹400', 'indexed', 1700000000)
      `).run();

      const toolbox = createToolbox({ db, directory: mockDir });
      const res = await toolbox.inspect_document({ message: 'm87577' }, 2000, {});

      expect(res.text).toContain('NAIL CARE');
      expect(res.text).toContain('Express Manicure ₹350');
      expect(res.messages).toHaveLength(1);
      expect(res.messages[0].id).toBe(87577);
    });

    it('extracts OCR on the fly if document is not yet indexed', async () => {
      const testFile = join(tmpdir(), `test-doc-${Date.now()}.txt`);
      writeFileSync(testFile, 'Nail Bar Price List: Classic Manicure 500 Rs, Deluxe Pedicure 800 Rs');

      db.prepare(`
        INSERT INTO messages (id, message_id, chat_jid, chat_name, sender, text, media_type, media_path, media_caption, media_ai_index, media_index_status, timestamp)
        VALUES (87578, 'MSG_SALON_02', 'salon@s.whatsapp.net', 'Krisumi Spa And Salon', 'Salon', 'price_list.txt', 'document', ?, 'price_list.txt', 'price_list.txt', 'pending', 1700000000)
      `).run(testFile);

      const mockDir = {
        resolve: () => ({ chatJid: 'salon@s.whatsapp.net', chatName: 'Krisumi Spa And Salon' }),
      };

      const toolbox = createToolbox({ db, directory: mockDir });
      const res = await toolbox.inspect_document({ message: '87578' }, 2000, {});

      expect(res.messages).toHaveLength(1);
      expect(res.text).toContain('Document Content:');

      if (existsSync(testFile)) unlinkSync(testFile);
    });
  });
});
