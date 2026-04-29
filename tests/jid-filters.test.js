import { describe, expect, test } from '@jest/globals';
import {
  isWhatsAppLowPriorityFeed,
  sidebarTabForJid,
  SIDEBAR_TAB_CHAT,
  SIDEBAR_TAB_FEED,
} from '../src/whatsapp/jid-filters.js';

describe('isWhatsAppLowPriorityFeed', () => {
  test('marks Status / Stories and broadcast feeds', () => {
    expect(isWhatsAppLowPriorityFeed('status@broadcast')).toBe(true);
    expect(isWhatsAppLowPriorityFeed('something@broadcast')).toBe(true);
  });
  test('marks newsletters and bots', () => {
    expect(isWhatsAppLowPriorityFeed('123@newsletter')).toBe(true);
    expect(isWhatsAppLowPriorityFeed('x@bot')).toBe(true);
  });
  test('normal chats are not feeds', () => {
    expect(isWhatsAppLowPriorityFeed('919811111111@s.whatsapp.net')).toBe(false);
    expect(isWhatsAppLowPriorityFeed('120363123456@g.us')).toBe(false);
  });
});

describe('sidebarTabForJid', () => {
  test('maps feeds vs chats', () => {
    expect(sidebarTabForJid('status@broadcast')).toBe(SIDEBAR_TAB_FEED);
    expect(sidebarTabForJid('919811111111@s.whatsapp.net')).toBe(SIDEBAR_TAB_CHAT);
  });
});
