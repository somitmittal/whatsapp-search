import { describe, expect, test } from '@jest/globals';
import {
  chatNameFromFilename,
  isLikelyWhatsAppExportFilename,
  collectAttachmentsFromPayload,
} from '../src/gmail/gmail-sync.js';

describe('chatNameFromFilename', () => {
  test('strips WhatsApp Chat prefix and extension', () => {
    expect(chatNameFromFilename('WhatsApp Chat with Alice.txt')).toBe('Alice');
    expect(chatNameFromFilename('WhatsApp Chat with Bob.zip')).toBe('Bob');
  });
});

describe('isLikelyWhatsAppExportFilename', () => {
  test('accepts typical export names', () => {
    expect(isLikelyWhatsAppExportFilename('WhatsApp Chat with X.txt')).toBe(true);
    expect(isLikelyWhatsAppExportFilename('WhatsApp Chat with Y.zip')).toBe(true);
  });
  test('rejects unrelated files', () => {
    expect(isLikelyWhatsAppExportFilename('notes.txt')).toBe(false);
    expect(isLikelyWhatsAppExportFilename('')).toBe(false);
  });
});

describe('collectAttachmentsFromPayload', () => {
  test('walks nested parts', () => {
    const out = [];
    collectAttachmentsFromPayload(
      {
        parts: [
          { mimeType: 'text/plain', body: {} },
          {
            filename: 'WhatsApp Chat with Z.zip',
            body: { attachmentId: 'abc' },
          },
        ],
      },
      out,
    );
    expect(out).toEqual([{ filename: 'WhatsApp Chat with Z.zip', attachmentId: 'abc' }]);
  });
});
