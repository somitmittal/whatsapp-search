import Database from '../src/storage/database.js';
import { hybridSearch } from '../src/gpt/retrieval.js';
import GptService from '../src/gpt/gpt-service.js';

function createTempDb() {
  return new Database(':memory:');
}

describe('Implicit feedback and self-improvement loop', () => {
  test('records implicit signals and computes token-matched boosts with positive & negative weights', () => {
    const db = createTempDb();
    try {
      db.recordImplicitFeedback({
        conversationId: 'c1',
        queryText: 'what is the wifi password for guest room',
        chatJid: '111@s.whatsapp.net',
        waMessageId: 42,
        signalType: 'view_in_chat',
        weight: 1.5,
      });
      db.recordImplicitFeedback({
        conversationId: 'c1',
        queryText: 'what is the wifi password for guest room',
        chatJid: '222@g.us',
        waMessageId: 99,
        signalType: 'rephrase_negative',
        weight: -0.6,
      });

      const boosts = db.getImplicitBoostsForQuery('guest wifi password');
      expect(boosts.chatBoosts.get('111@s.whatsapp.net')).toBeGreaterThan(0.3);
      expect(boosts.messageBoosts.get(42)).toBeGreaterThan(0.3);
      expect(boosts.chatBoosts.get('222@g.us')).toBeLessThan(0);
      expect(boosts.topChatAffinities[0].chatJid).toBe('111@s.whatsapp.net');
    } finally {
      db.close();
    }
  });

  test('hybridSearch reranks equal-BM25 hits using implicit view_in_chat and negative rephrase signals', async () => {
    const db = createTempDb();
    try {
      const wrongId = db.insertMessage({
        messageId: 'm-wrong',
        chatJid: 'wrong@g.us',
        chatName: 'Random Group',
        sender: 'Bob',
        text: 'parking slot booking confirmed for Saturday',
        timestamp: 1000,
      });
      const rightId = db.insertMessage({
        messageId: 'm-right',
        chatJid: 'right@s.whatsapp.net',
        chatName: 'Binge Town',
        sender: 'Binge Town',
        text: 'parking slot booking confirmed for Saturday',
        timestamp: 1001,
      });

      // Simulate past user behavior: clicked View in chat on Binge Town, rephrased after Random Group
      db.recordImplicitFeedback({
        queryText: 'parking slot booking Saturday',
        chatJid: 'right@s.whatsapp.net',
        waMessageId: rightId,
        signalType: 'view_in_chat',
        weight: 1.5,
      });
      db.recordImplicitFeedback({
        queryText: 'parking slot booking Saturday',
        chatJid: 'wrong@g.us',
        waMessageId: wrongId,
        signalType: 'rephrase_negative',
        weight: -0.6,
      });

      const res = await hybridSearch({
        db,
        embeddings: null,
        query: 'parking slot booking',
        limit: 5,
      });

      expect(res.hits.length).toBeGreaterThanOrEqual(2);
      expect(res.hits[0].chatJid).toBe('right@s.whatsapp.net');
    } finally {
      db.close();
    }
  });

  test('GptService auto-records rephrase_negative on corrective follow-up and injects learned affinity hint', async () => {
    const db = createTempDb();
    try {
      const m1Id = db.insertMessage({
        messageId: 'm1',
        chatJid: 'c1@s.whatsapp.net',
        chatName: 'Vendor A',
        sender: 'Vendor A',
        text: 'Invoice total is 4500 INR for catering',
        timestamp: 2000,
      });

      const conv = db.createSearchConversation({ id: 'conv-implicit-1', title: 'Test' });
      db.addSearchMessage({ id: 'u1', conversationId: conv.id, role: 'user', content: 'catering invoice total' });
      db.addSearchMessage({
        id: 'a1',
        conversationId: conv.id,
        role: 'assistant',
        content: 'It was in Wrong Chat.',
        payload: {
          sources: [{ ref: 'm1', messageId: m1Id, chatJid: 'wrong@g.us', chatName: 'Wrong Chat' }],
        },
      });

      // Seed strong positive affinity for Vendor A
      db.recordImplicitFeedback({
        queryText: 'catering invoice total',
        chatJid: 'c1@s.whatsapp.net',
        waMessageId: m1Id,
        signalType: 'view_in_chat',
        weight: 2.0,
      });

      let capturedPrompt = '';
      const fakeProvider = {
        name: 'groq',
        model: 'llama-3.3-70b-versatile',
        chat: async (messages) => {
          capturedPrompt = messages.map((m) => m.content).join('\n');
          return 'The invoice total is 4500 INR [m1].';
        },
      };

      const svc = new GptService({ db, getProvider: () => fakeProvider });
      await svc.handleTurn({
        conversationId: conv.id,
        message: 'no, I meant check another chat for catering invoice total',
      });

      const negRows = db._db
        .prepare("SELECT * FROM gpt_implicit_feedback WHERE signal_type = 'rephrase_negative'")
        .all();
      expect(negRows.length).toBe(1);
      expect(negRows[0].chat_jid).toBe('wrong@g.us');
      expect(capturedPrompt).toContain('Learned affinity from past usage');
    } finally {
      db.close();
    }
  });
});
