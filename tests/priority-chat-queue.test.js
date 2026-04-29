import { describe, it, expect } from '@jest/globals';
import { prioritizeChatFirst } from '../src/search/priority-chat-queue.js';

describe('prioritizeChatFirst', () => {
  it('moves matching jid to front', () => {
    const q = [
      { chatJid: 'a@g.us' },
      { chatJid: 'b@s.whatsapp.net' },
      { chatJid: 'c@s.whatsapp.net' },
    ];
    expect(prioritizeChatFirst(q, 'c@s.whatsapp.net')).toBe(true);
    expect(q.map((x) => x.chatJid)).toEqual(['c@s.whatsapp.net', 'a@g.us', 'b@s.whatsapp.net']);
  });

  it('no-op when already first', () => {
    const q = [{ chatJid: 'x@s.whatsapp.net' }, { chatJid: 'y@s.whatsapp.net' }];
    expect(prioritizeChatFirst(q, 'x@s.whatsapp.net')).toBe(false);
    expect(q[0].chatJid).toBe('x@s.whatsapp.net');
  });

  it('no-op when missing', () => {
    const q = [{ chatJid: 'a@x' }];
    expect(prioritizeChatFirst(q, 'missing@z')).toBe(false);
    expect(q.length).toBe(1);
  });

  it('no-op when fewer than 2 items', () => {
    const q = [{ chatJid: 'only@x' }];
    expect(prioritizeChatFirst(q, 'only@x')).toBe(false);
  });
});
