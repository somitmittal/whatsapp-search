import { describe, expect, test } from '@jest/globals';
import {
  fallbackTitleForOneOnOneJid,
  isPlausibleHumanChatTitle,
  looksLikeOpaqueNumericId,
  looksLikeUrlOrSocialJunk,
  pickBetterChatTitle,
} from '../src/whatsapp/chat-display-name.js';

describe('chat-display-name', () => {
  test('rejects URLs and Instagram paths as titles', () => {
    expect(looksLikeUrlOrSocialJunk('https://www.instagram.com/reel/DXnvSAZipR5/')).toBe(true);
    expect(isPlausibleHumanChatTitle('https://x.com/foo', '123@s.whatsapp.net')).toBe(false);
  });

  test('rejects long opaque numeric ids', () => {
    expect(looksLikeOpaqueNumericId('273980359499963')).toBe(true);
    expect(isPlausibleHumanChatTitle('273980359499963', '273980359499963@s.whatsapp.net')).toBe(false);
  });

  test('pickBetterChatTitle prefers human name over URL', () => {
    const j = '91xxxxxxxxxx@s.whatsapp.net';
    expect(pickBetterChatTitle('https://instagram.com/x', 'Alice', j)).toBe('Alice');
  });

  test('fallbackTitleForOneOnOneJid formats phone JIDs', () => {
    const t = fallbackTitleForOneOnOneJid('919876543210@s.whatsapp.net');
    expect(t).toMatch(/^\+91/);
  });
});
