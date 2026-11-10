import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { isPlaceholderSenderName } from '../src/whatsapp/chat-display-name.js';

const scratch = mkdtempSync(join(tmpdir(), 'wa-resolve-senders-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');

let db;
beforeAll(() => {
  db = new Database();
});

afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('isPlaceholderSenderName', () => {
  test('correctly identifies placeholder sender names', () => {
    expect(isPlaceholderSenderName(null)).toBe(true);
    expect(isPlaceholderSenderName('')).toBe(true);
    expect(isPlaceholderSenderName('   ')).toBe(true);
    expect(isPlaceholderSenderName('Unknown')).toBe(true);
    expect(isPlaceholderSenderName('unknown')).toBe(true);
    expect(isPlaceholderSenderName('Contact (499963)')).toBe(true);
    expect(isPlaceholderSenderName('contact (1234)')).toBe(true);
    expect(isPlaceholderSenderName('273980359499963')).toBe(true);
    expect(isPlaceholderSenderName('919599814160')).toBe(true);
  });

  test('correctly identifies human and valid names', () => {
    expect(isPlaceholderSenderName('Himanshu Mittal')).toBe(false);
    expect(isPlaceholderSenderName('Alice')).toBe(false);
    expect(isPlaceholderSenderName('You')).toBe(false);
    expect(isPlaceholderSenderName('+91 95998 14160')).toBe(false);
    expect(isPlaceholderSenderName('Contact Support')).toBe(false);
  });
});

describe('database sender backfill and resolution', () => {
  test('backfills placeholder sender names in database without overwriting You or human names', () => {
    const groupJid = '12345-67890@g.us';
    const lidJid = '273980359499963@lid';
    const pnJid = '919599814160@s.whatsapp.net';

    db.insertMessageBatch([
      {
        messageId: 'gmsg1',
        chatJid: groupJid,
        chatName: 'Stock Discussion',
        sender: 'Contact (499963)',
        senderJid: lidJid,
        text: 'Kpel +20% up today',
        mediaType: null,
        mediaPath: null,
        mediaCaption: null,
        timestamp: 1700000010,
      },
      {
        messageId: 'gmsg2',
        chatJid: groupJid,
        chatName: 'Stock Discussion',
        sender: 'You',
        senderJid: lidJid,
        text: 'Nice find!',
        mediaType: null,
        mediaPath: null,
        mediaCaption: null,
        timestamp: 1700000020,
      },
      {
        messageId: 'gmsg3',
        chatJid: groupJid,
        chatName: 'Stock Discussion',
        sender: 'Existing Real Name',
        senderJid: '999999@lid',
        text: 'Another message',
        mediaType: null,
        mediaPath: null,
        mediaCaption: null,
        timestamp: 1700000030,
      },
      {
        messageId: 'direct1',
        chatJid: pnJid,
        chatName: 'Himanshu Mittal',
        sender: 'Himanshu Mittal',
        senderJid: pnJid,
        text: 'Direct chat msg',
        mediaType: null,
        mediaPath: null,
        mediaCaption: null,
        timestamp: 1700000005,
      },
    ]);

    // Check placeholder detection
    const placeholders = db.getDistinctPlaceholderSenderJids(groupJid);
    expect(placeholders).toContain(lidJid);
    expect(placeholders).not.toContain('999999@lid');

    // Check resolution from 1:1 chat
    const resolvedName = db.getResolvedSenderForJid([lidJid, pnJid]);
    expect(resolvedName).toBe('Himanshu Mittal');

    // Perform backfill
    const updatedCount = db.backfillSenderName([lidJid, pnJid], 'Himanshu Mittal');
    expect(updatedCount).toBe(1);

    // Verify gmsg1 updated, gmsg2 (You) untouched, gmsg3 untouched
    const msgs = db.getMessagesPaginated(groupJid, 10);
    const msg1 = msgs.find(m => m.messageId === 'gmsg1');
    const msg2 = msgs.find(m => m.messageId === 'gmsg2');
    const msg3 = msgs.find(m => m.messageId === 'gmsg3');

    expect(msg1.sender).toBe('Himanshu Mittal');
    expect(msg2.sender).toBe('You');
    expect(msg3.sender).toBe('Existing Real Name');

    // Check placeholder detection is now clean for lidJid
    const placeholdersAfter = db.getDistinctPlaceholderSenderJids(groupJid);
    expect(placeholdersAfter).not.toContain(lidJid);
  });
});
