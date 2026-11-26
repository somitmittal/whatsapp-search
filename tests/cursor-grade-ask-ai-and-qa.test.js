import { describe, expect, test } from '@jest/globals';
import Database from '../src/storage/database.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import ChatDirectory from '../src/gpt/chat-directory.js';
import { ContextEngine } from '../src/gpt/context.js';
import { hybridSearch, messageBody } from '../src/gpt/retrieval.js';
import { contextualizeQuery } from '../src/gpt/query-decomposer.js';
import { enforceGroundedAnswer } from '../src/search/grounding.js';
import { runAgent } from '../src/gpt/agent.js';
import { attachmentFilenameFromMessage } from '../src/web/media-filename.js';
import { displayChatTitle } from '../public/js/format.js';

describe('Cursor-grade Ask AI & QA bug fixes', () => {
  test('enforceGroundedAnswer preserves compound-word spacing like "Ultra Gloss Finish" from "Ultra GlossFinish"', () => {
    const source = '[m1] 26 Nov 26 · Bhaiyao: Mr.Shield Quotation :- Ultra GlossFinish(self healing) –₹599/- per sq. ft. (Replacement warranty 7 year)\nMatte Finish – ₹499per sq. ft.';
    const answer = 'Mr. Shield Quotation:\n- Ultra Gloss Finish (self healing): ₹599 per sq. ft. (Replacement Warranty: 7 years)\n- Matte Finish: ₹499 per sq. ft.';
    const res = enforceGroundedAnswer(answer, source, 'What are the Mr.Shield quotation prices?');
    expect(res.removed).toEqual([]);
    expect(res.text).toContain('Ultra Gloss Finish');
    expect(res.text).toContain('₹599');
  });

  test('contextualizeQuery carries prior topic for general referential follow-ups ("when was that shared?", "where is the job located?")', () => {
    const prior = [
      { role: 'user', content: 'Which company was Bright Money hiring for?' },
      { role: 'assistant', content: 'Bright Money was hiring for SDE II, SDE III in IIITM GWALIOR.' },
    ];
    for (const q of ['when was that shared?', 'where is the job located?', 'who else replied?', 'what was the final amount?']) {
      const res = contextualizeQuery(q, { prior });
      expect(res.isFollowUp).toBe(true);
      expect(res.effectiveQuery.toLowerCase()).toContain('bright money');
    }
  });

  test('hybridSearch reranks by full lexical coverage + recency and includes quoted reply context', async () => {
    const db = new Database({ inMemory: true });
    await runWithTenant('qa-rerank', async () => {
      const jid = '919876543210@s.whatsapp.net';
      db.insertMessage({ messageId: 'old1', chatJid: jid, chatName: 'Atul', sender: 'Atul', text: 'gold price is 58000', timestamp: 1690000000 });
      db.insertMessage({ messageId: 'dist1', chatJid: jid, chatName: 'Atul', sender: 'Atul', text: 'latest price list for halwa', timestamp: 1764000100 });
      db.insertMessage({ messageId: 'new1', chatJid: jid, chatName: 'Atul', sender: 'Atul', text: 'gold price is 78000', timestamp: 1764000000 });
      db.insertMessage({
        messageId: 'rep1',
        chatJid: jid,
        chatName: 'Atul',
        sender: 'You',
        text: 'confirmed 78000',
        timestamp: 1764000200,
        quotedPayload: JSON.stringify({ messageId: 'img1', sender: 'Atul', mediaType: 'image', text: 'Gold rate card' }),
      });

      const res = await hybridSearch({ db, embeddings: null, query: 'latest gold price', chatJid: jid, limit: 5 });
      expect(res.hits[0].messageId).toBe('new1');
      const repRow = res.messages.find((m) => m.messageId === 'rep1');
      expect(messageBody(repRow)).toContain('[replying to Atul: Gold rate card]');
    });
  });

  test('ContextEngine puts Search results before recent unrelated timeline and anchors unscoped follow-ups', async () => {
    const db = new Database({ inMemory: true });
    await runWithTenant('qa-ctx-order', async () => {
      const jid = '919876543210@s.whatsapp.net';
      db.insertMessage({ messageId: 'm-gold', chatJid: jid, chatName: 'Atul Kumar Garg', sender: 'Atul Kumar Garg', text: '24k gold price today is 76500 per 10g', timestamp: 1700000100 });
      for (let i = 2; i <= 26; i++) {
        db.insertMessage({ messageId: `m-halwa-${i}`, chatJid: jid, chatName: 'Atul Kumar Garg', sender: 'Atul Kumar Garg', text: `Halwa order #${i} confirmed for evening`, timestamp: 1700000100 + i * 60 });
      }
      const dir = new ChatDirectory(db);
      const ctx = new ContextEngine({ db, embeddings: null, directory: dir });
      const pre = await ctx.prefetch({ query: 'can u check latest gold price', scopeJids: [jid] });
      expect(pre.text.indexOf('# Search results for the question')).toBeLessThan(pre.text.indexOf('# Active conversation'));
      expect(pre.text.indexOf('76500')).toBeLessThan(pre.text.indexOf('Halwa'));

      // Unscoped follow-up anchored via priorSourceJids + priorCitedMessages
      const goldRow = db.getMessagesPaginated(jid, 50, 0).find((m) => m.messageId === 'm-gold');
      const preFollowUp = await ctx.prefetch({
        query: 'Which company was Bright Money hiring for? when was that shared?',
        scopeJids: [],
        priorSourceJids: [jid],
        priorCitedMessages: [goldRow],
      });
      expect(preFollowUp.text).toContain('# Messages referenced in the previous answer');
      expect(preFollowUp.text).toContain('76500');
      expect(preFollowUp.text).not.toContain('Halwa order #25');
    });
  });

  test('runAgent deduplicates tool calls across steps and attributes source by token overlap when [m...] omitted', async () => {
    const prefetched = [
      { id: 101, messageId: 'cosx', chatJid: 'g@g.us', chatName: 'IIITM GWALIOR', sender: '+91 9988549219', text: 'CosX is hiring founding engineers', timestamp: 1704287940 },
      { id: 102, messageId: 'bright', chatJid: 'g@g.us', chatName: 'IIITM GWALIOR', sender: '+91 9424542227', text: 'Bright Money (Bangalore, Onsite) hiring SDE II and SDE III', timestamp: 1785417360 },
    ];
    const provider = {
      name: 'fake',
      model: 'fake',
      async *chatStream() {
        yield 'Bright Money in Bangalore is hiring for SDE II and SDE III.';
      },
    };
    const res = await runAgent({
      provider,
      system: 'test',
      history: [],
      contextText: '# Search results\n[m101] CosX\n[m102] Bright Money SDE II',
      query: 'Which company was Bright Money hiring for?',
      toolbox: {},
      ctx: { prefetched },
      emit: () => {},
    });
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources[0].ref).toBe('m102');
    expect(res.sources[0].sender).toBe('+91 9424542227');
  });

  test('Database resolves @lid chat titles via lid_pn_mappings, UI formats @lid cleanly, and download filename never duplicates', () => {
    const db = new Database({ inMemory: true });
    runWithTenant('qa-lid-fix', () => {
      db.saveLidPnMapping('167659098345499@lid', '447860004773@s.whatsapp.net');
      db.insertMessage({
        messageId: 'm-lid-1',
        chatJid: '167659098345499@lid',
        chatName: '167659098345499@lid',
        sender: '167659098345499@lid',
        text: 'Hello there',
        timestamp: 1764000000,
      });
      db.insertMessage({
        messageId: 'm-pn-with-lid-name',
        chatJid: '918279683435@s.whatsapp.net',
        chatName: '211050431549561@lid',
        sender: '211050431549561@lid',
        text: 'Hi from PN row',
        timestamp: 1764000100,
      });
      const stats = db.getChatStats();
      const row = stats.find((c) => c.chatJid === '167659098345499@lid');
      expect(row).toBeDefined();
      expect(row.chatName).not.toContain('@lid');
      expect(row.chatName).toContain('44');

      const pnRow = stats.find((c) => c.chatJid === '918279683435@s.whatsapp.net');
      expect(pnRow).toBeDefined();
      expect(pnRow.chatName).not.toContain('@lid');
      expect(pnRow.chatName).toContain('91');
    });

    expect(displayChatTitle('167659098345499@lid', '167659098345499@lid')).toBe('Contact (345499)');
    expect(displayChatTitle('918279683435@s.whatsapp.net', '211050431549561@lid')).toBe('+91 8279683435');
    expect(attachmentFilenameFromMessage('/tmp/doc.pdf', 'm1', 'V2_Abhishek_Final.pdf V2_Abhishek_Final.pdf')).toBe('V2_Abhishek_Final.pdf');
  });
});
