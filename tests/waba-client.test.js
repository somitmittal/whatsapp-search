import { describe, expect, it } from '@jest/globals';
import {
  extractWabaMessageContent,
  normalizeInboundWabaMessage,
  wabaChatJid,
  wabaMessageId,
} from '../src/whatsapp/waba-client.js';

describe('waba message normalization', () => {
  it('builds stable jids and message ids', () => {
    expect(wabaChatJid('919876543210')).toBe('waba:+919876543210');
    expect(wabaMessageId('wamid.ABC')).toBe('waba:wamid.ABC');
  });

  it('extracts text messages', () => {
    const c = extractWabaMessageContent({ type: 'text', text: { body: 'Hello' } });
    expect(c.text).toBe('Hello');
    expect(c.mediaType).toBeNull();
  });

  it('extracts image caption and media id', () => {
    const c = extractWabaMessageContent({
      type: 'image',
      image: { id: 'img1', caption: 'Invoice' },
    });
    expect(c.mediaType).toBe('image');
    expect(c.mediaId).toBe('img1');
    expect(c.caption).toBe('Invoice');
  });

  it('normalizes inbound customer message row', () => {
    const row = normalizeInboundWabaMessage({
      msg: { id: 'wamid.X', from: '919811122233', type: 'text', text: { body: 'Need appointment' }, timestamp: '1700000000' },
      contactName: 'Priya',
      timestamp: '1700000000',
    });
    expect(row.chatJid).toBe('waba:+919811122233');
    expect(row.messageId).toBe('waba:wamid.X');
    expect(row.sender).toBe('Priya');
    expect(row.text).toBe('Need appointment');
    expect(row._wabaMediaId).toBeFalsy();
  });
});
