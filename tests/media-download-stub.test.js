import { describe, expect, test } from '@jest/globals';
import { buildMediaDownloadStub, parseMediaDownloadStub } from '../src/whatsapp/media-download-stub.js';

describe('media download stub', () => {
  test('round-trips image mediaKey buffers', () => {
    const mediaKey = Buffer.from('0123456789abcdef0123456789abcdef');
    const msg = {
      key: { remoteJid: 'x@s.whatsapp.net', id: 'ABC', fromMe: false },
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          mediaKey,
          directPath: '/v/t62/x',
          url: 'https://mmg.whatsapp.net/v/t62/x',
        },
      },
    };
    const raw = buildMediaDownloadStub(msg);
    expect(typeof raw).toBe('string');
    const stub = parseMediaDownloadStub(raw);
    expect(stub.key).toEqual({ remoteJid: 'x@s.whatsapp.net', id: 'ABC', fromMe: false });
    expect(Buffer.isBuffer(stub.message.imageMessage.mediaKey)).toBe(true);
    expect(stub.message.imageMessage.mediaKey.equals(mediaKey)).toBe(true);
    expect(stub.message.imageMessage.directPath).toBe('/v/t62/x');
  });

  test('unwraps ephemeral image messages', () => {
    const raw = buildMediaDownloadStub({
      key: { remoteJid: 'g@g.us', id: '1', fromMe: true, participant: 'a@s.whatsapp.net' },
      message: {
        ephemeralMessage: {
          message: {
            imageMessage: { mimetype: 'image/jpeg', mediaKey: Buffer.from('abcd') },
          },
        },
      },
    });
    const stub = parseMediaDownloadStub(raw);
    expect(stub.key.participant).toBe('a@s.whatsapp.net');
    expect(stub.message.imageMessage.mimetype).toBe('image/jpeg');
  });
});
