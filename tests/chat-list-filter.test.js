import { describe, expect, test } from '@jest/globals';
import { chatTitleMatchesQuery, filterAndRankChats } from '../public/js/chat-list-filter.js';

const helpers = {
  titleFor: (c) => String(c.chatName || c.chatJid || ''),
  phoneLabelFor: (jid) => {
    const user = String(jid).split('@')[0];
    return user.length > 4 ? `+${user}` : user;
  },
};

describe('chat-list-filter', () => {
  test('chatTitleMatchesQuery matches name, jid, and phone digits', () => {
    const chat = { chatJid: '919876543210@s.whatsapp.net', chatName: 'Mom' };
    expect(chatTitleMatchesQuery(chat, 'mom', helpers)).toBe(true);
    expect(chatTitleMatchesQuery(chat, '98765', helpers)).toBe(true);
    expect(chatTitleMatchesQuery(chat, 'xyz', helpers)).toBe(false);
  });

  test('title matches sort above keyword matches and keep recency within each group', () => {
    const chats = [
      { chatJid: 'a@s.whatsapp.net', chatName: 'Alice', lastMessageTs: 10, lastMessagePreview: 'hi' },
      { chatJid: 'b@s.whatsapp.net', chatName: 'Bob', lastMessageTs: 50, lastMessagePreview: 'invoice' },
      { chatJid: 'c@s.whatsapp.net', chatName: 'Carol', lastMessageTs: 40, lastMessagePreview: 'ok' },
      { chatJid: 'd@s.whatsapp.net', chatName: 'Dan Invoice', lastMessageTs: 5, lastMessagePreview: 'yo' },
    ];
    const ranked = filterAndRankChats({
      chats,
      query: 'invoice',
      keywordHits: [
        { chatJid: 'b@s.whatsapp.net', snippet: 'Please pay the invoice', messageTs: 50 },
        { chatJid: 'c@s.whatsapp.net', snippet: 'invoice attached', messageTs: 40 },
        { chatJid: 'a@s.whatsapp.net', snippet: 'no title match here', messageTs: 10 },
      ],
      helpers,
    });
    expect(ranked.map((c) => c.chatJid)).toEqual([
      'd@s.whatsapp.net', // title hit (even if older)
      'b@s.whatsapp.net', // keyword (newer)
      'c@s.whatsapp.net',
      'a@s.whatsapp.net',
    ]);
    expect(ranked[0].chatName).toBe('Dan Invoice');
    expect(ranked.find((c) => c.chatJid === 'c@s.whatsapp.net').lastMessagePreview).toBe('invoice attached');
  });

  test('empty query returns the original chat order copy', () => {
    const chats = [
      { chatJid: 'a@x', chatName: 'A', lastMessageTs: 1 },
      { chatJid: 'b@x', chatName: 'B', lastMessageTs: 2 },
    ];
    const out = filterAndRankChats({ chats, query: '  ', helpers });
    expect(out).toEqual(chats);
    expect(out).not.toBe(chats);
  });

  test('keyword hits for unknown jids are ignored', () => {
    const chats = [{ chatJid: 'a@x', chatName: 'A', lastMessageTs: 1 }];
    const ranked = filterAndRankChats({
      chats,
      query: 'hello',
      keywordHits: [{ chatJid: 'missing@x', snippet: 'hello' }],
      helpers,
    });
    expect(ranked).toEqual([]);
  });
});
