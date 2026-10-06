import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'wa-msg-actions-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');

let db;
beforeAll(() => {
  db = new Database();
  db.insertMessageBatch([
    {
      messageId: 'm1',
      chatJid: '111@s.whatsapp.net',
      chatName: 'Alice',
      sender: 'You',
      senderJid: 'me@s.whatsapp.net',
      text: 'hello world',
      mediaType: null,
      mediaPath: null,
      mediaCaption: null,
      timestamp: 1700000000,
    },
    {
      messageId: 'm2',
      chatJid: '111@s.whatsapp.net',
      chatName: 'Alice',
      sender: 'Alice',
      senderJid: '111@s.whatsapp.net',
      text: 'hi back',
      mediaType: null,
      mediaPath: null,
      mediaCaption: null,
      timestamp: 1700000001,
    },
  ]);
});
afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('message action DB helpers', () => {
  test('getMessageForActions returns mediaPath field', () => {
    const row = db.getMessageForActions('111@s.whatsapp.net', 'm1');
    expect(row).toBeTruthy();
    expect(row.text).toBe('hello world');
    expect(row).toHaveProperty('mediaPath');
  });

  test('updateMessageBody edits text', () => {
    expect(db.updateMessageBody('111@s.whatsapp.net', 'm1', 'edited')).toBe(true);
    expect(db.getMessageForActions('111@s.whatsapp.net', 'm1').text).toBe('edited');
  });

  test('markMessageRevoked soft-deletes body', () => {
    expect(db.markMessageRevoked('111@s.whatsapp.net', 'm1')).toBe(true);
    const row = db.getMessageForActions('111@s.whatsapp.net', 'm1');
    expect(row.text).toBe('This message was deleted');
    expect(row.mediaType).toBeFalsy();
  });

  test('deleteMessage removes the row', () => {
    expect(db.deleteMessage('111@s.whatsapp.net', 'm2')).toBe(1);
    expect(db.getMessageForActions('111@s.whatsapp.net', 'm2')).toBeFalsy();
  });
});
