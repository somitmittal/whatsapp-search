import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from '@jest/globals';
import {
  ensureExpenseRangeMediaReady,
  needsMediaDownload,
} from '../src/expenses/expense-media-ready.js';
import { MEDIA_UNAVAILABLE_PATH, WA_MEDIA_DRAIN_GAP_MS } from '../src/whatsapp/media-constants.js';

const scratch = mkdtempSync(join(tmpdir(), 'expense-media-ready-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('expense media readiness predicates', () => {
  test('download needed only for expense media without a real file', () => {
    expect(needsMediaDownload({ mediaType: 'image', mediaPath: null })).toBe(true);
    expect(needsMediaDownload({ mediaType: 'image', mediaPath: MEDIA_UNAVAILABLE_PATH })).toBe(false);
    expect(needsMediaDownload({ mediaType: 'video', mediaPath: null })).toBe(false);
    const path = join(scratch, 'r.jpg');
    writeFileSync(path, 'x');
    expect(needsMediaDownload({ mediaType: 'image', mediaPath: path })).toBe(false);
  });
});

describe('ensureExpenseRangeMediaReady', () => {
  test('downloads pending media then resolves', async () => {
    const path = join(scratch, 't.jpg');
    writeFileSync(path, 'x');
    let row = {
      messageId: 'img-1',
      mediaType: 'image',
      mediaPath: null,
    };
    const prioritize = [];
    const statuses = [];
    const db = {
      clearUnavailableMediaPaths: () => 0,
      listExpenseMediaInRange: () => [{ ...row }],
    };
    const waClient = {
      prioritizeChatMedia: (jid, opts) => {
        prioritize.push({ jid, opts });
        row = { ...row, mediaPath: path };
      },
      awaitChatMediaQueueIdle: async () => {},
    };

    await ensureExpenseRangeMediaReady({
      db,
      chatJid: 'site@g.us',
      startTs: 100,
      endTs: 200,
      waClient,
      onStatus: (m) => statuses.push(m),
      pollMs: WA_MEDIA_DRAIN_GAP_MS,
    });

    expect(prioritize).toHaveLength(1);
    expect(prioritize[0].opts.allowPhoneReupload).toBe(true);
    expect(statuses.some((s) => /Downloading/i.test(s))).toBe(true);
  });

  test('throws when downloads remain after the queue goes idle', async () => {
    const db = {
      clearUnavailableMediaPaths: () => 0,
      listExpenseMediaInRange: () => [{
        messageId: 'missing',
        mediaType: 'image',
        mediaPath: null,
      }],
    };
    await expect(ensureExpenseRangeMediaReady({
      db,
      chatJid: 'site@g.us',
      startTs: 1,
      endTs: 2,
      waClient: {
        prioritizeChatMedia: () => {},
        awaitChatMediaQueueIdle: async () => {},
      },
      pollMs: WA_MEDIA_DRAIN_GAP_MS,
    })).rejects.toThrow(/still missing locally/i);
  });

  test('no-ops when the range has no expense media', async () => {
    const result = await ensureExpenseRangeMediaReady({
      db: { listExpenseMediaInRange: () => [] },
      chatJid: 'site@g.us',
      startTs: 1,
      endTs: 2,
      pollMs: WA_MEDIA_DRAIN_GAP_MS,
    });
    expect(result).toEqual({ downloadedPending: 0 });
  });
});
