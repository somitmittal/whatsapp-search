import { describe, it, expect } from '@jest/globals';
import { prioritizeChatFirst, sortChatsForIndexing } from '../src/search/priority-chat-queue.js';

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

describe('sortChatsForIndexing', () => {
  // Highest score = most recent × busiest, so a bare sort would put the WA group first.
  const scores = {
    'busy@g.us': 100,
    'import_archive@imported': 10,
    'quiet@s.whatsapp.net': 5,
    'status@broadcast': 50,
  };
  const indexScore = (jid) => scores[jid] ?? 0;
  const queue = () => [
    { chatJid: 'quiet@s.whatsapp.net' },
    { chatJid: 'busy@g.us' },
    { chatJid: 'status@broadcast' },
    { chatJid: 'import_archive@imported' },
  ];

  it('puts imported archives first while WhatsApp is offline', () => {
    const q = sortChatsForIndexing(queue(), { waLive: false, indexScore });
    expect(q[0].chatJid).toBe('import_archive@imported');
  });

  it('ranks purely by score and feed tier once WhatsApp is live', () => {
    const q = sortChatsForIndexing(queue(), { waLive: true, indexScore });
    expect(q.map((x) => x.chatJid)).toEqual([
      'busy@g.us',
      'import_archive@imported',
      'quiet@s.whatsapp.net',
      'status@broadcast',
    ]);
  });

  it('keeps feeds behind real chats within the hidden tier', () => {
    const q = sortChatsForIndexing(queue(), { waLive: false, indexScore });
    expect(q.map((x) => x.chatJid)).toEqual([
      'import_archive@imported',
      'busy@g.us',
      'quiet@s.whatsapp.net',
      'status@broadcast',
    ]);
  });
});
