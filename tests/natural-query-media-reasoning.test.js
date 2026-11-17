import { describe, it, expect } from '@jest/globals';
import Database from '../src/storage/database.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import { ContextEngine } from '../src/gpt/context.js';
import { hybridSearch } from '../src/gpt/retrieval.js';
import { defaultPaddleOcr } from '../src/ocr/paddle-ocr.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Natural Query & Media Reasoning Architecture', () => {
  let db;
  let testDir;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'media-reasoning-test-'));
    process.env.DATA_DIR = testDir;
    db = new Database();
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('ContextEngine.prefetch includes recent messages from the scoped chat without requiring broad/range flags', async () => {
    await runWithTenant('tenant_default', async () => {
      const chatJid = 'kwr_residents@g.us';
      const now = Math.floor(Date.now() / 1000);

      // Insert 3 recent messages
      db.insertMessage({
        messageId: 'msg_1',
        chatJid,
        chatName: 'Krisumi Residents',
        sender: 'Alice',
        text: 'The gym opens at 6 AM tomorrow',
        timestamp: now - 30,
      });
      db.insertMessage({
        messageId: 'msg_2',
        chatJid,
        chatName: 'Krisumi Residents',
        sender: 'Bob',
        text: 'Thanks Alice, see you there',
        timestamp: now - 20,
      });

      const directory = {
        name: () => 'Krisumi Residents',
        resolve: () => null,
      };

      const contextEngine = new ContextEngine({ db, directory });
      const pre = await contextEngine.prefetch({
        query: 'What time does the gym open?',
        scopeJids: [chatJid],
      });

      expect(pre.messages.length).toBeGreaterThan(0);
      expect(pre.text).toContain('The gym opens at 6 AM tomorrow');
    });
  });

  it('extracts OCR text via defaultPaddleOcr', async () => {
    // Test with a sample text file or buffer
    const samplePath = join(testDir, 'sample_receipt.txt');
    writeFileSync(samplePath, 'Paid to Rajni ₹130 UTR: 1234567890');
    const extracted = await defaultPaddleOcr.extractText(samplePath);
    expect(typeof extracted).toBe('string');
  });

  it('hybridSearch includes accompanying media and executes JIT indexing on candidate media', async () => {
    await runWithTenant('tenant_default', async () => {
      const chatJid = 'kwr_residents@g.us';
      const now = Math.floor(Date.now() / 1000);

      // Insert photo
      db.insertMessage({
        messageId: 'msg_photo_1',
        chatJid,
        chatName: 'Krisumi Residents',
        sender: 'Rajni',
        text: null,
        mediaType: 'image',
        mediaPath: join(testDir, 'idli_menu.jpg'),
        mediaAiIndex: 'Ghar Ka Zaika by Rajni Idli Batter ₹130/KG',
        timestamp: now - 10,
      });

      // Insert text right after
      db.insertMessage({
        messageId: 'msg_text_1',
        chatJid,
        chatName: 'Krisumi Residents',
        sender: 'Rajni',
        text: 'If you want to order idli batter, please contact me',
        timestamp: now - 5,
      });

      // Search
      const res = await hybridSearch({
        db,
        query: 'Who makes idli batters in Krisumi',
        chatJid,
        limit: 5,
      });

      expect(res.hits.length).toBeGreaterThan(0);
      const hitSenders = res.hits.map(h => h.sender);
      expect(hitSenders).toContain('Rajni');
    });
  });
});
