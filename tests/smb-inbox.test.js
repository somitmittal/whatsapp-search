import { describe, expect, it } from '@jest/globals';
import SmbInboxService from '../src/smb/inbox-service.js';

describe('smb inbox service', () => {
  it('returns disabled dashboard for personal profile', () => {
    const db = {
      getSetting: (k) => (k === 'smb_profile' ? 'personal' : ''),
    };
    const dash = new SmbInboxService(db).getDashboard();
    expect(dash.enabled).toBe(false);
    expect(dash.awaitingReply).toEqual([]);
  });

  it('aggregates business dashboard sections', () => {
    const db = {
      getSetting: (k) => {
        if (k === 'smb_profile') return 'd2c';
        if (k === 'smb_business_name') return 'Glow Skincare';
        return '';
      },
      getChatsAwaitingReply: () => [{
        chatJid: 'c1@imported',
        chatName: 'Riya',
        lastSender: 'Riya',
        lastText: 'Where is my order?',
        lastMessageTs: 1_700_000_000,
      }],
      getAllActionItemsAcrossChats: () => [{
        chatJid: 'c1@imported',
        chatName: 'Riya',
        sourceMessageId: 'm1',
        items: ['Send tracking link'],
        snippet: 'Where is my order?',
      }],
      searchFacts: () => [{
        id: 1,
        chatJid: 'c1@imported',
        chatName: 'Riya',
        factType: 'order',
        payloadJson: JSON.stringify({ product: 'Serum', status: 'placed' }),
        threadStart: 1,
        threadEnd: 2,
      }],
    };
    const dash = new SmbInboxService(db).getDashboard();
    expect(dash.enabled).toBe(true);
    expect(dash.businessName).toBe('Glow Skincare');
    expect(dash.profile.id).toBe('d2c');
    expect(dash.awaitingReply).toHaveLength(1);
    expect(dash.followUps).toHaveLength(1);
    expect(dash.highlights).toHaveLength(1);
    expect(dash.stats.awaitingReplyCount).toBe(1);
  });
});
