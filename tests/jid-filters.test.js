import { describe, expect, test } from '@jest/globals';
import {
  isWhatsAppLowPriorityFeed,
  sidebarTabForJid,
  isImportedChatJid,
  isChatVisibleInSidebar,
  SIDEBAR_TAB_CHAT,
  SIDEBAR_TAB_FEED,
  SIDEBAR_TAB_IMPORTED,
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
    expect(sidebarTabForJid('120363123456@g.us')).toBe(SIDEBAR_TAB_CHAT);
  });

  test('import archives get their own tab, not the live chat tab', () => {
    expect(sidebarTabForJid('import_family_group@imported')).toBe(SIDEBAR_TAB_IMPORTED);
  });
});

describe('isImportedChatJid', () => {
  test('matches import archives only', () => {
    expect(isImportedChatJid('import_family_group@imported')).toBe(true);
    expect(isImportedChatJid('919811111111@s.whatsapp.net')).toBe(false);
    expect(isImportedChatJid('120363123456@g.us')).toBe(false);
    expect(isImportedChatJid(null)).toBe(false);
  });
});

describe('isChatVisibleInSidebar', () => {
  test('WhatsApp offline hides WA-synced chats but keeps imports', () => {
    expect(isChatVisibleInSidebar('import_family_group@imported', false)).toBe(true);
    expect(isChatVisibleInSidebar('919811111111@s.whatsapp.net', false)).toBe(false);
    expect(isChatVisibleInSidebar('120363123456@g.us', false)).toBe(false);
    expect(isChatVisibleInSidebar('status@broadcast', false)).toBe(false);
  });

  test('WhatsApp live makes every chat visible', () => {
    expect(isChatVisibleInSidebar('919811111111@s.whatsapp.net', true)).toBe(true);
    expect(isChatVisibleInSidebar('120363123456@g.us', true)).toBe(true);
    expect(isChatVisibleInSidebar('import_family_group@imported', true)).toBe(true);
  });
});
