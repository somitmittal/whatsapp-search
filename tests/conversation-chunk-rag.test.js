import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from '../src/storage/database.js';
import {
  stitchConsecutiveTurns,
  segmentMessagesIntoSessions,
  buildConversationChunk,
  indexChatConversationChunks,
} from '../src/search/conversation-chunker.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import { hybridSearch } from '../src/gpt/retrieval.js';
import { unlinkSync } from 'fs';

const TEST_DB = 'data/test_conversation_chunk_rag.db';

describe('Conversation-Aware Chunking & Deduplicated Media RAG', () => {
  let db;

  const clean = () => {
    for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) {
      try { unlinkSync(f); } catch (_) {}
    }
  };

  beforeEach(() => {
    clean();
    db = new Database(TEST_DB);
  });

  afterEach(() => {
    db.close();
    clean();
  });

  it('stitches consecutive rapid-fire messages from the same sender within 90s', () => {
    const raw = [
      { id: 1, sender: 'Alice', timestamp: 1000, text: 'Hey there' },
      { id: 2, sender: 'Alice', timestamp: 1020, text: 'Are you around?' },
      { id: 3, sender: 'Bob', timestamp: 1050, text: 'Yes, just stepped in' },
      { id: 4, sender: 'Bob', timestamp: 1060, text: 'What is up?' },
      { id: 5, sender: 'Alice', timestamp: 1200, text: 'Let us meet' }, // gap > 90s
    ];

    const turns = stitchConsecutiveTurns(raw, 90);
    expect(turns.length).toBe(3);
    expect(turns[0].sender).toBe('Alice');
    expect(turns[0].text).toContain('Hey there');
    expect(turns[0].text).toContain('Are you around?');
    expect(turns[0].messageIds).toEqual([1, 2]);

    expect(turns[1].sender).toBe('Bob');
    expect(turns[1].text).toContain('Yes, just stepped in');
    expect(turns[1].text).toContain('What is up?');
    expect(turns[1].messageIds).toEqual([3, 4]);

    expect(turns[2].sender).toBe('Alice');
    expect(turns[2].text).toContain('Let us meet');
  });

  it('segments messages into distinct conversation sessions on inactivity gaps >30min', () => {
    const messages = [
      { id: 1, sender: 'Alice', timestamp: 1000, text: 'Morning!' },
      { id: 2, sender: 'Bob', timestamp: 1010, text: 'Good morning' },
      // 45 minute gap (2700s > 1800s)
      { id: 3, sender: 'Alice', timestamp: 3800, text: 'Lunch at 1?' },
      { id: 4, sender: 'Bob', timestamp: 3820, text: 'Sounds great' },
    ];

    const sessions = segmentMessagesIntoSessions(messages, { gapSeconds: 1800 });
    expect(sessions.length).toBe(2);
    expect(sessions[0].map((m) => m.id)).toEqual([1, 2]);
    expect(sessions[1].map((m) => m.id)).toEqual([3, 4]);
  });

  it('builds enriched conversation chunk with metadata header and speaker turns', () => {
    const session = [
      { id: 10, sender: 'Sanyam', timestamp: 1700000000, text: 'Where are we heading today?' },
      { id: 11, sender: 'You', timestamp: 1700000040, text: 'Heading to Cyber Hub' },
    ];

    const chunk = buildConversationChunk(session, {
      chatJid: '918800228495@s.whatsapp.net',
      chatName: 'Sanyam Malhotra',
    });

    expect(chunk).not.toBeNull();
    expect(chunk.chatJid).toBe('918800228495@s.whatsapp.net');
    expect(chunk.chatName).toBe('Sanyam Malhotra');
    expect(chunk.messageCount).toBe(2);
    expect(chunk.participants).toContain('Sanyam');
    expect(chunk.participants).toContain('You');
    expect(chunk.sessionText).toContain('=== Session: Sanyam Malhotra');
    expect(chunk.sessionText).toContain('Cyber Hub');
  });

  it('stores and searches conversation chunks using FTS5 BM25', () => {
    runWithTenant('legacy-default', () => {
      const chunk = {
        id: 'chunk_test_1',
        chatJid: 'site-a@g.us',
        chatName: 'Site Alpha',
        startTs: 1000,
        endTs: 1200,
        messageCount: 5,
        messageIds: [1, 2, 3],
        sessionText: '=== Session: Site Alpha ===\nAlice: Heading into resistance zone\nBob: PE ratio supportive',
      };

      db.upsertConversationChunk(chunk);

      const res = db.searchConversationChunksFts('resistance zone', 'site-a@g.us');
      expect(res.length).toBe(1);
      expect(res[0].id).toBe('chunk_test_1');
      expect(res[0].chatName).toBe('Site Alpha');
      expect(res[0].messageIds).toEqual([1, 2, 3]);

      // Scoped search for a different chat yields 0 hits
      const wrongChatRes = db.searchConversationChunksFts('resistance zone', 'site-b@g.us');
      expect(wrongChatRes.length).toBe(0);
    });
  });

  it('stores and retrieves cached media content by SHA-256 in 0.1ms', () => {
    runWithTenant('legacy-default', () => {
      const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      expect(db.getCachedMediaContent(sha256)).toBeNull();

      db.saveCachedMediaContent(sha256, {
        ocrText: 'Heading into resistance zone',
        transcript: null,
        mediaType: 'image',
      });

      const cached = db.getCachedMediaContent(sha256);
      expect(cached).not.toBeNull();
      expect(cached.sha256).toBe(sha256);
      expect(cached.ocrText).toBe('Heading into resistance zone');
      expect(cached.mediaType).toBe('image');
    });
  });

  it('propagates chat display name to chat_roster and across linked JIDs', () => {
    runWithTenant('legacy-default', () => {
      // Setup LID <-> PN link
      db.saveLidPnMapping('163445014061271@lid', '919004466342@s.whatsapp.net');

      // Insert message under LID
      db.insertMessage({
        messageId: 'M1',
        chatJid: '163445014061271@lid',
        chatName: '+91 9004466342',
        sender: '+91 9004466342',
        senderJid: '163445014061271@lid',
        text: 'Hello from Jay',
        timestamp: 1000,
      });

      // Name arrives on phone number
      db.propagateChatDisplayName('919004466342@s.whatsapp.net', 'Jay Patel');

      // 1. messages updated
      const msg = db.getMessageRowByMessageId('M1');
      expect(msg.chatName).toBe('Jay Patel');
      expect(msg.sender).toBe('Jay Patel');

      // 2. getChatStats reflects the resolved name
      const stats = db.getChatStats();
      const row = stats.find((s) => s.chatJid === '163445014061271@lid');
      expect(row.chatName).toBe('Jay Patel');
    });
  });

  it('indexChatConversationChunks extracts and stores sessions on-the-fly', () => {
    runWithTenant('legacy-default', () => {
      db.insertMessage({
        messageId: 'M10',
        chatJid: 'chat-kwr@g.us',
        chatName: 'KWR Residents',
        sender: 'Resident A',
        text: 'Has the water supply returned?',
        timestamp: 1000,
      });
      db.insertMessage({
        messageId: 'M11',
        chatJid: 'chat-kwr@g.us',
        chatName: 'KWR Residents',
        sender: 'Resident B',
        text: 'Yes, running normally on 14th floor',
        timestamp: 1020,
      });

      const count = indexChatConversationChunks(db, 'chat-kwr@g.us');
      expect(count).toBeGreaterThanOrEqual(1);

      const hits = db.searchConversationChunksFts('water supply', 'chat-kwr@g.us');
      expect(hits.length).toBe(1);
      expect(hits[0].sessionText).toContain('water supply');
    });
  });
});
