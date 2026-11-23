import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import config from '../src/config.js';
import Database from '../src/storage/database.js';
import { LEGACY_TENANT_ID } from '../src/storage/tenant-constants.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import WebServer from '../src/web/server.js';
import {
  buildChatMessagesHtml,
  replaceBlockReactionCounts,
} from '../public/js/messages-render.js';
import { store } from '../public/js/store.js';

describe('Message Reaction Details & Bottom Emoji Trigger', () => {
  const testDbDir = path.join(process.cwd(), '.tmp-test-reaction-details');
  const testDbPath = path.join(testDbDir, 'test.db');
  let db;

  beforeEach(() => {
    fs.mkdirSync(testDbDir, { recursive: true });
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = new Database(testDbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch (_) {}
    fs.rmSync(testDbDir, { recursive: true, force: true });
  });

  describe('Database Reaction Details', () => {
    test('mergeReactionEvent stores sender details and fromMe', () => {
      runWithTenant('tenant_default', () => {
        const msgId = 'msg_test_1';
        db.insertMessage({
          messageId: msgId,
          chatJid: 'peer@s.whatsapp.net',
          chatName: 'Alice',
          sender: 'Alice',
          senderJid: 'peer@s.whatsapp.net',
          text: 'Hello world',
          timestamp: 1700000000,
        });

        // Current user reacts with ❤️
        const counts1 = db.mergeReactionEvent(
          'peer@s.whatsapp.net',
          msgId,
          '❤️',
          'reaction_1',
          {
            reactionKey: { fromMe: true, participant: null },
            fromMe: true,
            senderName: 'You',
          },
        );

        expect(counts1).toEqual({ '❤️': 1 });

        // Peer reacts with 👍
        const counts2 = db.mergeReactionEvent(
          'peer@s.whatsapp.net',
          msgId,
          '👍',
          'reaction_2',
          {
            reactionKey: { fromMe: false, participant: 'peer@s.whatsapp.net' },
            fromMe: false,
            senderName: 'Alice',
          },
        );

        expect(counts2).toEqual({ '❤️': 1, '👍': 1 });

        // Query reaction details
        const details = db.getMessageReactions('peer@s.whatsapp.net', msgId);
        expect(details.ok).toBe(true);
        expect(details.counts).toEqual({ '❤️': 1, '👍': 1 });
        expect(details.reactions.length).toBe(2);

        const myReaction = details.reactions.find((r) => r.fromMe);
        expect(myReaction).toBeDefined();
        expect(myReaction.sender).toBe('You');
        expect(myReaction.emoji).toBe('❤️');

        const peerReaction = details.reactions.find((r) => !r.fromMe);
        expect(peerReaction).toBeDefined();
        expect(peerReaction.sender).toBe('Alice');
        expect(peerReaction.emoji).toBe('👍');
      });
    });

    test('getMessageReactions falls back gracefully to reactions_json when slots are empty', () => {
      runWithTenant('tenant_default', () => {
        const msgId = 'msg_synced_old';
        db.insertMessage({
          messageId: msgId,
          chatJid: 'peer2@s.whatsapp.net',
          chatName: 'Bob',
          sender: 'Bob',
          senderJid: 'peer2@s.whatsapp.net',
          text: 'Historical message',
          timestamp: 1700000000,
          reactionsJson: JSON.stringify({ '🔥': 2, '👏': 1 }),
        });

        const details = db.getMessageReactions('peer2@s.whatsapp.net', msgId);
        expect(details.ok).toBe(true);
        expect(details.counts).toEqual({ '🔥': 2, '👏': 1 });
        expect(details.reactions.length).toBe(3);
        expect(details.reactions.filter((r) => r.emoji === '🔥').length).toBe(2);
        expect(details.reactions.filter((r) => r.emoji === '👏').length).toBe(1);
      });
    });

    test('changing reaction updates slot and count correctly', () => {
      runWithTenant('tenant_default', () => {
        const msgId = 'msg_change_rx';
        db.insertMessage({
          messageId: msgId,
          chatJid: 'peer3@s.whatsapp.net',
          chatName: 'Charlie',
          sender: 'Charlie',
          senderJid: 'peer3@s.whatsapp.net',
          text: 'Change test',
          timestamp: 1700000000,
        });

        // User reacts with 😂
        db.mergeReactionEvent(
          'peer3@s.whatsapp.net',
          msgId,
          '😂',
          'rx_u1',
          { reactionKey: { fromMe: true }, fromMe: true, senderName: 'You' },
        );

        let details = db.getMessageReactions('peer3@s.whatsapp.net', msgId);
        expect(details.counts).toEqual({ '😂': 1 });

        // User changes to 🎉
        db.mergeReactionEvent(
          'peer3@s.whatsapp.net',
          msgId,
          '🎉',
          'rx_u2',
          { reactionKey: { fromMe: true }, fromMe: true, senderName: 'You' },
        );

        details = db.getMessageReactions('peer3@s.whatsapp.net', msgId);
        expect(details.counts).toEqual({ '🎉': 1 });
        expect(details.reactions[0].emoji).toBe('🎉');
        expect(details.reactions[0].fromMe).toBe(true);

        // User removes reaction
        db.mergeReactionEvent(
          'peer3@s.whatsapp.net',
          msgId,
          '',
          'rx_u3',
          { reactionKey: { fromMe: true }, fromMe: true, senderName: 'You' },
        );

        details = db.getMessageReactions('peer3@s.whatsapp.net', msgId);
        expect(details.counts).toEqual({});
        expect(details.reactions.length).toBe(0);
      });
    });
  });

  describe('GET /api/wa/reactions HTTP Endpoint', () => {
    let webServer;
    let baseUrl;
    const prevDefaultTenant = config.defaultTenantId;

    beforeEach(async () => {
      config.defaultTenantId = LEGACY_TENANT_ID;
      webServer = new WebServer({ db });
      await new Promise((resolve) => {
        webServer._server.listen(0, '127.0.0.1', () => {
          const { port } = webServer._server.address();
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      });
    });

    afterEach(async () => {
      config.defaultTenantId = prevDefaultTenant;
      if (webServer?._server) {
        await new Promise((resolve) => webServer._server.close(resolve));
      }
    });

    test('returns 400 when messageId query param is missing', async () => {
      const res = await fetch(`${baseUrl}/api/wa/reactions`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('messageId required');
    });

    test('returns participant reaction details for valid messageId', async () => {
      runWithTenant(LEGACY_TENANT_ID, () => {
        db.insertMessage({
          messageId: 'msg_api_rx',
          chatJid: 'team@g.us',
          chatName: 'Engineering',
          sender: 'Dave',
          senderJid: 'dave@s.whatsapp.net',
          text: 'Ship it!',
          timestamp: 1700000000,
        });
        db.mergeReactionEvent('team@g.us', 'msg_api_rx', '🚀', 'rx_dave', {
          reactionKey: { fromMe: false, participant: 'dave@s.whatsapp.net' },
          senderName: 'Dave',
          fromMe: false,
        });
      });

      const res = await fetch(`${baseUrl}/api/wa/reactions?chatJid=team@g.us&messageId=msg_api_rx`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.messageId).toBe('msg_api_rx');
      expect(data.counts).toEqual({ '🚀': 1 });
      expect(data.reactions.length).toBe(1);
      expect(data.reactions[0].sender).toBe('Dave');
      expect(data.reactions[0].emoji).toBe('🚀');
    });
  });

  describe('Frontend Message Menu & Bottom React Trigger', () => {
    let prevWaState;

    beforeEach(() => {
      prevWaState = store._waState;
      store._waState = 'READY';
    });

    afterEach(() => {
      store._waState = prevWaState;
    });

    test('menu does NOT contain React and contains bottom emoji trigger', () => {
      const msgs = [
        {
          messageId: 'msg_ui_1',
          chatJid: 'friend@s.whatsapp.net',
          sender: 'Friend',
          text: 'Hey check this out!',
          timestamp: 1700000010,
        },
      ];

      const html = buildChatMessagesHtml(msgs, 'friend@s.whatsapp.net', null, null);

      // React option should be removed from the dropdown menu
      expect(html).not.toContain('mi-react');
      expect(html).not.toContain('<span>React</span>');

      // The small emoji sign at the bottom of the message bubble should be present
      expect(html).toContain('bubble-react-trigger');
      expect(html).toContain('data-wa-emoji-picker-toggle="1"');
      expect(html).toContain('bubble-reaction-bar');
      expect(html).toContain('wa-reaction-picker');

      // Standard menu items like copy and reply should still exist
      expect(html).toContain('data-wa-copy="1"');
      expect(html).toContain('data-wa-reply="1"');
    });

    test('renders reaction chips as buttons when message has reactions', () => {
      const msgs = [
        {
          messageId: 'msg_ui_2',
          chatJid: 'friend@s.whatsapp.net',
          sender: 'Friend',
          text: 'Great photo!',
          reactionsJson: JSON.stringify({ '❤️': 2, '👍': 1 }),
          timestamp: 1700000020,
        },
      ];

      const html = buildChatMessagesHtml(msgs, 'friend@s.whatsapp.net', null, null);

      expect(html).toContain('bubble-reaction-bar has-reactions');
      expect(html).toContain('data-reaction-emoji="❤️"');
      expect(html).toContain('data-reaction-emoji="👍"');
      expect(html).toContain('bubble-react-trigger');
    });
  });
});
