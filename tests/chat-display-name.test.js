import { describe, expect, test } from '@jest/globals';
import {
  fallbackTitleForOneOnOneJid,
  formatPhoneLocalPart,
  isPlausibleHumanChatTitle,
  looksLikeLidFallbackContactLabel,
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

  test('looksLikeLidFallbackContactLabel detects WA LID placeholder titles', () => {
    expect(looksLikeLidFallbackContactLabel('Contact (1212)')).toBe(true);
    expect(looksLikeLidFallbackContactLabel('contact (91)')).toBe(true);
    expect(looksLikeLidFallbackContactLabel('Alice')).toBe(false);
    expect(looksLikeLidFallbackContactLabel('+91 6364922194')).toBe(false);
  });

  test('pickBetterChatTitle prefers formatted phone over Contact (…) placeholder', () => {
    const canon = '919000012345@s.whatsapp.net';
    const phone = formatPhoneLocalPart('919000012345');
    expect(pickBetterChatTitle('Contact (1212)', phone, canon)).toBe(phone);
    expect(pickBetterChatTitle(phone, 'Contact (1212)', canon)).toBe(phone);
  });

  test('isPlausibleHumanChatTitle rejects Contact (…) placeholders', () => {
    expect(isPlausibleHumanChatTitle('Contact (1212)', 'xxx@lid')).toBe(false);
  });
});
