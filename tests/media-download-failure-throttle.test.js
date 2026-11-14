import { describe, expect, it } from '@jest/globals';
import WaClient from '../src/whatsapp/wa-client.js';
import {
  MEDIA_UNAVAILABLE_PATH,
} from '../src/whatsapp/media-constants.js';

describe('media download failure throttling & retry behavior', () => {
  it('records failed background downloads in _failedMediaDownloads and skips them on subsequent requeue', () => {
    const client = new WaClient({});
    const mid1 = 'MSG_FAIL_1';
    const mid2 = 'MSG_FAIL_2';
    const chatJid = 'group1@g.us';

    client._failedMediaDownloads.set(mid1, {
      chatJid,
      failedAt: Date.now(),
      error: 'Failed to fetch stream from <url>',
      statusCode: 404,
    });

    const pendingStubs = [
      {
        msg: { key: { id: mid1, remoteJid: chatJid }, message: {} },
        row: { messageId: mid1, chatJid, mediaType: 'image', timestamp: 1000 },
      },
      {
        msg: { key: { id: mid2, remoteJid: chatJid }, message: {} },
        row: { messageId: mid2, chatJid, mediaType: 'image', timestamp: 1001 },
      },
    ];

    client._onLoadPendingMediaStubs = () => pendingStubs;
    client._sock = { updateMediaMessage: async () => ({}) };

    // Standard background requeue: mid1 should be skipped because it is in _failedMediaDownloads
    const queuedCount = client._requeuePersistedPendingMedia(chatJid, null);
    expect(queuedCount).toBe(1);
    expect(client._queuedMediaIds.has(mid1)).toBe(false);
    expect(client._queuedMediaIds.has(mid2)).toBe(true);

    client.destroy();
  });

  it('allows explicit retry for single messageId even if present in _failedMediaDownloads', () => {
    const client = new WaClient({});
    const mid1 = 'MSG_FAIL_RETRY';
    const chatJid = 'group1@g.us';

    client._failedMediaDownloads.set(mid1, {
      chatJid,
      failedAt: Date.now(),
      error: 'Failed to fetch stream from <url>',
      statusCode: 404,
    });

    const pendingStubs = [
      {
        msg: { key: { id: mid1, remoteJid: chatJid }, message: {} },
        row: { messageId: mid1, chatJid, mediaType: 'image', timestamp: 1000 },
      },
    ];

    client._onLoadPendingMediaStubs = () => pendingStubs;
    client._sock = { updateMediaMessage: async () => ({}) };

    // User triggers explicit retry on message mid1
    client.prioritizeChatMedia(chatJid, { messageId: mid1, allowPhoneReupload: true });

    expect(client._failedMediaDownloads.has(mid1)).toBe(false);
    expect(client._queuedMediaIds.has(mid1)).toBe(true);

    client.destroy();
  });

  it('clears failed downloads for entire chat when prioritizeChatMedia runs with allowPhoneReupload: true', () => {
    const client = new WaClient({});
    const midA = 'MSG_A';
    const midB = 'MSG_B';
    const midOther = 'MSG_OTHER';
    const chatJid = 'target@g.us';
    const otherJid = 'other@g.us';

    client._failedMediaDownloads.set(midA, { chatJid, failedAt: Date.now() });
    client._failedMediaDownloads.set(midB, { chatJid, failedAt: Date.now() });
    client._failedMediaDownloads.set(midOther, { chatJid: otherJid, failedAt: Date.now() });

    client._onLoadPendingMediaStubs = () => [];
    client._sock = { updateMediaMessage: async () => ({}) };

    client.prioritizeChatMedia(chatJid, { allowPhoneReupload: true });

    expect(client._failedMediaDownloads.has(midA)).toBe(false);
    expect(client._failedMediaDownloads.has(midB)).toBe(false);
    expect(client._failedMediaDownloads.has(midOther)).toBe(true);

    client.destroy();
  });

  it('marks MEDIA_UNAVAILABLE_PATH when allowPhoneReupload: true and failure is permanent', async () => {
    const client = new WaClient({});
    const mid = 'MSG_PERM_FAIL';
    const chatJid = 'chat@g.us';
    const row = { messageId: mid, chatJid, mediaType: 'image', mediaPath: null };
    const msg = {
      key: { id: mid, remoteJid: chatJid },
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/perm-fail',
          mediaKey: Buffer.alloc(32, 1),
          fileEncSha256: Buffer.alloc(32, 2),
          fileSha256: Buffer.alloc(32, 3),
          fileLength: 100,
        },
      },
    };

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: { cancel: async () => {} },
      });

      // Mock socket where updateMediaMessage throws a 404 error
      client._sock = {
        updateMediaMessage: async () => {
          const err = new Error('Status code: 404');
          err.statusCode = 404;
          throw err;
        },
      };

      const res = await client._enrichRowWithMedia(msg, row, { allowPhoneReupload: true });
      expect(res.mediaPath).toBe(MEDIA_UNAVAILABLE_PATH);
      expect(client._failedMediaDownloads.has(mid)).toBe(true);
      expect(client._failedMediaDownloads.get(mid).statusCode).toBe(404);
    } finally {
      globalThis.fetch = origFetch;
      client.destroy();
    }
  });

  it('does NOT mark permanent on background CDN failure when allowPhoneReupload: false', async () => {
    const client = new WaClient({});
    const mid = 'MSG_TEMP_BG_FAIL';
    const chatJid = 'chat@g.us';
    const row = { messageId: mid, chatJid, mediaType: 'image', mediaPath: null };
    const msg = {
      key: { id: mid, remoteJid: chatJid },
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/temp-fail',
          mediaKey: Buffer.alloc(32, 1),
          fileEncSha256: Buffer.alloc(32, 2),
          fileSha256: Buffer.alloc(32, 3),
          fileLength: 100,
        },
      },
    };

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        body: { cancel: async () => {} },
      });

      client._sock = {};

      const res = await client._enrichRowWithMedia(msg, row, { allowPhoneReupload: false });
      // Remains null (not marked permanent) so a future phone re-upload can still succeed
      expect(res.mediaPath).toBeNull();
      // But recorded in _failedMediaDownloads so it is throttled from repeated background attempts
      expect(client._failedMediaDownloads.has(mid)).toBe(true);
      expect(client._failedMediaDownloads.get(mid).statusCode).toBe(404);
    } finally {
      globalThis.fetch = origFetch;
      client.destroy();
    }
  });

  it('caps _failedMediaDownloads size to prevent unbounded memory growth', async () => {
    const client = new WaClient({});
    const chatJid = 'chat@g.us';
    client._sock = {};

    // Pre-populate with 5000 items
    for (let i = 0; i < 5000; i++) {
      client._failedMediaDownloads.set(`m_${i}`, { chatJid, failedAt: Date.now() });
    }
    expect(client._failedMediaDownloads.size).toBe(5000);

    // One more failed download triggers eviction of the oldest item
    const mid = 'm_5001';
    const row = { messageId: mid, chatJid, mediaType: 'image', mediaPath: null };
    const msg = { key: { id: mid, remoteJid: chatJid }, message: {} };
    await client._enrichRowWithMedia(msg, row, { allowPhoneReupload: false });

    expect(client._failedMediaDownloads.size).toBe(5000);
    // Oldest item evicted
    expect(client._failedMediaDownloads.has('m_0')).toBe(false);
    expect(client._failedMediaDownloads.has('m_1')).toBe(true);
    expect(client._failedMediaDownloads.has('m_5001')).toBe(true);

    client.destroy();
    expect(client._failedMediaDownloads.size).toBe(0);
  });
});
