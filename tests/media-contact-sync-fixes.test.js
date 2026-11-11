import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isPlaceholderSenderName,
  isUpgradeableSenderName,
} from '../src/whatsapp/chat-display-name.js';
import {
  buildChatMessagesHtml,
  formatMediaRetryNote,
  senderNeedsResolution,
} from '../public/js/messages-render.js';

const scratch = mkdtempSync(join(tmpdir(), 'wa-media-contact-sync-'));
process.env.DATA_DIR = scratch;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-for-contacts';

const { default: Database } = await import('../src/storage/database.js');
const { LEGACY_TENANT_ID } = await import('../src/storage/tenant-constants.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');
const { store } = await import('../public/js/store.js');

let db;
beforeAll(() => {
  db = new Database();
});

afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('sender name placeholder vs upgradeable classification', () => {
  test('preserves isPlaceholderSenderName contract for formatted phones', () => {
    expect(isPlaceholderSenderName('+91 95998 14160')).toBe(false);
    expect(isPlaceholderSenderName('Contact (499963)')).toBe(true);
    expect(isPlaceholderSenderName('273980359499963')).toBe(true);
  });

  test('isUpgradeableSenderName catches both placeholders and phone-formatted senders', () => {
    expect(isUpgradeableSenderName(null)).toBe(true);
    expect(isUpgradeableSenderName('')).toBe(true);
    expect(isUpgradeableSenderName('Unknown')).toBe(true);
    expect(isUpgradeableSenderName('Contact (499963)')).toBe(true);
    expect(isUpgradeableSenderName('273980359499963')).toBe(true);
    expect(isUpgradeableSenderName('+91 9351552637')).toBe(true);
    expect(isUpgradeableSenderName('+91 95998 14160')).toBe(true);
    expect(isUpgradeableSenderName('+1 (555) 234-5678')).toBe(true);
    expect(isUpgradeableSenderName('09876543210')).toBe(true);

    expect(isUpgradeableSenderName('You')).toBe(false);
    expect(isUpgradeableSenderName('Himanshu Mittal')).toBe(false);
    expect(isUpgradeableSenderName('Priya Sharma')).toBe(false);
    expect(isUpgradeableSenderName('Contact Support')).toBe(false);
    expect(isUpgradeableSenderName('Office 2')).toBe(false);
  });

  test('senderNeedsResolution matches frontend deferred trigger rules', () => {
    expect(senderNeedsResolution('Contact (499963)')).toBe(true);
    expect(senderNeedsResolution('Unknown')).toBe(true);
    expect(senderNeedsResolution('273980359499963')).toBe(true);
    expect(senderNeedsResolution('+91 9351552637')).toBe(true);
    expect(senderNeedsResolution('Himanshu Mittal')).toBe(false);
    expect(senderNeedsResolution('You')).toBe(false);
  });
});

describe('database contact_directory resolution & safe backfill', () => {
  test('backfillSenderName upgrades formatted phones and null-sender_jid 1:1 rows without overwriting real names', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const pnJid = '919351552637@s.whatsapp.net';
      const groupJid = '120363999000@g.us';

      db.insertMessageBatch([
        {
          messageId: 'd-phone',
          chatJid: pnJid,
          chatName: '+91 9351552637',
          sender: '+91 9351552637',
          senderJid: pnJid,
          text: 'Hello',
          timestamp: 1700001000,
        },
        {
          messageId: 'd-null-sjid',
          chatJid: pnJid,
          chatName: '+91 9351552637',
          sender: 'Contact (552637)',
          senderJid: null,
          text: 'Null sender jid row',
          timestamp: 1700001001,
        },
        {
          messageId: 'd-human-kept',
          chatJid: pnJid,
          chatName: '+91 9351552637',
          sender: 'Existing Long Human Name',
          senderJid: pnJid,
          text: 'Should stay intact',
          timestamp: 1700001002,
        },
        {
          messageId: 'd-you-kept',
          chatJid: pnJid,
          chatName: '+91 9351552637',
          sender: 'You',
          senderJid: pnJid,
          text: 'Outbound msg',
          timestamp: 1700001003,
        },
        {
          messageId: 'g-phone',
          chatJid: groupJid,
          chatName: 'Work Group',
          sender: '+91 9351552637',
          senderJid: pnJid,
          text: 'Group msg',
          timestamp: 1700001004,
        },
      ]);

      expect(db.getDistinctPlaceholderSenderJids(groupJid)).toContain(pnJid);

      const updated = db.backfillSenderName([pnJid], 'Rohan Sharma');
      expect(updated).toBe(3);

      const pnMsgs = db.getMessagesPaginated(pnJid, 20);
      expect(pnMsgs.find((m) => m.messageId === 'd-phone').sender).toBe('Rohan Sharma');
      expect(pnMsgs.find((m) => m.messageId === 'd-null-sjid').sender).toBe('Rohan Sharma');
      expect(pnMsgs.find((m) => m.messageId === 'd-human-kept').sender).toBe('Existing Long Human Name');
      expect(pnMsgs.find((m) => m.messageId === 'd-you-kept').sender).toBe('You');

      const grpMsgs = db.getMessagesPaginated(groupJid, 20);
      expect(grpMsgs.find((m) => m.messageId === 'g-phone').sender).toBe('Rohan Sharma');
    });
  });

  test('syncContactDirectory + getResolvedSenderForJid resolves formatted-phone JIDs from encrypted contact book', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const pnJid = '919811112222@s.whatsapp.net';
      const grp = '120363999111@g.us';

      db.insertMessageBatch([
        {
          messageId: 'cd-1',
          chatJid: pnJid,
          chatName: '+91 98111 12222',
          sender: '+91 98111 12222',
          senderJid: pnJid,
          text: 'Hi',
          timestamp: 1700002000,
        },
        {
          messageId: 'cd-2',
          chatJid: grp,
          chatName: 'Owners',
          sender: 'Contact (112222)',
          senderJid: pnJid,
          text: 'Hi in group',
          timestamp: 1700002001,
        },
      ]);

      const syncRes = db.syncContactDirectory([{ name: 'Ananya Verma', phones: ['+91 98111 12222'] }]);
      expect(syncRes.inserted).toBe(1);
      expect(syncRes.updatedSenders).toBeGreaterThanOrEqual(2);
      expect(db.getResolvedSenderForJid([pnJid])).toBe('Ananya Verma');
      expect(db.getMessagesPaginated(pnJid, 10)[0].chatName).toBe('Ananya Verma');
      expect(db.getMessagesPaginated(grp, 10)[0].sender).toBe('Ananya Verma');
    });
  });
});

describe('media path cleanup, PDO per-message anchors, and sync completeness stats', () => {
  test('same-second timestamp tie-break works in PDO anchors + clearMessageMediaPath + hasMediaDownloadStub', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'tie-pdo@s.whatsapp.net';
      db.insertMessageBatch([
        {
          messageId: 'm-target',
          chatJid: jid,
          chatName: 'Peer',
          sender: 'Peer',
          senderJid: jid,
          text: '[image]',
          mediaType: 'image',
          mediaPath: '/nonexistent/missing.jpg',
          timestamp: 1700003000,
        },
        {
          messageId: 'm-after-same-ts',
          chatJid: jid,
          chatName: 'Peer',
          sender: 'You',
          senderJid: jid,
          text: 'Same second reply',
          timestamp: 1700003000,
        },
      ]);

      const rec = db.getMessageMediaRecord('m-target');
      expect(rec.chatJid).toBe(jid);
      expect(db.hasMediaDownloadStub('m-target')).toBe(false);

      expect(db.clearMessageMediaPath(jid, 'm-target')).toBe(1);
      expect(db.getMessageMediaRecord('m-target').mediaPath).toBeNull();

      const anchor = db.getHistoryAnchorForMessage(jid, 'm-target');
      expect(anchor).toMatchObject({ messageId: 'm-after-same-ts', timestamp: 1700003000, fromMe: 1 });
      const stublessAnchor = db.getHistoryAnchorForStublessPendingMedia(jid);
      expect(stublessAnchor).toMatchObject({ messageId: 'm-after-same-ts', timestamp: 1700003000 });
    });
  });

  test('getSyncCompletenessStats tracks live awaiting chats & pending media while ignoring @imported', async () => {
    await runWithTenant('tenant-sync-stats', async () => {
      db.insertMessageBatch([
        {
          messageId: 'imp-1',
          chatJid: 'export@imported',
          chatName: 'Exported Chat',
          sender: 'Friend',
          text: '[image]',
          mediaType: 'image',
          mediaPath: null,
          timestamp: 1700004000,
        },
        {
          messageId: 'live-1',
          chatJid: '919900001111@s.whatsapp.net',
          chatName: 'Live Peer',
          sender: 'Live Peer',
          senderJid: '919900001111@s.whatsapp.net',
          text: '[image]',
          mediaType: 'image',
          mediaPath: null,
          mediaDownloadJson: '{"k":1}',
          timestamp: 1700004001,
        },
        {
          messageId: 'live-2',
          chatJid: '919900001111@s.whatsapp.net',
          chatName: 'Live Peer',
          sender: 'Live Peer',
          senderJid: '919900001111@s.whatsapp.net',
          text: '[video]',
          mediaType: 'video',
          mediaPath: null,
          timestamp: 1700004002,
        },
      ]);

      db.upsertChatRoster([
        { chatJid: '919900001111@s.whatsapp.net', chatName: 'Live Peer', lastMessageTs: 1700004002 },
        { chatJid: '919900002222@s.whatsapp.net', chatName: 'Awaiting Peer', lastMessageTs: 1700004003 },
      ]);

      const stats = db.getSyncCompletenessStats();
      expect(stats.chatsWithMessages).toBe(1);
      expect(stats.chatsAwaitingHistory).toBe(1);
      expect(stats.pendingMediaWithStub).toBe(1);
      expect(stats.pendingMediaStubless).toBe(1);
    });
  });
});

describe('UI single sync bar, message retry badge, and 1:1 sender class contracts', () => {
  test('HTML templates contain only top sync progress bar (no duplicate sidebar sync bar)', () => {
    const gptHtml = readFileSync(resolve(process.cwd(), 'public/gpt.html'), 'utf8');
    const indexHtml = readFileSync(resolve(process.cwd(), 'public/index.html'), 'utf8');
    expect(gptHtml).toContain('id="gpt-top-sync-bar"');
    expect(gptHtml).not.toContain('id="gpt-sync"');
    expect(indexHtml).toContain('id="top-sync-bar"');
    expect(indexHtml).not.toContain('id="sidebar-sync-bar"');
  });

  test('CSS sheets style .media-retry pill, .media-retry-note, and .sender-direct consistently', () => {
    const sharedCss = readFileSync(resolve(process.cwd(), 'public/css/chat-messages.css'), 'utf8');
    const appCss = readFileSync(resolve(process.cwd(), 'public/css/app.css'), 'utf8');
    const gptCss = readFileSync(resolve(process.cwd(), 'public/gpt-app/gpt.css'), 'utf8');

    for (const css of [sharedCss, appCss]) {
      expect(css).toContain('.sender.sender-direct');
      expect(css).toContain('.media-retry');
      expect(css).toContain('.media-retry-note');
      expect(css).toContain('.media-not-downloaded');
      expect(css).toContain('.media-unavailable');
    }
    expect(appCss).toContain('.top-sync-bar.incomplete');
    expect(gptCss).toContain('.gpt-top-sync-bar.incomplete');
  });

  test('buildChatMessagesHtml renders sender-direct in 1:1 chats and Retry button when media missing', () => {
    const prevState = store._waState;
    store._waState = 'READY';
    try {
      const html = buildChatMessagesHtml([
        {
          messageId: 'm1',
          chatJid: '919351552637@s.whatsapp.net',
          sender: 'Rohan Sharma',
          senderJid: '919351552637@s.whatsapp.net',
          text: '[image]',
          mediaType: 'image',
          hasMediaFile: false,
          mediaPending: true,
          timestamp: 1700005000,
        },
      ], '919351552637@s.whatsapp.net', null, null);
      expect(html).toContain('class="sender sender-direct" data-sender-jid="919351552637@s.whatsapp.net"');
      expect(html).toContain('Rohan Sharma');
      expect(html).toContain('class="media-badge media-not-downloaded"');
      expect(html).toContain('data-wa-media-retry data-message-id="m1"');
    } finally {
      store._waState = prevState;
    }
  });

  test('formatMediaRetryNote explains every retry outcome clearly', () => {
    expect(formatMediaRetryNote({ imported: true })).toContain('Imported chat');
    expect(formatMediaRetryNote({ history: { requested: true, purpose: 'media_rehydrate' } })).toContain('Requested from phone');
    expect(formatMediaRetryNote({ history: { requested: false, error: 'Rate limited' } })).toBe('Rate limited');
    expect(formatMediaRetryNote({ waConnected: false })).toContain('Connect WhatsApp');
    expect(formatMediaRetryNote({ waConnected: true, mediaQueued: 1 })).toContain('Downloading media');
    expect(formatMediaRetryNote({ waConnected: true, mediaQueued: 0, hasStub: false })).toContain('Load older messages');
  });
});
