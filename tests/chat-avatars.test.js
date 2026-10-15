import { describe, expect, test } from '@jest/globals';
import {
  avatarActionForContact,
  avatarFileName,
  imageExtFromBytes,
  isAvatarEligibleJid,
  isSafeAvatarFileName,
  jidsNeedingAvatars,
  profilePictureFailure,
} from '../src/whatsapp/chat-avatars.js';

describe('isAvatarEligibleJid', () => {
  test('includes people and groups', () => {
    expect(isAvatarEligibleJid('9199@s.whatsapp.net')).toBe(true);
    expect(isAvatarEligibleJid('120363@g.us')).toBe(true);
    expect(isAvatarEligibleJid('abc@lid')).toBe(true);
  });

  test('skips imports, status, newsletters, and bots', () => {
    expect(isAvatarEligibleJid('import_family@imported')).toBe(false);
    expect(isAvatarEligibleJid('status@broadcast')).toBe(false);
    expect(isAvatarEligibleJid('123@newsletter')).toBe(false);
    expect(isAvatarEligibleJid('123@bot')).toBe(false);
    expect(isAvatarEligibleJid('')).toBe(false);
  });
});

describe('jidsNeedingAvatars', () => {
  test('keeps newest-first order and skips chats that already have a stored result', () => {
    const ordered = [
      'new@s.whatsapp.net',
      'status@broadcast',
      'done@g.us',
      'new@s.whatsapp.net',
      'old@lid',
    ];
    expect(jidsNeedingAvatars(ordered, new Set(['done@g.us']))).toEqual([
      'new@s.whatsapp.net',
      'old@lid',
    ]);
  });
});

describe('avatarActionForContact', () => {
  test('ignores ordinary contacts that never mention a picture', () => {
    expect(avatarActionForContact({ id: 'a@s.whatsapp.net', name: 'Ada' })).toBe('ignore');
    expect(avatarActionForContact({ id: 'a@s.whatsapp.net', imgUrl: null })).toBe('ignore');
  });

  test('clears, refreshes, or downloads only real picture signals', () => {
    expect(avatarActionForContact({ imgUrl: 'removed' })).toBe('clear');
    expect(avatarActionForContact({ imgUrl: 'changed' })).toBe('refresh');
    expect(avatarActionForContact({ imgUrl: 'https://cdn.example/p.jpg' })).toBe('download');
  });
});

describe('profilePictureFailure', () => {
  test('treats a hidden or absent photo as missing and a dead socket as retry', () => {
    expect(profilePictureFailure({ output: { statusCode: 404, payload: { message: 'item-not-found' } } })).toBe('missing');
    expect(profilePictureFailure({ message: 'not-authorized' })).toBe('missing');
    expect(profilePictureFailure({ message: 'Connection Closed' })).toBe('retry');
  });
});

describe('avatar files', () => {
  test('names a file from the jid and only accepts safe names', () => {
    expect(avatarFileName('9199@s.whatsapp.net', 'jpg')).toBe('9199_s.whatsapp.net.jpg');
    expect(isSafeAvatarFileName('9199_s.whatsapp.net.jpg')).toBe(true);
    expect(isSafeAvatarFileName('../x.jpg')).toBe(false);
  });

  test('recognises jpeg, png, and webp bytes', () => {
    expect(imageExtFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpg');
    const png = Buffer.alloc(12);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    expect(imageExtFromBytes(png)).toBe('png');
    const webp = Buffer.alloc(12);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    expect(imageExtFromBytes(webp)).toBe('webp');
    expect(imageExtFromBytes(Buffer.from('not an image!!'))).toBe(null);
  });
});
