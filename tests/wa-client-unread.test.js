import { describe, expect, test } from '@jest/globals';
import {
  captureUnreadCounts,
  effectiveUnreadCount,
  shouldShowGroupCatchup,
  unreadCountForChat,
} from '../src/whatsapp/unread-tracker.js';

describe('WhatsApp unread counts', () => {
  test('captures WhatsApp chat unread counts and clamps negative values', () => {
    const unreadByChat = new Map();
    captureUnreadCounts(unreadByChat, [
      { id: 'group@g.us', unreadCount: 14 },
      { id: 'read@g.us', unreadCount: -1 },
      { id: 'unknown@g.us' },
    ]);

    expect(unreadCountForChat(unreadByChat, 'group@g.us')).toBe(14);
    expect(unreadCountForChat(unreadByChat, 'read@g.us')).toBe(0);
    expect(unreadCountForChat(unreadByChat, 'unknown@g.us')).toBe(0);
  });

  test('applies later chat updates', () => {
    const unreadByChat = new Map();
    captureUnreadCounts(unreadByChat, [{ id: 'group@g.us', unreadCount: 14 }]);
    captureUnreadCounts(unreadByChat, [{ id: 'group@g.us', unreadCount: 3 }]);

    expect(unreadCountForChat(unreadByChat, 'group@g.us')).toBe(3);
  });

  test('caps WhatsApp unread state to messages available locally', () => {
    expect(effectiveUnreadCount(14, 12)).toBe(12);
    expect(effectiveUnreadCount(8, 20)).toBe(8);
  });

  test('shows group catch-up only above the requested threshold while connected', () => {
    expect(shouldShowGroupCatchup({ isGroup: true, waConnected: true, unreadCount: 11 })).toBe(true);
    expect(shouldShowGroupCatchup({ isGroup: true, waConnected: true, unreadCount: 10 })).toBe(false);
    expect(shouldShowGroupCatchup({ isGroup: false, waConnected: true, unreadCount: 20 })).toBe(false);
    expect(shouldShowGroupCatchup({ isGroup: true, waConnected: false, unreadCount: 20 })).toBe(false);
  });
});
