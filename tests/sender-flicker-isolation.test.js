import { describe, expect, test } from '@jest/globals';
import { eventTouchesChat } from '../public/js/util.js';
import { applyResolvedSenderNamesToDom } from '../public/js/messages-render.js';
import { store } from '../public/js/store.js';

describe('eventTouchesChat isolation', () => {
  const activeJid = '918679459059@s.whatsapp.net';
  const activeLid = '12345678@lid';
  const linkedJids = [activeLid];

  test('returns false when data.chatJid belongs to a different chat', () => {
    const data = {
      chatJid: '919810123456@s.whatsapp.net',
      updates: [{ senderJid: '919810123456@s.whatsapp.net', sender: 'Sanyam Malhotra' }],
    };
    expect(eventTouchesChat(data, activeJid, linkedJids)).toBe(false);
  });

  test('returns true when data.chatJid matches activeChat or linked alias', () => {
    expect(eventTouchesChat({ chatJid: activeJid }, activeJid, linkedJids)).toBe(true);
    expect(eventTouchesChat({ chatJid: activeLid }, activeJid, linkedJids)).toBe(true);
  });

  test('filters by chatTouches array when chatJid is absent', () => {
    const untouched = {
      chatTouches: [{ chatJid: '919810123456@s.whatsapp.net' }, { chatJid: '919999999999@s.whatsapp.net' }],
    };
    expect(eventTouchesChat(untouched, activeJid, linkedJids)).toBe(false);

    const touched = {
      chatTouches: [{ chatJid: '919810123456@s.whatsapp.net' }, { chatJid: activeLid }],
    };
    expect(eventTouchesChat(touched, activeJid, linkedJids)).toBe(true);
  });

  test('filters by updates array when neither chatJid nor chatTouches is provided', () => {
    const otherUpdates = {
      updates: [{ senderJid: '919810123456@s.whatsapp.net', sender: 'Sanyam Malhotra' }],
    };
    expect(eventTouchesChat(otherUpdates, activeJid, linkedJids)).toBe(false);

    const myUpdates = {
      updates: [{ senderJid: activeJid, sender: 'Karan' }],
    };
    expect(eventTouchesChat(myUpdates, activeJid, linkedJids)).toBe(true);
  });

  test('allows untargeted broadcasts through', () => {
    expect(eventTouchesChat({ refreshActive: true }, activeJid, linkedJids)).toBe(true);
    expect(eventTouchesChat({ chatTouches: [] }, activeJid, linkedJids)).toBe(true);
  });

  test('returns false for null/missing inputs', () => {
    expect(eventTouchesChat(null, activeJid)).toBe(false);
    expect(eventTouchesChat({}, null)).toBe(false);
  });
});

describe('applyResolvedSenderNamesToDom DOM isolation', () => {
  test('does not overwrite open chat bubbles when updates belong to another contact', () => {
    // Set up mock DOM
    const mockElements = [];
    const createMockEl = (textContent, senderJid) => {
      const el = {
        textContent,
        classList: { contains: (cls) => cls === 'sender-direct' },
        closest: (cls) => ({ classList: { contains: () => true } }),
        getAttribute: (attr) => (attr === 'data-sender-jid' ? senderJid : null),
        style: {},
      };
      mockElements.push(el);
      return el;
    };

    const karanEl1 = createMockEl('Karan', '918679459059@s.whatsapp.net');
    const karanEl2 = createMockEl('Karan', '918679459059@s.whatsapp.net');

    globalThis.document = {
      querySelectorAll: (sel) => {
        if (sel.includes('.sender-direct')) {
          return mockElements;
        }
        return [];
      },
    };

    // Store has Karan open
    store.activeChat = '918679459059@s.whatsapp.net';
    store.activeChatLinkedJids = ['918679459059@s.whatsapp.net', '12345678@lid'];

    // Updates arrive for Sanyam Malhotra
    applyResolvedSenderNamesToDom('919810123456@s.whatsapp.net', [
      { senderJid: '919810123456@s.whatsapp.net', sender: 'Sanyam Malhotra' },
    ]);

    // Karan's elements must NOT have been changed to Sanyam Malhotra!
    expect(karanEl1.textContent).toBe('Karan');
    expect(karanEl2.textContent).toBe('Karan');

    // Updates arrive for Karan
    applyResolvedSenderNamesToDom('918679459059@s.whatsapp.net', [
      { senderJid: '918679459059@s.whatsapp.net', sender: 'Karan Mittal' },
    ]);

    expect(karanEl1.textContent).toBe('Karan Mittal');
    expect(karanEl2.textContent).toBe('Karan Mittal');

    delete globalThis.document;
  });
});
