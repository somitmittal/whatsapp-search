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
});
