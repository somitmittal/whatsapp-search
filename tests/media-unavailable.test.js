import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'wa-media-unavail-'));
process.env.DATA_DIR = scratch;

const { MEDIA_UNAVAILABLE_PATH, isMediaUnavailablePath, isPermanentMediaFailure } = await import('../src/whatsapp/media-constants.js');
const { default: Database } = await import('../src/storage/database.js');
const { LEGACY_TENANT_ID } = await import('../src/storage/tenant-constants.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');

let db;
beforeAll(() => { db = new Database(); });
afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('media unavailable helpers', () => {
  test('detects permanent WhatsApp failures narrowly', () => {
    expect(isPermanentMediaFailure(new Error('Media re-upload failed by device (NOT_FOUND)'))).toBe(true);
    expect(isPermanentMediaFailure(new Error('Status code: 404'))).toBe(true);
    expect(isPermanentMediaFailure(new Error('Media re-upload failed by device (GENERAL_ERROR)'))).toBe(false);
    expect(isPermanentMediaFailure(new Error('Failed to fetch stream'))).toBe(false);
    expect(isMediaUnavailablePath(MEDIA_UNAVAILABLE_PATH)).toBe(true);
  });

  test('marks orphaned pending media unavailable except ids still downloading', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'oldchat@g.us';
      db.insertMessageBatch([
        {
          messageId: 'img_stuck',
          chatJid: jid,
          chatName: 'Old',
          sender: 'A',
          text: '[image]',
          mediaType: 'image',
          mediaPath: null,
          timestamp: 1_700_000_000,
        },
        {
          messageId: 'img_queued',
          chatJid: jid,
          chatName: 'Old',
          sender: 'A',
          text: '[image]',
          mediaType: 'image',
          mediaPath: null,
          timestamp: 1_700_000_001,
        },
        {
          messageId: 'img_ok',
          chatJid: jid,
          chatName: 'Old',
          sender: 'A',
          text: '[image]',
          mediaType: 'image',
          mediaPath: '/tmp/ok.jpg',
          timestamp: 1_700_000_002,
        },
      ]);

      const n = db.markOrphanedPendingMediaUnavailable(jid, ['img_queued']);
      expect(n).toBe(1);

      const stuck = db._db.prepare(
        'SELECT media_path AS p FROM messages WHERE message_id = ?',
      ).get('img_stuck');
      const queued = db._db.prepare(
        'SELECT media_path AS p FROM messages WHERE message_id = ?',
      ).get('img_queued');
      const ok = db._db.prepare(
        'SELECT media_path AS p FROM messages WHERE message_id = ?',
      ).get('img_ok');
      expect(stuck.p).toBe(MEDIA_UNAVAILABLE_PATH);
      expect(queued.p).toBeNull();
      expect(ok.p).toBe('/tmp/ok.jpg');
    });
  });

  test('age-gated orphan mark leaves recent pending alone; clearUnavailable retries recent', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'recentchat@g.us';
      const now = Math.floor(Date.now() / 1000);
      db.insertMessageBatch([
        {
          messageId: 'img_old',
          chatJid: jid,
          chatName: 'R',
          sender: 'A',
          text: '[image]',
          mediaType: 'image',
          mediaPath: null,
          timestamp: now - 10 * 86400,
        },
        {
          messageId: 'img_recent',
          chatJid: jid,
          chatName: 'R',
          sender: 'A',
          text: '[image]',
          mediaType: 'image',
          mediaPath: null,
          timestamp: now - 3600,
        },
        {
          messageId: 'img_recent_bad',
          chatJid: jid,
          chatName: 'R',
          sender: 'A',
          text: '[image]',
          mediaType: 'image',
          mediaPath: MEDIA_UNAVAILABLE_PATH,
          timestamp: now - 7200,
        },
      ]);

      const cutoff = now - 5 * 86400;
      expect(db.countPendingMediaForChat(jid)).toBe(2);
      expect(db.markOrphanedPendingMediaUnavailable(jid, [], { olderThanTs: cutoff })).toBe(1);
      expect(db._db.prepare('SELECT media_path AS p FROM messages WHERE message_id=?').get('img_old').p)
        .toBe(MEDIA_UNAVAILABLE_PATH);
      expect(db._db.prepare('SELECT media_path AS p FROM messages WHERE message_id=?').get('img_recent').p)
        .toBeNull();

      expect(db.clearUnavailableMediaNewerThan(jid, cutoff)).toBe(1);
      expect(db._db.prepare('SELECT media_path AS p FROM messages WHERE message_id=?').get('img_recent_bad').p)
        .toBeNull();
      expect(db._db.prepare('SELECT media_path AS p FROM messages WHERE message_id=?').get('img_old').p)
        .toBe(MEDIA_UNAVAILABLE_PATH);
    });
  });
});
