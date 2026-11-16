import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import Database from '../src/storage/database.js';
import ChatDirectory from '../src/gpt/chat-directory.js';
import { runWithTenant } from '../src/storage/tenant-context.js';

describe('Ask AI Chat Scope & LID-PN Aliasing', () => {
  let db;
  let tenantId;

  beforeEach(() => {
    tenantId = `tenant-scope-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    db = new Database();
  });

  afterEach(() => {
    try { db.close(); } catch (_) {}
  });

  it('saves and resolves LID <-> PN mappings', async () => {
    await runWithTenant(tenantId, async () => {
      const lid = '108319259758724@lid';
      const pn = '918618976974@s.whatsapp.net';

      expect(db.saveLidPnMapping(lid, pn)).toBe(true);
      expect(db.getLinkedJids(pn)).toEqual(expect.arrayContaining([pn, lid]));
      expect(db.getLinkedJids(lid)).toEqual(expect.arrayContaining([lid, pn]));

      // Groups are never linked to personal JIDs
      const groupJid = '120363417968323534@g.us';
      expect(db.getLinkedJids(groupJid)).toEqual([groupJid]);
    });
  });

  it('ChatDirectory resolves phone JID to LID chat without matching unrelated group chats', async () => {
    await runWithTenant(tenantId, async () => {
      const lid = '108319259758724@lid';
      const pn = '918618976974@s.whatsapp.net';
      const unrelatedGroup = '120363417968323534@g.us';

      // Save mapping
      db.saveLidPnMapping(lid, pn);

      // Insert messages into The Binge Town (under LID)
      db.insertMessageBatch([
        {
          messageId: 'binge-1',
          chatJid: lid,
          chatName: 'The Binge Town',
          sender: 'The Binge Town',
          text: 'Hello there! We caught you checking out slots on our website for 29/11',
          timestamp: 1731600000,
        },
      ]);

      // Insert messages into an unrelated group mentioning whatsapp/net links
      db.insertMessageBatch([
        {
          messageId: 'group-1',
          chatJid: unrelatedGroup,
          chatName: 'KWR - Moved-In Families',
          sender: 'Resident',
          text: 'Join the whatsapp group at https://chat.whatsapp.net/xyz and check parking slots',
          timestamp: 1731600001,
        },
      ]);

      const dir = new ChatDirectory(db);

      // Resolving with phone number JID MUST resolve to The Binge Town, NOT the unrelated group!
      const resolvedFromPn = dir.resolve(pn);
      expect(resolvedFromPn).not.toBeNull();
      expect(resolvedFromPn.chatName).toBe('The Binge Town');
      expect(resolvedFromPn.chatJid).toBe(lid);

      // Resolving with LID directly
      const resolvedFromLid = dir.resolve(lid);
      expect(resolvedFromLid).not.toBeNull();
      expect(resolvedFromLid.chatName).toBe('The Binge Town');

      // Resolving with chat name
      const resolvedFromName = dir.resolve('The Binge Town');
      expect(resolvedFromName).not.toBeNull();
      expect(resolvedFromName.chatName).toBe('The Binge Town');

      // Check name resolution
      expect(dir.name(pn)).toBe('The Binge Town');
      expect(dir.name(lid)).toBe('The Binge Town');

      // An unknown JID MUST NOT fall through to message search and MUST NOT return the unrelated group
      const unknownJid = '919999999999@s.whatsapp.net';
      const resolvedUnknown = dir.resolve(unknownJid);
      expect(resolvedUnknown?.chatJid).not.toBe(unrelatedGroup);
    });
  });

  it('searchMessages finds messages stored under LID when queried with linked PN', async () => {
    await runWithTenant(tenantId, async () => {
      const lid = '108319259758724@lid';
      const pn = '918618976974@s.whatsapp.net';
      const unrelatedGroup = '120363417968323534@g.us';

      db.saveLidPnMapping(lid, pn);

      // The Binge Town has slot booking messages
      db.insertMessageBatch([
        {
          messageId: 'b-1',
          chatJid: lid,
          chatName: 'The Binge Town',
          sender: 'The Binge Town',
          text: 'Slots are available for booking on 29th Nov for 10 people at Rs 750',
          timestamp: 1731600000,
        },
      ]);

      // Unrelated group also has slot messages (e.g. parking slots)
      db.insertMessageBatch([
        {
          messageId: 'g-1',
          chatJid: unrelatedGroup,
          chatName: 'KWR - Moved-In Families',
          sender: 'Facility',
          text: 'Vacant parking slots are available for tower B',
          timestamp: 1731600002,
        },
      ]);

      // Searching with PN JID must return The Binge Town messages and ONLY The Binge Town messages
      const hitsWithPn = db.searchMessages('slot 29th nov', pn, 10);
      expect(hitsWithPn.length).toBeGreaterThanOrEqual(1);
      expect(hitsWithPn[0].chatName).toBe('The Binge Town');
      expect(hitsWithPn[0].text).toContain('750');
      // Must NOT include the parking slot message from the unrelated group
      expect(hitsWithPn.some((h) => h.chatJid === unrelatedGroup)).toBe(false);

      // Searching in range with PN JID
      const hitsInRange = db.searchMessagesInRange('slot', { chatJid: pn, limit: 10 });
      expect(hitsInRange.length).toBeGreaterThanOrEqual(1);
      expect(hitsInRange[0].chatName).toBe('The Binge Town');
      expect(hitsInRange.some((h) => h.chatJid === unrelatedGroup)).toBe(false);
    });
  });
});
