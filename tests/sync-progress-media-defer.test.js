import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'wa-sync-media-defer-'));
process.env.DATA_DIR = scratch;

const {
  MEDIA_TOO_LARGE_PATH,
  MEDIA_UNAVAILABLE_PATH,
  isTerminalMediaPath,
} = await import('../src/whatsapp/media-constants.js');
const { default: Database } = await import('../src/storage/database.js');
const { LEGACY_TENANT_ID } = await import('../src/storage/tenant-constants.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');

let db;
beforeAll(() => { db = new Database(); });
afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('deferred large videos database helpers', () => {
  const jid = '123456789@s.whatsapp.net';

  test('listDeferredLargeVideoStubs returns deferred large video rows with stubs', () => {
    runWithTenant(LEGACY_TENANT_ID, () => {
      db.insertMessageBatch([
        {
          messageId: 'v1',
          chatJid: jid,
          chatName: 'Chat',
          sender: 'Sender',
          text: '[video]',
          mediaType: 'video',
          mediaPath: MEDIA_TOO_LARGE_PATH,
          mediaDownloadJson: JSON.stringify({ key: { id: 'v1' }, message: { videoMessage: {} } }),
          timestamp: 1000,
        },
        {
          messageId: 'v2',
          chatJid: jid,
          chatName: 'Chat',
          sender: 'Sender',
          text: '[video]',
          mediaType: 'video',
          mediaPath: null,
          mediaDownloadJson: JSON.stringify({ key: { id: 'v2' }, message: { videoMessage: {} } }),
          timestamp: 1001,
        },
        {
          messageId: 'img1',
          chatJid: jid,
          chatName: 'Chat',
          sender: 'Sender',
          text: '[image]',
          mediaType: 'image',
          mediaPath: null,
          mediaDownloadJson: JSON.stringify({ key: { id: 'img1' }, message: { imageMessage: {} } }),
          timestamp: 1002,
        },
      ]);

      const deferred = db.listDeferredLargeVideoStubs(jid);
      expect(deferred.length).toBe(1);
      expect(deferred[0].messageId).toBe('v1');
      expect(deferred[0].mediaType).toBe('video');

      // Clear the deferred path to allow re-queue / on-demand load
      db.clearUnavailableMediaPaths(jid, 'v1');
      const deferredAfter = db.listDeferredLargeVideoStubs(jid);
      expect(deferredAfter.length).toBe(0);

      // Now v1 is pending download stub
      const pending = db.listPendingMediaWithDownloadStub(jid).map((r) => r.messageId);
      expect(pending).toContain('v1');
    });
  });

  test('listDeferredLargeVideoStubs respects limit and filters by chatJid', () => {
    runWithTenant(LEGACY_TENANT_ID, () => {
      const otherJid = '999999999@s.whatsapp.net';
      db.insertMessageBatch([
        {
          messageId: 'v-other-1',
          chatJid: otherJid,
          chatName: 'Other',
          sender: 'Sender',
          text: '[video]',
          mediaType: 'video',
          mediaPath: MEDIA_TOO_LARGE_PATH,
          mediaDownloadJson: JSON.stringify({ key: { id: 'v-other-1' }, message: { videoMessage: {} } }),
          timestamp: 2000,
        },
      ]);

      const otherDeferred = db.listDeferredLargeVideoStubs(otherJid);
      expect(otherDeferred.length).toBe(1);
      expect(otherDeferred[0].messageId).toBe('v-other-1');

      const limited = db.listDeferredLargeVideoStubs(null, 1);
      expect(limited.length).toBe(1);
    });
  });

  test('isTerminalMediaPath correctly classifies MEDIA_TOO_LARGE_PATH and MEDIA_UNAVAILABLE_PATH', () => {
    expect(isTerminalMediaPath(MEDIA_TOO_LARGE_PATH)).toBe(true);
    expect(isTerminalMediaPath(MEDIA_UNAVAILABLE_PATH)).toBe(true);
    expect(isTerminalMediaPath('/path/to/media.mp4')).toBe(false);
    expect(isTerminalMediaPath(null)).toBe(false);
    expect(isTerminalMediaPath('')).toBe(false);
  });
});
