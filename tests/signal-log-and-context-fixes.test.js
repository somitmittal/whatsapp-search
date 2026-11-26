import { describe, expect, test } from '@jest/globals';
import Database from '../src/storage/database.js';
import { runWithTenant } from '../src/storage/tenant-context.js';
import { installSignalLogFilter, isSignalSessionLog } from '../src/whatsapp/suppress-signal-logs.js';
import { contextualizeQuery } from '../src/gpt/query-decomposer.js';
import { buildSystemPrompt } from '../src/gpt/context.js';
import GptService from '../src/gpt/gpt-service.js';

describe('libsignal session key log suppression', () => {
  test('isSignalSessionLog detects libsignal SessionEntry and prefix dumps', () => {
    expect(isSignalSessionLog(['Closing session:', { currentRatchet: { ephemeralKeyPair: { pubKey: 'x', privKey: 'y' } } }])).toBe(true);
    expect(isSignalSessionLog(['Opening session:', {}])).toBe(true);
    expect(isSignalSessionLog(['Removing old closed session:', {}])).toBe(true);
    expect(isSignalSessionLog(['Closing open session in favor of incoming prekey bundle'])).toBe(true);
    expect(isSignalSessionLog(['anything', { currentRatchet: { ephemeralKeyPair: { privKey: 'secret' } } }])).toBe(true);
    expect(isSignalSessionLog(['[WA] Connected to WhatsApp'])).toBe(false);
  });

  test('installSignalLogFilter suppresses session key dumps while keeping normal logs (idempotent)', () => {
    const captured = { info: [], warn: [], log: [] };
    const fakeConsole = {
      info: (...args) => captured.info.push(args),
      warn: (...args) => captured.warn.push(args),
      log: (...args) => captured.log.push(args),
    };

    installSignalLogFilter(fakeConsole);
    installSignalLogFilter(fakeConsole);

    fakeConsole.info('Closing session:', { currentRatchet: { ephemeralKeyPair: { privKey: 'SECRET' } } });
    fakeConsole.warn('Closing open session in favor of incoming prekey bundle');
    fakeConsole.log('Session dump:', { indexInfo: {}, registrationId: 1, _chains: {} });

    fakeConsole.info('Server ready on port 3000');
    fakeConsole.warn('Slow query warning');
    fakeConsole.log('Normal log');

    expect(captured.info).toEqual([['Server ready on port 3000']]);
    expect(captured.warn).toEqual([['Slow query warning']]);
    expect(captured.log).toEqual([['Normal log']]);
  });
});

describe('follow-up query contextualization & mention prompt hygiene', () => {
  test('contextualizeQuery carries prior topic into elliptical follow-ups like "can u check in"', () => {
    const res = contextualizeQuery('can u check in', {
      prior: [
        { role: 'user', content: 'can u check latest gold price' },
        { role: 'assistant', content: 'Unable to find it in recent chats.' },
      ],
      scopeChatName: 'Atul Kumar Garg',
    });

    expect(res.isRetry).toBe(false);
    expect(res.isFollowUp).toBe(true);
    expect(res.effectiveQuery).toBe('can u check latest gold price');
    expect(res.intent.candidateEntities).toContain('Atul Kumar Garg');
  });

  test('buildSystemPrompt omits reconcile/site boilerplate unless relevant', () => {
    const db = new Database({ inMemory: true });
    const plain = buildSystemPrompt({ db, businessContext: false, includeReconcileHint: false });
    expect(plain).not.toContain('Expense comparisons in context are labelled with their site');
    expect(plain).not.toContain('CALL reconcile once with no chat arg');

    const withReconcile = buildSystemPrompt({ db, businessContext: false, includeReconcileHint: true });
    expect(withReconcile).toContain('CALL reconcile once with no chat arg');
  });

  test('GptService @mention on non-reconcile follow-up carries prior topic without reconcile hint', async () => {
    const db = new Database({ inMemory: true });
    const TENANT = 'test-tenant-gold';
    const CHAT_JID = '919999999999@s.whatsapp.net';

    let seenSystem = '';
    let seenUserMessages = [];
    const provider = {
      name: 'fake',
      model: 'fake-model',
      async chat() { return ''; },
      async *chatStream(messages) {
        const sysMsg = messages.find((m) => m.role === 'system');
        seenSystem = sysMsg ? sysMsg.content : '';
        seenUserMessages = messages.filter((m) => m.role === 'user').map((m) => m.content);
        yield 'Checked Atul Kumar Garg: no gold price messages found.';
      },
    };

    await runWithTenant(TENANT, async () => {
      db.insertMessage({
        messageId: 'm-atul-1',
        chatJid: CHAT_JID,
        chatName: 'Atul Kumar Garg',
        sender: 'Atul Kumar Garg',
        text: 'Hello, checking in',
        timestamp: 1700000000,
      });

      const gpt = new GptService({ db, getProvider: () => provider });
      await gpt.handleTurn({
        conversationId: 'gold-conv-1',
        createConversationIfMissing: true,
        message: 'can u check latest gold price',
        mentions: [],
        emit: () => {},
      });

      await gpt.handleTurn({
        conversationId: 'gold-conv-1',
        message: 'can u check in',
        mentions: [{ chatJid: CHAT_JID, chatName: 'Atul Kumar Garg' }],
        emit: () => {},
      });
    });

    const lastPrompt = seenUserMessages[seenUserMessages.length - 1] || '';
    expect(lastPrompt).toContain('Checking for: "can u check latest gold price"');
    expect(lastPrompt).toContain('@mentioned this turn: Atul Kumar Garg');
    expect(lastPrompt).not.toContain('CALL reconcile');
    expect(seenSystem).not.toContain('CALL reconcile once with no chat arg');
  });
});
