import { describe, it, expect } from '@jest/globals';
import { contextualizeQuery, heuristicDecompose } from '../src/gpt/query-decomposer.js';
import { parseToolCalls } from '../src/gpt/agent.js';
import { messageBody } from '../src/gpt/retrieval.js';
import Database from '../src/storage/database.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Production-Grade RAG: Conversational Contextualization & Tool Calling', () => {
  it('resolves retry intents ("try again") to the last substantive user prompt', () => {
    const prior = [
      { role: 'user', content: 'find latest financial report' },
      { role: 'assistant', content: 'I checked 5 messages...' },
    ];
    const res = contextualizeQuery('try again', { prior, scopeChatName: 'Sovrenn' });
    expect(res.isRetry).toBe(true);
    expect(res.effectiveQuery).toBe('find latest financial report');
    expect(res.intent.modality).toBe('document');
    expect(res.intent.candidateEntities).toContain('Sovrenn');
  });

  it('decomposes structured media requests (modality, recency, fileExt, outboundOnly)', () => {
    const intent = heuristicDecompose('find the latest pdf i sent in this group');
    expect(intent.modality).toBe('document');
    expect(intent.fileExt).toBe('pdf');
    expect(intent.recency).toBe('latest');
    expect(intent.outboundOnly).toBe(true);
    expect(intent.lexicalQueries).not.toContain('pdf');
    expect(intent.lexicalQueries).not.toContain('latest');
  });

  it('formats message body to preserve file names for document messages', () => {
    const msg = {
      mediaType: 'document',
      mediaPath: '/data/documents/SME_Top_5_Investment_Research_Nov_2026.pdf',
      text: '',
    };
    const body = messageBody(msg);
    expect(body).toContain('SME_Top_5_Investment_Research_Nov_2026.pdf');
    expect(body).toContain('[document]');
  });

  it('parses XML and pseudo-token tool calls without crashing or looping', () => {
    const sampleXml = '<dots_function_call>{"name":"search","args":{"query":"quarterly results","chat":"Sovrenn"}}</dots_function_call>';
    const calls = parseToolCalls(sampleXml);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('search');
    expect(calls[0].args.query).toBe('quarterly results');
    expect(calls[0].args.chat).toBe('Sovrenn');
  });
});

describe('Database: Structured Media Retrieval', () => {
  let db;
  let testDir;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'rag-test-'));
    process.env.DATA_DIR = testDir;
    db = new Database();
  });

  afterEach(() => {
    try {
      db.close();
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('retrieves recent media messages ordered by timestamp DESC filtered by mediaType and fileExt', () => {
    runWithTenant('tenant_default', () => {
      const now = Math.floor(Date.now() / 1000);
      const chatJid = 'sovrenn@g.us';

      // Insert older image
      db.insertMessage({
        messageId: 'msg_img_1',
        chatJid,
        chatName: 'Sovrenn',
        sender: 'Alice',
        text: 'Chart screenshot',
        mediaType: 'image',
        mediaPath: '/media/chart1.jpg',
        timestamp: now - 200,
      });

      // Insert older doc
      db.insertMessage({
        messageId: 'msg_doc_old',
        chatJid,
        chatName: 'Sovrenn',
        sender: 'You',
        text: 'Old document',
        mediaType: 'document',
        mediaPath: '/media/old_doc.docx',
        timestamp: now - 100,
      });

      // Insert newest PDF
      db.insertMessage({
        messageId: 'msg_doc_pdf',
        chatJid,
        chatName: 'Sovrenn',
        sender: 'You',
        text: 'Research PDF',
        mediaType: 'document',
        mediaPath: '/media/SME_Top_5_Investment_Research_Nov_2026.pdf',
        timestamp: now - 10,
      });

      // Test querying latest PDF
      const pdfResults = db.getRecentMediaMessages({
        chatJid,
        mediaType: 'document',
        fileExt: 'pdf',
        limit: 5,
      });

      expect(pdfResults.length).toBe(1);
      expect(pdfResults[0].messageId).toBe('msg_doc_pdf');
      expect(pdfResults[0].mediaType).toBe('document');
      expect(pdfResults[0].mediaPath).toContain('SME_Top_5_Investment_Research_Nov_2026.pdf');

      // Test querying all recent media
      const allMedia = db.getRecentMediaMessages({
        chatJid,
        limit: 10,
      });
      expect(allMedia.length).toBe(3);
      expect(allMedia[0].messageId).toBe('msg_doc_pdf'); // Newest first
    });
  });
});
