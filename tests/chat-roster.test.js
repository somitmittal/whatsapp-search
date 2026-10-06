import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

// Database reads config.dbPath at construction, so point DATA_DIR at a scratch dir
// before importing it — never touch the developer's real database.
const scratch = mkdtempSync(join(tmpdir(), 'wa-roster-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');

let db;
beforeAll(() => { db = new Database(); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const GROUP = '120363202440432920@g.us';
const NAMED = "Sovrenn Family AA Dec' 23";

const rosterRowFor = (chatJid) => db.getChatStats().find((c) => c.chatJid === chatJid);

describe('chat roster surfacing chats with no ingested messages', () => {
  test('a joined group appears in the chat list with its title before any message arrives', () => {
    db.upsertChatRoster([{ chatJid: GROUP, chatName: NAMED, lastMessageTs: 1756000000 }]);

    expect(rosterRowFor(GROUP)).toMatchObject({
      chatName: NAMED,
      messageCount: 0,
      sidebarTab: 'chat',
      awaitingSync: true,
    });
  });

  test('a later roster pass without a title cannot erase the resolved one', () => {
    db.upsertChatRoster([{ chatJid: GROUP, chatName: NAMED }]);
    db.upsertChatRoster([{ chatJid: GROUP, chatName: null }]);
    // A numeric "name" is rejected by the same guard used everywhere else.
    db.upsertChatRoster([{ chatJid: GROUP, chatName: '120363202440432920' }]);

    expect(rosterRowFor(GROUP).chatName).toBe(NAMED);
  });

  test('keeps the newest timestamp when an older roster entry arrives late', () => {
    const jid = '120363417968323534@g.us';
    db.upsertChatRoster([{ chatJid: jid, chatName: 'KWR', lastMessageTs: 1756000000 }]);
    db.upsertChatRoster([{ chatJid: jid, chatName: 'KWR', lastMessageTs: 1000 }]);

    expect(rosterRowFor(jid).lastMessageTs).toBe(1756000000);
  });

  test('ignores entries with no chat JID', () => {
    expect(db.upsertChatRoster([{ chatName: 'orphan' }, {}])).toBe(0);
    expect(db.upsertChatRoster([])).toBe(0);
  });
});

describe('roster rows yielding to real ingested chats', () => {
  test('once messages exist the chat is reported from them, not the roster stub', () => {
    const jid = '919999999999@s.whatsapp.net';
    db.upsertChatRoster([{ chatJid: jid, chatName: 'Real Person' }]);
    db.insertMessageBatch([{
      messageId: 'm1',
      chatJid: jid,
      chatName: 'Real Person',
      sender: 'Real Person',
      text: 'hello there',
      timestamp: 1756000500,
    }]);

    const row = rosterRowFor(jid);
    expect(row.messageCount).toBe(1);
    expect(row.awaitingSync).toBeUndefined();
  });

  test('sidebar last-activity uses WhatsApp roster time when it is newer than ingested messages', () => {
    const jid = '918888888888@s.whatsapp.net';
    db.insertMessageBatch([{
      messageId: 'old-fri',
      chatJid: jid,
      chatName: 'Papa',
      sender: 'Papa',
      text: 'friday',
      timestamp: 1_756_000_500,
    }]);
    db.upsertChatRoster([{ chatJid: jid, chatName: 'Papa', lastMessageTs: 1_759_000_000 }]);
    expect(rosterRowFor(jid).lastMessageTs).toBe(1_759_000_000);
  });
});

describe('countChatsWithNewestBefore', () => {
  test('counts only live chats whose newest row is older than the cutoff', () => {
    const oldJid = '120363000000000001@g.us';
    const newJid = '120363000000000002@g.us';
    db.insertMessageBatch([
      { messageId: 'o1', chatJid: oldJid, chatName: 'Old', sender: 'A', text: 'x', timestamp: 1_700_000_000 },
      { messageId: 'o2', chatJid: oldJid, chatName: 'Old', sender: 'A', text: 'y', timestamp: 1_700_000_100 },
      { messageId: 'o3', chatJid: oldJid, chatName: 'Old', sender: 'A', text: 'z', timestamp: 1_700_000_200 },
      { messageId: 'o4', chatJid: oldJid, chatName: 'Old', sender: 'A', text: 'w', timestamp: 1_700_000_300 },
      { messageId: 'o5', chatJid: oldJid, chatName: 'Old', sender: 'A', text: 'v', timestamp: 1_700_000_400 },
      { messageId: 'n1', chatJid: newJid, chatName: 'New', sender: 'B', text: 'x', timestamp: 1_800_000_000 },
      { messageId: 'n2', chatJid: newJid, chatName: 'New', sender: 'B', text: 'y', timestamp: 1_800_000_100 },
      { messageId: 'n3', chatJid: newJid, chatName: 'New', sender: 'B', text: 'z', timestamp: 1_800_000_200 },
      { messageId: 'n4', chatJid: newJid, chatName: 'New', sender: 'B', text: 'w', timestamp: 1_800_000_300 },
      { messageId: 'n5', chatJid: newJid, chatName: 'New', sender: 'B', text: 'v', timestamp: 1_800_000_400 },
    ]);
    expect(db.countChatsWithNewestBefore(1_750_000_000, { minMessages: 5 })).toBe(1);
  });
});
