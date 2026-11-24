import { describe, expect, test } from '@jest/globals';
import Database from '../src/storage/database.js';
import WaClient from '../src/whatsapp/wa-client.js';
import { buildMediaDownloadStub, parseMediaDownloadStub } from '../src/whatsapp/media-download-stub.js';
import { renderQuotedPreviewHtml } from '../public/js/messages-render.js';

describe('image reply and deviceSentMessage media display', () => {
  test('buildMediaDownloadStub unwraps deviceSentMessage wrapper from phone send', () => {
    const mediaKey = Buffer.from('phone-outbound-media-key-1234567');
    const msg = {
      key: { remoteJid: '1234567890@s.whatsapp.net', id: 'PHONE_MSG_ID', fromMe: true },
      message: {
        deviceSentMessage: {
          destinationJid: '1234567890@s.whatsapp.net',
          message: {
            imageMessage: {
              mimetype: 'image/jpeg',
              mediaKey,
              directPath: '/v/t62/phone_upload',
              caption: 'Sent from phone with reply',
            },
          },
        },
      },
    };

    const raw = buildMediaDownloadStub(msg);
    expect(typeof raw).toBe('string');
    const parsed = parseMediaDownloadStub(raw);
    expect(parsed.key.id).toBe('PHONE_MSG_ID');
    expect(parsed.message.imageMessage.mimetype).toBe('image/jpeg');
    expect(parsed.message.imageMessage.caption).toBe('Sent from phone with reply');
    expect(Buffer.isBuffer(parsed.message.imageMessage.mediaKey)).toBe(true);
    expect(parsed.message.imageMessage.mediaKey.equals(mediaKey)).toBe(true);
  });

  test('WaClient._buildQuotedPayloadFromInner extracts quoted image thumbnail and metadata', () => {
    const client = new WaClient({ authDir: '/tmp/test-wa-auth' });
    const fakeThumb = Buffer.from('fake-jpeg-thumb-bytes');
    const inner = {
      extendedTextMessage: {
        text: 'This is a reply to an image',
        contextInfo: {
          stanzaId: 'ORIGINAL_IMG_MID',
          participant: '447123456789@s.whatsapp.net',
          quotedMessage: {
            imageMessage: {
              caption: 'Check out this screenshot',
              jpegThumbnail: fakeThumb,
            },
          },
        },
      },
    };

    const qPayload = client._buildQuotedPayloadFromInner(inner, '447123456789@s.whatsapp.net', { key: { fromMe: false } });
    expect(qPayload).not.toBeNull();
    expect(qPayload.messageId).toBe('ORIGINAL_IMG_MID');
    expect(qPayload.mediaType).toBe('image');
    expect(qPayload.text).toBe('Check out this screenshot');
    expect(qPayload.thumbData).toBe(`data:image/jpeg;base64,${fakeThumb.toString('base64')}`);
  });

  test('WaClient._buildQuotedProto formats image quotes properly', () => {
    const client = new WaClient({ authDir: '/tmp/test-wa-auth' });
    const row = {
      chatJid: '447123456789@s.whatsapp.net',
      messageId: 'IMG_TO_QUOTE',
      sender: 'Alice',
      senderJid: '447123456789@s.whatsapp.net',
      mediaType: 'image',
      mediaCaption: 'A beautiful sunset',
    };

    const proto = client._buildQuotedProto(row, '447123456789@s.whatsapp.net');
    expect(proto.key.id).toBe('IMG_TO_QUOTE');
    expect(proto.message.imageMessage).toBeDefined();
    expect(proto.message.imageMessage.caption).toBe('A beautiful sunset');
  });

  test('Database persists and retrieves quoted_payload', () => {
    const db = new Database({ inMemory: true });
    const chatJid = 'test-reply-chat@s.whatsapp.net';
    const qData = {
      messageId: 'ORIGINAL_1',
      sender: 'Alice',
      mediaType: 'image',
      text: 'Original image caption',
      thumbData: 'data:image/jpeg;base64,QUJDRA==',
    };

    db.insertMessage({
      messageId: 'REPLY_MSG_1',
      chatJid,
      chatName: 'Alice',
      sender: 'You',
      text: 'My reply text',
      timestamp: 1700000000,
      quotedPayload: JSON.stringify(qData),
    });

    const rows = db.getMessagesPaginated(chatJid, { limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0].messageId).toBe('REPLY_MSG_1');
    expect(rows[0].quotedPayload).toBe(JSON.stringify(qData));

    const actionRow = db.getMessageForActions(chatJid, 'REPLY_MSG_1');
    expect(actionRow).not.toBeNull();
    expect(actionRow.quotedPayload).toBe(JSON.stringify(qData));
  });

  test('renderQuotedPreviewHtml builds interactive quoted element with thumbnail and text', () => {
    const payload = {
      messageId: 'TARGET_MSG_123',
      sender: 'Bob',
      mediaType: 'image',
      text: 'Original photo',
      thumbData: 'data:image/jpeg;base64,dGVzdA==',
    };

    const html = renderQuotedPreviewHtml(payload);
    expect(html).toContain('msg-quote-inline');
    expect(html).toContain('data-quoted-mid="TARGET_MSG_123"');
    expect(html).toContain('wa-quote-head');
    expect(html).toContain('Bob');
    expect(html).toContain('wa-quote-thumb');
    expect(html).toContain('data:image/jpeg;base64,dGVzdA==');
    expect(html).toContain('Original photo');
  });
});
