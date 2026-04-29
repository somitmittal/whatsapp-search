import { describe, test, expect } from '@jest/globals';
import { groupStatusBroadcastRows } from '../src/status/status-feed.js';

describe('groupStatusBroadcastRows', () => {
  test('places My status first and groups contacts by sender JID', () => {
    const rows = [
      {
        messageId: 'a',
        sender: 'You',
        senderJid: null,
        text: 'mine',
        mediaType: null,
        mediaPath: null,
        mediaCaption: null,
        timestamp: 50,
      },
      {
        messageId: 'b',
        sender: 'Alice',
        senderJid: '111@s.whatsapp.net',
        text: 'hello',
        mediaType: null,
        mediaPath: null,
        mediaCaption: null,
        timestamp: 20,
      },
      {
        messageId: 'c',
        sender: 'Alice',
        senderJid: '111@s.whatsapp.net',
        text: 'again',
        mediaType: null,
        mediaPath: null,
        mediaCaption: null,
        timestamp: 40,
      },
    ];
    const { peers, statusJid } = groupStatusBroadcastRows(rows, 10);
    expect(statusJid).toBe('status@broadcast');
    expect(peers.length).toBe(2);
    expect(peers[0].peerKey).toBe('__me__');
    expect(peers[1].peerKey).toBe('111@s.whatsapp.net');
    expect(peers[1].items.length).toBe(2);
    expect(peers[1].latestTs).toBe(40);
  });
});
