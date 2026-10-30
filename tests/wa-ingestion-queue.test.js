import { describe, expect, test } from '@jest/globals';
import {
  sortDeferredMediaByChatActivity,
  takeNextDeferredMediaItem,
} from '../src/whatsapp/media-download-priority.js';

describe('deferred WhatsApp media priority', () => {
  test('orders media by recent chat activity, then message recency', () => {
    const now = 2_000_000_000;
    const queue = [
      { row: { messageId: 'old-chat', chatJid: 'old@g.us', timestamp: now - 30 * 86400 } },
      { row: { messageId: 'recent-older', chatJid: 'recent@g.us', timestamp: now - 2 * 86400 } },
      { row: { messageId: 'recent-newer', chatJid: 'recent@g.us', timestamp: now - 86400 } },
    ];

    sortDeferredMediaByChatActivity(queue, now - 5 * 86400);

    expect(queue.map(({ row }) => row.messageId)).toEqual([
      'recent-newer',
      'recent-older',
      'old-chat',
    ]);
  });

  test('prioritizes a recently active chat even when one media item in it is older', () => {
    const now = 2_000_000_000;
    const queue = [
      { row: { messageId: 'middle', chatJid: 'middle@g.us', timestamp: now - 20 * 86400 } },
      { row: { messageId: 'recent-chat-old-media', chatJid: 'recent@g.us', timestamp: now - 40 * 86400 } },
      { row: { messageId: 'recent-chat-new-media', chatJid: 'recent@g.us', timestamp: now - 86400 } },
    ];

    sortDeferredMediaByChatActivity(queue, now - 5 * 86400);

    expect(queue.map(({ row }) => row.messageId)).toEqual([
      'recent-chat-new-media',
      'recent-chat-old-media',
      'middle',
    ]);
  });

  test('downloads Status and newsletter media after every real conversation', () => {
    const now = 2_000_000_000;
    const queue = [
      { row: { messageId: 'status-today', chatJid: 'status@broadcast', timestamp: now } },
      { row: { messageId: 'newsletter-today', chatJid: '1234@newsletter', timestamp: now } },
      { row: { messageId: 'stale-chat', chatJid: 'old@g.us', timestamp: now - 300 * 86400 } },
    ];

    sortDeferredMediaByChatActivity(queue, now - 5 * 86400);

    expect(queue.map(({ row }) => row.messageId)).toEqual([
      'stale-chat',
      'status-today',
      'newsletter-today',
    ]);
  });

  test('explicit priority chat drains before other conversations', () => {
    const now = 2_000_000_000;
    const queue = [
      { row: { messageId: 'recent', chatJid: 'recent@g.us', timestamp: now } },
      { row: { messageId: 'focus-old', chatJid: 'focus@g.us', timestamp: now - 40 * 86400 } },
    ];

    sortDeferredMediaByChatActivity(queue, now - 5 * 86400, 'focus@g.us');

    expect(queue.map(({ row }) => row.messageId)).toEqual([
      'focus-old',
      'recent',
    ]);
  });

  test('while history syncs, only priority-chat media is taken', () => {
    const queue = [
      { row: { messageId: 'a', chatJid: 'a@g.us' } },
      { row: { messageId: 'focus', chatJid: 'focus@g.us' } },
      { row: { messageId: 'b', chatJid: 'b@g.us' } },
    ];
    expect(takeNextDeferredMediaItem(queue, { historyDone: false, priorityChatJid: 'focus@g.us' })?.row?.messageId)
      .toBe('focus');
    expect(queue.map(({ row }) => row.messageId)).toEqual(['a', 'b']);
    expect(takeNextDeferredMediaItem(queue, { historyDone: false, priorityChatJid: 'focus@g.us' })).toBeNull();
  });

  test('after history completes, media drains FIFO from the front', () => {
    const queue = [
      { row: { messageId: 'first', chatJid: 'a@g.us' } },
      { row: { messageId: 'second', chatJid: 'b@g.us' } },
    ];
    expect(takeNextDeferredMediaItem(queue, { historyDone: true })?.row?.messageId).toBe('first');
    expect(takeNextDeferredMediaItem(queue, { historyDone: true })?.row?.messageId).toBe('second');
    expect(queue).toHaveLength(0);
  });
});
