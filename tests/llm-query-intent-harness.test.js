import { jest } from '@jest/globals';
import { decomposeQuery, heuristicDecompose } from '../src/gpt/query-decomposer.js';
import { hybridSearch } from '../src/gpt/retrieval.js';
import { createToolbox } from '../src/gpt/tools.js';
import Database from '../src/storage/database.js';
import MediaIndexService from '../src/search/media-index-service.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('LLM Query Intent & JIT Retrieval Harness', () => {
  describe('Query Decomposer', () => {
    it('heuristically strips conversational filler and detects modality/direction', () => {
      const intent = heuristicDecompose('search for the image where I sent t&C of bingetown');

      expect(intent.cleanedQuery).toContain('t&C of bingetown');
      expect(intent.cleanedQuery).not.toContain('search for the');
      expect(intent.modality).toBe('image');
      expect(intent.outboundOnly).toBe(true);
      expect(intent.lexicalQueries).toContain('terms conditions');
      expect(intent.lexicalQueries).toContain('thebingetown');
      expect(intent.semanticQueries).toContain('cancellation policy');
      expect(intent.semanticQueries).toContain('refundable advance');
      expect(intent.candidateEntities).toContain('bingetown');
    });

    it('detects document modality for pdf and invoice requests', () => {
      const intent = heuristicDecompose('please find the pdf invoice for cement');
      expect(intent.modality).toBe('document');
      expect(intent.cleanedQuery).toContain('invoice for cement');
    });

    it('uses LLM provider to extract structured search plan', async () => {
      const mockProvider = {
        name: 'test-llm',
        chat: jest.fn().mockResolvedValue(JSON.stringify({
          cleanedQuery: 'Binge Town cancellation policy',
          lexicalQueries: ['thebingetown', 'binge town', 'refundable advance'],
          semanticQueries: ['cancellation terms', '72 hrs refund'],
          modality: 'image',
          outboundOnly: true,
          candidateEntities: ['The Binge Town'],
          expandScopeIfEmpty: true,
        })),
      };

      const intent = await decomposeQuery('search for the image where I sent t&C of bingetown', {
        provider: mockProvider,
        currentChatName: 'Bhaiyao',
      });

      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
      expect(intent.cleanedQuery).toBe('Binge Town cancellation policy');
      expect(intent.modality).toBe('image');
      expect(intent.outboundOnly).toBe(true);
      expect(intent.candidateEntities).toContain('The Binge Town');
      expect(intent.lexicalQueries).toContain('thebingetown');
      expect(intent.semanticQueries).toContain('cancellation terms');
    });

    it('safely falls back to heuristic if provider fails or times out', async () => {
      const failingProvider = {
        name: 'failing-llm',
        chat: jest.fn().mockRejectedValue(new Error('Rate limit 429')),
      };

      const intent = await decomposeQuery('search for the image where I sent t&C of bingetown', {
        provider: failingProvider,
      });

      expect(intent.modality).toBe('image');
      expect(intent.outboundOnly).toBe(true);
      expect(intent.lexicalQueries).toContain('terms conditions');
    });
  });

  describe('JIT Media Indexing & Hybrid Multi-Query Search', () => {
    let db;
    let tmpDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'jit-test-'));
      db = new Database({ inMemory: true });
    });

    afterEach(() => {
      try { db.close(); } catch (_) {}
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    });

    it('runs on-demand OCR on candidate unindexed images during search', async () => {
      const tenantId = `tenant-jit-${Date.now()}`;
      await runWithTenant(tenantId, async () => {
        const imgPath = join(tmpDir, 'binge_booking.jpg');
        // Simulated image with booking details
        writeFileSync(
          imgPath,
          Buffer.from('JFIF\x00\x01\x01\x01\x00`\x00`\x00\x00The Binge Town Booking Summary Total ₹5799 Advance ₹750\n', 'utf8')
        );

        const chatJid = '918120294201-1564374962@g.us';
        const msgId = `WA_BINGE_${Date.now()}`;

        // Insert message with unindexed media
        db.insertMessageBatch([{
          messageId: msgId,
          chatJid,
          chatName: 'Bhaiyao',
          sender: 'You',
          text: '[image]',
          timestamp: 1731600000,
          mediaType: 'image',
          mediaPath: imgPath,
          mediaIndexStatus: null,
          mediaAiIndex: null,
        }]);

        // Verify unindexed query
        const unindexed = db.getUnindexedMediaForChat(chatJid, 5);
        expect(unindexed.length).toBe(1);
        expect(unindexed[0].messageId).toBe(msgId);

        const mediaService = new MediaIndexService({
          db,
          getProvider: () => null, // offline CPU PaddleOCR
        });

        // Run hybridSearch with mediaIndexService and image modality
        const res = await hybridSearch({
          db,
          embeddings: null,
          query: 'search for the image where I sent t&C of bingetown',
          chatJid,
          mediaIndexService: mediaService,
        });

        // The JIT on-demand OCR should have indexed the image and FTS should have matched it!
        expect(res.hits.length).toBeGreaterThanOrEqual(1);
        expect(res.hits[0].messageId).toBe(msgId);

        // Verify that message row in DB is now indexed
        const row = db._db.prepare('SELECT media_ai_index AS mediaAiIndex, media_index_status AS mediaIndexStatus FROM messages WHERE tenant_id = ? AND message_id = ?').get(tenantId, msgId);
        expect(row.mediaIndexStatus).toBe('indexed');
        expect(row.mediaAiIndex).toContain('Binge Town');
      });
    });

    it('falls back to candidate entity chat when scoped chat has no matches', async () => {
      const tenantId = `tenant-fallback-${Date.now()}`;
      await runWithTenant(tenantId, async () => {
        const bhaiJid = '918120294201-1564374962@g.us';
        const bingeJid = '108319259758724@lid';

        // In Bhaiyao: unrelated chat
        db.insertMessageBatch([{
          messageId: 'M_BHAI_1',
          chatJid: bhaiJid,
          chatName: 'Bhaiyao',
          sender: 'You',
          text: 'Hello bhai kya haal h',
          timestamp: 1731500000,
        }]);

        // In The Binge Town: the actual cancellation rules
        db.insertMessageBatch([{
          messageId: 'M_BINGE_1',
          chatJid: bingeJid,
          chatName: 'The Binge Town',
          sender: 'The Binge Town',
          text: 'You need to pay Rs 750 advance to book. This advance is refundable if you cancel at least 72 hrs before.',
          timestamp: 1731510000,
        }]);

        const mockDirectory = {
          resolve: (ref) => {
            const r = String(ref).toLowerCase();
            if (r.includes('bhai')) return { chatJid: bhaiJid, chatName: 'Bhaiyao' };
            if (r.includes('binge')) return { chatJid: bingeJid, chatName: 'The Binge Town' };
            return null;
          },
        };

        const toolbox = createToolbox({
          db,
          embeddings: null,
          directory: mockDirectory,
        });

        // Search scoped to Bhaiyao for "t&C of bingetown"
        const result = await toolbox.search({
          query: 't&C of bingetown',
          chat: 'Bhaiyao',
        }, 2000);

        // Should fall back and return the Binge Town cancellation policy!
        expect(result.messages.length).toBeGreaterThanOrEqual(1);
        expect(result.messages[0].messageId).toBe('M_BINGE_1');
        expect(result.text).toContain('refundable');
        expect(result.text).toContain('Note: No matches in "Bhaiyao"');
      });
    });
  });
});
