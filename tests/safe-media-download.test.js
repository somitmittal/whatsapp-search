import Crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, test } from '@jest/globals';
import {
  downloadEncryptedContentSafe,
  downloadMediaMessageSafe,
} from '../src/whatsapp/safe-media-download.js';

describe('safe-media-download', () => {
  test('decrypts AES-256-CBC ciphertext correctly', async () => {
    const cipherKey = Crypto.randomBytes(32);
    const iv = Crypto.randomBytes(16);
    const plaintext = Buffer.from('Hello, WhatsApp media world! Testing safe streaming decryption.');

    // Encrypt plaintext with AES-256-CBC
    const cipher = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    // Mock global fetch to return the ciphertext
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body: Readable.toWeb(Readable.from([ciphertext])),
      });

      const stream = await downloadEncryptedContentSafe('https://mmg.whatsapp.net/test-media', {
        cipherKey,
        iv,
      });

      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const decrypted = Buffer.concat(chunks);
      expect(decrypted.toString()).toBe(plaintext.toString());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('cancels response body and throws on non-ok HTTP responses', async () => {
    const cipherKey = Crypto.randomBytes(32);
    const iv = Crypto.randomBytes(16);
    let cancelCalled = false;

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 404,
        body: {
          cancel: async () => {
            cancelCalled = true;
          },
        },
      });

      await expect(
        downloadEncryptedContentSafe('https://mmg.whatsapp.net/not-found', { cipherKey, iv })
      ).rejects.toThrow('Failed to fetch stream');
      expect(cancelCalled).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('bridges upstream stream errors to downstream without unhandled error events', async () => {
    const cipherKey = Crypto.randomBytes(32);
    const iv = Crypto.randomBytes(16);

    // Create a readable stream that will abort with a socket termination error
    const brokenReadable = new Readable({
      read() {
        // emit some bytes then abort
        this.push(Buffer.alloc(64));
      },
    });

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body: Readable.toWeb(brokenReadable),
      });

      const stream = await downloadEncryptedContentSafe('https://mmg.whatsapp.net/drop-stream', {
        cipherKey,
        iv,
      });

      // Schedule brokenReadable destruction
      setTimeout(() => {
        const err = new TypeError('terminated');
        err.code = 'UND_ERR_SOCKET';
        brokenReadable.destroy(err);
      }, 20);

      const sink = new Transform({
        transform(chunk, _, cb) {
          cb(null, chunk);
        },
      });

      let caughtError = null;
      try {
        await pipeline(stream, sink);
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeTruthy();
      expect(caughtError.message).toContain('terminated');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('cleans up upstream stream when downstream aborts early (e.g. video size cap)', async () => {
    const cipherKey = Crypto.randomBytes(32);
    const iv = Crypto.randomBytes(16);

    const infiniteReadable = new Readable({
      read() {
        this.push(Buffer.alloc(1024));
      },
    });

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body: Readable.toWeb(infiniteReadable),
      });

      const stream = await downloadEncryptedContentSafe('https://mmg.whatsapp.net/infinite', {
        cipherKey,
        iv,
      });

      let bytes = 0;
      const sizeCap = 500;
      const capTransform = new Transform({
        transform(chunk, _, cb) {
          bytes += chunk.length;
          if (bytes > sizeCap) {
            const err = new Error('size cap exceeded');
            err.code = 'WA_MEDIA_TOO_LARGE';
            cb(err);
            return;
          }
          cb(null, chunk);
        },
      });

      await expect(pipeline(stream, capTransform)).rejects.toThrow('size cap exceeded');

      // Now verify infiniteReadable was destroyed cleanly and late socket error does not crash
      expect(infiniteReadable.destroyed).toBe(true);
      const lateErr = new TypeError('terminated');
      lateErr.code = 'UND_ERR_SOCKET';
      infiniteReadable.emit('error', lateErr);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('downloadMediaMessageSafe handles reupload request on status 404/410', async () => {
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    let reuploadCalled = false;

    const fakeMediaKey = Buffer.alloc(32, 1);
    const { getMediaKeys } = await import('@whiskeysockets/baileys');
    const { cipherKey, iv } = await getMediaKeys(fakeMediaKey, 'image');

    const fakeMessage = {
      key: { id: 'msg123' },
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/image1.enc',
          directPath: '/v/t62.7118-24/image1.enc',
          mediaKey: fakeMediaKey,
          mimetype: 'image/jpeg',
        },
      },
    };

    try {
      globalThis.fetch = async () => {
        attempts++;
        if (attempts === 1) {
          return {
            ok: false,
            status: 410,
            body: { cancel: async () => {} },
          };
        }
        // Second attempt succeeds with ciphertext
        const cipher = Crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
        const ct = Buffer.concat([cipher.update(Buffer.from('reuploaded-image-bytes')), cipher.final()]);
        return {
          ok: true,
          status: 200,
          body: Readable.toWeb(Readable.from([ct])),
        };
      };

      const ctx = {
        logger: { info: () => {} },
        reuploadRequest: async (msg) => {
          reuploadCalled = true;
          return msg;
        },
      };

      const buf = await downloadMediaMessageSafe(fakeMessage, 'buffer', {}, ctx);
      expect(reuploadCalled).toBe(true);
      expect(attempts).toBe(2);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.toString()).toBe('reuploaded-image-bytes');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
