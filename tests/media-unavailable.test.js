import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'wa-media-unavail-'));
process.env.DATA_DIR = scratch;

const {
  MEDIA_TOO_LARGE_PATH,
  MEDIA_UNAVAILABLE_PATH,
  isPermanentMediaFailure,
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

const media = (messageId, chatJid, timestamp, extra = {}) => ({
  messageId,
  chatJid,
  chatName: 'Chat',
  sender: 'A',
  text: '[image]',
  mediaType: 'image',
  mediaPath: null,
  timestamp,
  ...extra,
});
const text = (messageId, chatJid, timestamp) => ({
  messageId, chatJid, chatName: 'Chat', sender: 'A', text: 'hi', timestamp,
});
const pathOf = (id) => db._db.prepare('SELECT media_path AS p FROM messages WHERE message_id = ?').get(id).p;

describe('media terminal states', () => {
  test('only WhatsApp "gone" answers are permanent', () => {
    expect(isPermanentMediaFailure(new Error('Media re-upload failed by device (NOT_FOUND)'))).toBe(true);
    expect(isPermanentMediaFailure(new Error('Status code: 404'))).toBe(true);
    expect(isPermanentMediaFailure(new Error('Media re-upload failed by device (GENERAL_ERROR)'))).toBe(false);
    expect(isPermanentMediaFailure(new Error('Failed to fetch stream'))).toBe(false);
  });

  test('clearUnavailableMediaPaths restores pending so Retry can re-queue', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'clear-unavail@g.us';
      db.insertMessageBatch([
        media('u1', jid, 500, { mediaPath: MEDIA_UNAVAILABLE_PATH, mediaDownloadJson: '{"k":1}' }),
        media('u2', jid, 501, { mediaPath: MEDIA_UNAVAILABLE_PATH }),
        media('u3', jid, 502, { mediaPath: '/tmp/ok.jpg' }),
      ]);
      expect(db.clearUnavailableMediaPaths(jid, 'u1')).toBe(1);
      expect(pathOf('u1')).toBeNull();
      expect(pathOf('u2')).toBe(MEDIA_UNAVAILABLE_PATH);
      expect(db.clearUnavailableMediaPaths(jid)).toBe(1);
      expect(pathOf('u2')).toBeNull();
      expect(pathOf('u3')).toBe('/tmp/ok.jpg');
      expect(db.mediaNeedsDownload('u1')).toBe(true);
      expect(db.listPendingMediaWithDownloadStub(jid).map((r) => r.messageId)).toEqual(['u1']);
    });
  });

  test('unavailable path keeps download stub for Retry', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'keep-stub@g.us';
      db.insertMessageBatch([media('k1', jid, 600, { mediaDownloadJson: '{"z":9}' })]);
      db.updateMessageMediaPath('k1', MEDIA_UNAVAILABLE_PATH);
      expect(pathOf('k1')).toBe(MEDIA_UNAVAILABLE_PATH);
      // Stub retained until a real file lands (or clearUnavailable + requeue).
      const stub = db._db.prepare(
        'SELECT media_download_json AS j FROM messages WHERE message_id = ?',
      ).get('k1')?.j;
      expect(stub).toBe('{"z":9}');
      db.clearUnavailableMediaPaths(jid, 'k1');
      expect(db.listPendingMediaWithDownloadStub(jid).map((r) => r.messageId)).toEqual(['k1']);
    });
  });

  test('sentinels are terminal, real paths and empty are not', () => {
    expect(isTerminalMediaPath(MEDIA_UNAVAILABLE_PATH)).toBe(true);
    expect(isTerminalMediaPath(MEDIA_TOO_LARGE_PATH)).toBe(true);
    expect(isTerminalMediaPath('/tmp/a.jpg')).toBe(false);
    expect(isTerminalMediaPath(null)).toBe(false);
  });
});

describe('persisted download stubs', () => {
  test('stub stored on insert, upserted on re-delivery, cleared once the file lands', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'stub@g.us';
      db.insertMessageBatch([media('s1', jid, 100, { mediaDownloadJson: '{"a":1}' }), media('s2', jid, 101)]);
      expect(db.listPendingMediaWithDownloadStub(jid).map((r) => r.messageId)).toEqual(['s1']);

      // On-demand history re-delivers s2 with its proto: INSERT OR IGNORE, stub still saved.
      db.insertMessageBatch([media('s2', jid, 101, { mediaDownloadJson: '{"b":2}' })]);
      expect(db.listPendingMediaWithDownloadStub(jid).map((r) => r.messageId)).toEqual(['s2', 's1']);

      db.updateMessageMediaPath('s1', '/tmp/s1.jpg');
      expect(pathOf('s1')).toBe('/tmp/s1.jpg');
      expect(db.listPendingMediaWithDownloadStub(jid).map((r) => r.messageId)).toEqual(['s2']);
      expect(db.mediaNeedsDownload('s1')).toBe(false);
      expect(db.mediaNeedsDownload('s2')).toBe(true);
      expect(db.mediaNeedsDownload('not-inserted-yet')).toBe(true);
    });
  });
});

describe('on-demand history anchor for stub-less pending media', () => {
  test('anchors on the first message after the newest stub-less pending row', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'anchor@g.us';
      db.insertMessageBatch([
        media('a_old', jid, 200),
        text('t1', jid, 201),
        media('a_new', jid, 202),
        media('a_stub', jid, 203, { mediaDownloadJson: '{"c":3}' }),
        text('t2', jid, 204),
      ]);
      // a_new has no stub; history is fetched *before* the anchor, so the anchor is the row after it.
      expect(db.getHistoryAnchorForStublessPendingMedia(jid)).toMatchObject({ messageId: 'a_stub', timestamp: 203 });
    });
  });

  test('null when every pending row has a stub or a final state', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'anchor2@g.us';
      db.insertMessageBatch([
        media('b1', jid, 300, { mediaDownloadJson: '{"d":4}' }),
        media('b2', jid, 301, { mediaPath: MEDIA_UNAVAILABLE_PATH }),
        text('t3', jid, 302),
      ]);
      expect(db.getHistoryAnchorForStublessPendingMedia(jid)).toBeNull();
    });
  });

  test('null when the stub-less pending row is the newest message', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'anchor3@g.us';
      db.insertMessageBatch([text('t4', jid, 400), media('c1', jid, 401)]);
      expect(db.getHistoryAnchorForStublessPendingMedia(jid)).toBeNull();
    });
  });
});


describe('database-backed media download claims', () => {
  test('claims are unique per tenant and can be released for retry', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      expect(db.claimMediaDownload('claim-1')).toBe(true);
      expect(db.claimMediaDownload('claim-1')).toBe(false);
      expect(db.releaseMediaDownloadClaim('claim-1')).toBe(1);
      expect(db.claimMediaDownload('claim-1')).toBe(true);
      db.releaseMediaDownloadClaim('claim-1');
    });

    await runWithTenant('tenant-media-claims-other', async () => {
      expect(db.claimMediaDownload('claim-1')).toBe(true);
      expect(db.claimMediaDownload('claim-1')).toBe(false);
      db.releaseMediaDownloadClaim('claim-1');
    });
  });

  test('expired claims can be reclaimed after an interrupted worker', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      expect(db.claimMediaDownload('claim-expired')).toBe(true);
      db._db.prepare(`
        UPDATE wa_media_download_claims
        SET expires_at = unixepoch() - 1
        WHERE tenant_id = ? AND message_id = ?
      `).run(LEGACY_TENANT_ID, 'claim-expired');
      expect(db.claimMediaDownload('claim-expired')).toBe(true);
      db.releaseMediaDownloadClaim('claim-expired');
    });
  });
});
