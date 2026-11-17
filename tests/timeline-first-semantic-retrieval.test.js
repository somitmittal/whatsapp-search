import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import Database from '../src/storage/database.js';
import ChatDirectory from '../src/gpt/chat-directory.js';
import { ContextEngine } from '../src/gpt/context.js';
import { createToolbox } from '../src/gpt/tools.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Timeline-first conversation grounding & LID contact resolution', () => {
  let db;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(() => {
    try {
      db.close();
    } catch (_) {}
  });

  test('LID chat resolves to formatted phone number instead of Contact (XXXXXX) fallback', () => {
    const tid = 'test-lid-' + Math.random().toString(36).slice(2);
    runWithTenant(tid, () => {
      const lid = '163445014061271@lid';
      const pn = '919004466342@s.whatsapp.net';

      // Record LID to PN mapping
      db.saveLidPnMapping(lid, pn);

      // Insert message with placeholder chat_name Contact (061271)
      db.insertMessage({
        id: 'msg-lid-1',
        chatJid: lid,
        chatName: 'Contact (061271)',
        sender: '+91 9004466342',
        senderJid: lid,
        text: 'Heading into resistance zone',
        timestamp: Math.floor(Date.now() / 1000) - 3600,
      });

      // getChatStats should resolve title to formatted phone, not Contact (061271)
      const stats = db.getChatStats();
      const chat = stats.find((s) => s.chatJid === lid);
      expect(chat).toBeDefined();
      expect(chat.chatName).not.toContain('Contact (');
      expect(chat.chatName).toContain('90044');

      // ChatDirectory.name should also resolve to formatted phone
      const dir = new ChatDirectory(db);
      const resolvedName = dir.name(lid);
      expect(resolvedName).not.toContain('Contact (');
      expect(resolvedName).toContain('90044');

      // backfillChatNamesFromResolvedSenders cleans up the placeholder in messages table
      const cleaned = db.backfillChatNamesFromResolvedSenders();
      expect(cleaned).toBeGreaterThan(0);
      const raw = db._db.prepare('SELECT chat_name FROM messages WHERE tenant_id = ? AND chat_jid = ?').get(tid, lid);
      expect(raw.chat_name).not.toContain('Contact (');
      expect(raw.chat_name).toContain('90044');
    });
  });

  test('prefetch pulls active conversation horizon across linked PN/LID JIDs', async () => {
    const tid = 'test-pre-' + Math.random().toString(36).slice(2);
    await runWithTenant(tid, async () => {
      const lid = '24464184082590@lid';
      const pn = '918800228495@s.whatsapp.net';

      db.saveLidPnMapping(lid, pn);

      // Insert recent conversation messages stored under LID
      const now = Math.floor(Date.now() / 1000);
      db.insertMessage({
        id: 'sanyam-1',
        chatJid: lid,
        chatName: 'Sanyam Malhotra',
        sender: 'You',
        text: 'Lets meet at burger king, subway ke aage',
        timestamp: now - 300,
      });
      db.insertMessage({
        id: 'sanyam-2',
        chatJid: lid,
        chatName: 'Sanyam Malhotra',
        sender: 'You',
        text: 'Ran public school dibdiba its on highway only just before burger king',
        timestamp: now - 200,
      });
      db.insertMessage({
        id: 'sanyam-3',
        chatJid: lid,
        chatName: 'Sanyam Malhotra',
        sender: 'Sanyam Malhotra',
        text: 'Ok yahi milte hain RAN',
        timestamp: now - 100,
      });
      db.insertMessage({
        id: 'sanyam-4',
        chatJid: lid,
        chatName: 'Sanyam Malhotra',
        sender: 'You',
        text: 'Haa bro you left?',
        timestamp: now - 10,
      });

      const directory = new ChatDirectory(db);
      const context = new ContextEngine({ db, directory });

      // Scoped via PN JID (from UI tab)
      const pre = await context.prefetch({
        query: 'where are we heading?',
        scopeJids: [pn],
      });

      expect(pre.text).toContain('# Active conversation in Sanyam Malhotra');
      expect(pre.text).toContain('Ran public school dibdiba');
      expect(pre.text).toContain('burger king');
      expect(pre.text).toContain('Ok yahi milte hain RAN');
    });
  });

  test('search tool does not silently expand to global archive when chat-scoped search yields 0 hits', async () => {
    const tid = 'test-search-' + Math.random().toString(36).slice(2);
    await runWithTenant(tid, async () => {
      const sanyamLid = '24464184082590@lid';
      const unrelatedLid = '163445014061271@lid';

      // Sanyam chat has meeting discussion, no word 'heading'
      db.insertMessage({
        id: 'san-1',
        chatJid: sanyamLid,
        chatName: 'Sanyam Malhotra',
        sender: 'Sanyam Malhotra',
        text: 'Ok yahi milte hain RAN',
        timestamp: Math.floor(Date.now() / 1000) - 100,
      });

      // Unrelated chat has 'heading' in a chart caption
      db.insertMessage({
        id: 'unrel-1',
        chatJid: unrelatedLid,
        chatName: 'Trading Desk',
        sender: 'Trader',
        text: 'Heading into resistance zone',
        timestamp: Math.floor(Date.now() / 1000) - 500000,
      });

      const directory = new ChatDirectory(db);
      const toolbox = createToolbox({ db, directory, embeddings: null });

      // Searching for 'heading' scoped to Sanyam Malhotra must NOT return the unrelated message
      const res = await toolbox.search({ query: 'heading', chat: 'Sanyam Malhotra' }, 1000);
      expect(res.text).toContain('No messages found for "heading" in Sanyam Malhotra');
      expect(res.text).not.toContain('resistance zone');
    });
  });

  test('agent auto-scopes tool calls to scopeChatName when args.chat is omitted', async () => {
    const tid = 'test-autoscope-' + Math.random().toString(36).slice(2);
    await runWithTenant(tid, async () => {
      let capturedArgs = null;
      const fakeToolbox = {
        search: async (args) => {
          capturedArgs = args;
          return { text: 'Done', messages: [] };
        },
      };

      const { runAgent } = await import('../src/gpt/agent.js');
      let stepCount = 0;
      const fakeProvider = {
        async chat() {
          stepCount++;
          if (stepCount === 1) {
            return 'CALL {"tool": "search", "args": {"query": "heading"}}';
          }
          return 'We are meeting at Burger King.';
        },
      };

      await runAgent({
        provider: fakeProvider,
        system: 'System prompt',
        history: [],
        contextText: 'Context',
        query: 'where are we heading?',
        toolbox: fakeToolbox,
        ctx: { scopeChatName: 'Sanyam Malhotra' },
        emit: () => {},
      });

      expect(capturedArgs).toBeDefined();
      expect(capturedArgs.chat).toBe('Sanyam Malhotra');
    });
  });
});
