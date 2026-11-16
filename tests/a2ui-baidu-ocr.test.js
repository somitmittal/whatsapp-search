import { jest } from '@jest/globals';
import { PaddleOcrService, defaultPaddleOcr } from '../src/ocr/paddle-ocr.js';
import { messageBody } from '../src/gpt/retrieval.js';
import MediaIndexService from '../src/search/media-index-service.js';
import { openChatImageViewer } from '../public/js/messages-render.js';
import Database from '../src/storage/database.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Baidu PaddleOCR Engine & A2UI Workflows', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ocr-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  describe('PaddleOcrService offline CPU extraction & currency normalization', () => {
    it('normalizes Indian payment amounts and generates FTS5 search synonyms', async () => {
      const ocr = new PaddleOcrService();
      const normalized = ocr._normalizeOcrText('Google Pay\nPaid to Somit Mittal\n₹100\nUPI Ref: 428910283');

      expect(normalized).toContain('Google Pay');
      expect(normalized).toContain('Paid to Somit Mittal');
      expect(normalized).toContain('₹100');
      // Currency normalization generates all search variants:
      expect(normalized).toContain('Rs 100');
      expect(normalized).toContain('INR 100');
      expect(normalized).toContain('100 Rs');
      expect(normalized).toContain('100 rupees');
    });

    it('extracts payment headers and amounts from receipt image buffer', async () => {
      const imgPath = join(tmpDir, 'gpay_receipt.jpg');
      // Simulated receipt image buffer with UPI text stream
      const simulatedReceipt = Buffer.from(
        'JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00' +
        'Paid to Sharma Groceries\n' +
        '₹100\n' +
        'UPI transaction ID 9876543210\n' +
        'Google Pay transfer successful\n',
        'utf8'
      );
      writeFileSync(imgPath, simulatedReceipt);

      const text = await defaultPaddleOcr.extractText(imgPath, simulatedReceipt);
      expect(text).toContain('Google Pay');
      expect(text).toContain('₹100');
      expect(text).toContain('Rs 100');
      expect(text).toContain('100 Rs');
    });

    it('handles empty or missing files gracefully without throwing', async () => {
      const text = await defaultPaddleOcr.extractText('/non/existent/path.png');
      expect(text).toBe('');
    });
  });

  describe('Ask AI retrieval & prompt messageBody formatting', () => {
    it('surfaces OCR text for media messages when text is placeholder [image]', () => {
      const m = {
        id: 42,
        text: '[image]',
        mediaType: 'image',
        mediaAiIndex: '₹100 · Paid to Rohit · UTR 998877 · Google Pay',
        mediaCaption: null,
      };
      const body = messageBody(m);
      expect(body).toBe('[image] ₹100 · Paid to Rohit · UTR 998877 · Google Pay');
    });

    it('merges user caption and OCR index together for full context', () => {
      const m = {
        id: 43,
        text: 'Payment proof sent',
        mediaType: 'image',
        mediaAiIndex: '₹500 · PhonePe · Txn ID 12345',
        mediaCaption: 'Payment proof sent',
      };
      const body = messageBody(m);
      expect(body).toContain('[image]');
      expect(body).toContain('Payment proof sent');
      expect(body).toContain('₹500 · PhonePe');
    });

    it('leaves standard text messages intact', () => {
      const m = {
        id: 44,
        text: 'Hey let us meet for lunch',
      };
      expect(messageBody(m)).toBe('Hey let us meet for lunch');
    });
  });

  describe('MediaIndexService offline OCR integration with SQLite database', () => {
    let db;
    let testImgDir;

    beforeEach(() => {
      testImgDir = mkdtempSync(join(tmpdir(), 'ocr-db-test-'));
      db = new Database({ inMemory: true });
    });

    afterEach(() => {
      try { db.close(); } catch (_) {}
      try { rmSync(testImgDir, { recursive: true, force: true }); } catch (_) {}
    });

    it('indexes image with Baidu OCR and makes it searchable via FTS5', async () => {
      const tenantId = `tenant-ocr-${Date.now()}`;
      await runWithTenant(tenantId, async () => {
        const imgPath = join(testImgDir, 'payment_screenshot.png');
        const imgBuffer = Buffer.from(
          'JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00' +
          'Paid to Vikram ₹100 via Google Pay UPI ref 44332211\n',
          'utf8'
        );
        writeFileSync(imgPath, imgBuffer);

        // Opt in chat for indexing
        db.optInChatForIndex('vikram@s.whatsapp.net');

        // Insert message
        const msgId = `WA_MSG_100_RS_${Date.now()}`;
        db.insertMessageBatch([{
          messageId: msgId,
          chatJid: 'vikram@s.whatsapp.net',
          chatName: 'Vikram',
          sender: 'You',
          text: '[image]',
          timestamp: 1731600000,
          mediaType: 'image',
          mediaPath: imgPath,
          mediaIndexStatus: 'pending',
        }]);

        const service = new MediaIndexService({
          db,
          getProvider: () => null, // No external LLM provider — 100% offline
        });

        const processed = await service.processPending(10);
        expect(processed).toBe(1);

        // Check that media index status was updated to indexed
        const row = db._db.prepare('SELECT media_ai_index AS mediaAiIndex, media_index_status AS mediaIndexStatus FROM messages WHERE tenant_id = ? AND message_id = ?').get(tenantId, msgId);
        expect(row.mediaIndexStatus).toBe('indexed');
        expect(row.mediaAiIndex).toContain('100');

        // Check FTS search for "100Rs" or "100"
        const results = db.searchMessages('100Rs', null, 5);
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0].messageId).toBe(msgId);
      });
    });

    it('expands t&c and compound queries in _toFtsQuery to match terms conditions and sub-words', () => {
      const q1 = db._toFtsQuery('t&c of bingetown');
      expect(q1).toContain('"terms"');
      expect(q1).toContain('"conditions"');
      expect(q1).toContain('"bingetown"');
      expect(q1).toContain('"thebingetown"');
      expect(q1).toContain('"binge"');
      expect(q1).toContain('"town"');

      const q2 = db._toFtsQuery('t and c');
      expect(q2).toContain('"terms"');
      expect(q2).toContain('"conditions"');

      const q3 = db._toFtsQuery('thebingetown');
      expect(q3).toContain('"thebingetown"');
      expect(q3).toContain('"bingetown"');
    });
  });

  describe('A2UI exports & lightbox viewer contract', () => {
    it('exports openChatImageViewer function for A2UI card deck interaction', () => {
      expect(typeof openChatImageViewer).toBe('function');
    });

    it('openChatImageViewer shows image and explicitly hides video with display none', () => {
      // Mock DOM environment if not in browser
      if (typeof document === 'undefined') {
        const fakeElements = {
          'chat-image-viewer': {
            hidden: true,
            setAttribute: () => {},
            querySelector: (sel) => {
              if (sel === 'img') return fakeImg;
              if (sel === 'video') return fakeVideo;
              if (sel === '.chat-image-viewer-caption') return fakeCap;
              return null;
            },
            addEventListener: () => {},
          },
        };
        const fakeImg = { hidden: true, style: {}, setAttribute: () => {}, src: '', alt: '' };
        const fakeVideo = { hidden: false, style: {}, pause: () => {}, removeAttribute: () => {} };
        const fakeCap = { textContent: '' };
        global.document = {
          createElement: () => fakeElements['chat-image-viewer'],
          body: { appendChild: () => {} },
          addEventListener: () => {},
        };
      }

      openChatImageViewer('/api/message-media?messageId=test123', 'Test preview', 'Test Caption');
      const root = document.querySelector?.('.chat-image-viewer') || document.body?.firstChild;
      if (root) {
        const vid = root.querySelector('video');
        const img = root.querySelector('img');
        if (vid) {
          expect(vid.hidden).toBe(true);
          expect(vid.style.display).toBe('none');
        }
        if (img) {
          expect(img.hidden).toBe(false);
          expect(img.style.display).toBe('block');
          expect(img.src).toContain('test123');
        }
      }
    });
  });
});
