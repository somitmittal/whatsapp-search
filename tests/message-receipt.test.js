import { describe, expect, test } from '@jest/globals';
import {
  chatListPreview,
  higherReceipt,
  normalizeReceiptStatus,
  receiptAfterSuccessfulRelay,
  receiptFromGroupReceipt,
  receiptKind,
} from '../src/whatsapp/message-receipt.js';

describe('normalizeReceiptStatus', () => {
  test('accepts Baileys numbers and names', () => {
    expect(normalizeReceiptStatus(2)).toBe(2);
    expect(normalizeReceiptStatus('READ')).toBe(4);
    expect(normalizeReceiptStatus('PLAYED')).toBe(5);
    expect(normalizeReceiptStatus('3')).toBe(3);
  });

  test('rejects unknown values', () => {
    expect(normalizeReceiptStatus(null)).toBe(null);
    expect(normalizeReceiptStatus('nope')).toBe(null);
    expect(normalizeReceiptStatus(9)).toBe(null);
  });
});

describe('receiptKind', () => {
  test('maps ticks the way WhatsApp draws them', () => {
    expect(receiptKind(1)).toBe('pending');
    expect(receiptKind(2)).toBe('sent');
    expect(receiptKind(3)).toBe('delivered');
    expect(receiptKind(4)).toBe('read');
    expect(receiptKind(5)).toBe('read');
    expect(receiptKind(null)).toBe('');
  });
});

describe('receiptAfterSuccessfulRelay', () => {
  test('a relay that returned still-pending is a sent tick', () => {
    expect(receiptAfterSuccessfulRelay(1)).toBe(2);
    expect(receiptAfterSuccessfulRelay(null)).toBe(2);
    expect(receiptAfterSuccessfulRelay(4)).toBe(4);
  });
});

describe('receiptFromGroupReceipt', () => {
  test('maps group delivery and read onto the message you sent', () => {
    expect(receiptFromGroupReceipt({
      key: { remoteJid: 'fam@g.us', id: 'abc', fromMe: true },
      receipt: { userJid: '1@s.whatsapp.net', receiptTimestamp: 10 },
    })).toEqual({ chatJid: 'fam@g.us', messageId: 'abc', receiptStatus: 3 });
    expect(receiptFromGroupReceipt({
      key: { remoteJid: 'fam@g.us', id: 'abc', fromMe: true },
      receipt: { userJid: '1@s.whatsapp.net', readTimestamp: 11 },
    }).receiptStatus).toBe(4);
    expect(receiptFromGroupReceipt({
      key: { remoteJid: 'fam@g.us', id: 'abc', fromMe: false },
      receipt: { receiptTimestamp: 10 },
    })).toBe(null);
  });
});

describe('higherReceipt', () => {
  test('does not let a replayed sent-ack erase read', () => {
    expect(higherReceipt(4, 2)).toBe(4);
    expect(higherReceipt(2, 4)).toBe(4);
    expect(higherReceipt(null, 'DELIVERY_ACK')).toBe(3);
    expect(higherReceipt(3, null)).toBe(3);
  });
});

describe('chatListPreview', () => {
  test('prefixes the sender in a group and leaves your own line bare', () => {
    expect(chatListPreview({
      text: 'Jai mata di',
      sender: 'Sarwan Kumar Gupta',
      isGroup: true,
    })).toBe('Sarwan Kumar Gupta: Jai mata di');
    expect(chatListPreview({
      text: 'Hi Sumit',
      sender: 'You',
      isGroup: false,
    })).toBe('Hi Sumit');
  });

  test('uses a media label when there is no text', () => {
    expect(chatListPreview({ text: '[image]', mediaType: 'image', sender: 'Ada', isGroup: false })).toBe('Photo');
  });
});
