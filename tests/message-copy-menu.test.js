import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  buildChatMessagesHtml,
  extractMessageCopyText,
  getMessageBlockCopyText,
  copyTextToClipboard,
  handleMessageCopyClick,
  showMessageToast,
} from '../public/js/messages-render.js';
import { store } from '../public/js/store.js';

describe('Message Dropdown Copy Option', () => {
  let prevWaState;

  beforeEach(() => {
    prevWaState = store._waState;
    store._waState = 'READY';
  });

  afterEach(() => {
    store._waState = prevWaState;
  });

  describe('extractMessageCopyText', () => {
    test('extracts plain text from standard text message', () => {
      const msg = { text: 'Hello, this is a test message' };
      expect(extractMessageCopyText(msg)).toBe('Hello, this is a test message');
    });

    test('extracts caption from media message with caption', () => {
      const msg = { mediaType: 'image', mediaCaption: 'Sunset in Goa' };
      expect(extractMessageCopyText(msg)).toBe('Sunset in Goa');
    });

    test('joins both caption and text if they differ', () => {
      const msg = { text: 'Additional notes', mediaCaption: 'Document Title' };
      expect(extractMessageCopyText(msg)).toBe('Document Title\nAdditional notes');
    });

    test('deduplicates when text and mediaCaption are identical', () => {
      const msg = { text: 'Duplicate caption', mediaCaption: 'Duplicate caption' };
      expect(extractMessageCopyText(msg)).toBe('Duplicate caption');
    });

    test('extracts structured text from contactPayload', () => {
      const msg = {
        contactPayload: JSON.stringify({
          contacts: [
            {
              displayName: 'Alice Smith',
              organization: 'Acme Corp',
              phones: ['+1234567890'],
              emails: ['alice@example.com'],
            },
          ],
        }),
      };
      const text = extractMessageCopyText(msg);
      expect(text).toContain('Alice Smith');
      expect(text).toContain('Org: Acme Corp');
      expect(text).toContain('Phone: +1234567890');
      expect(text).toContain('Email: alice@example.com');
    });

    test('returns bracketed mediaType when no caption or text exists', () => {
      const msg = { mediaType: 'image' };
      expect(extractMessageCopyText(msg)).toBe('[image]');
    });

    test('returns empty string for null / empty message', () => {
      expect(extractMessageCopyText(null)).toBe('');
      expect(extractMessageCopyText({})).toBe('');
    });
  });

  describe('buildChatMessagesHtml dropdown menu output', () => {
    test('renders Copy message option in dropdown menu for incoming and outgoing messages', () => {
      const msgs = [
        {
          messageId: 'msg_in_1',
          chatJid: '919876543210@s.whatsapp.net',
          sender: 'Karan',
          text: 'Check this link: https://example.com',
          timestamp: 1700000001,
        },
        {
          messageId: 'msg_out_1',
          chatJid: '919876543210@s.whatsapp.net',
          sender: 'You',
          text: 'Got it, thanks!',
          timestamp: 1700000002,
        },
      ];

      const html = buildChatMessagesHtml(msgs, '919876543210@s.whatsapp.net', null, null);

      // Verify Copy message button is present in both menus
      expect(html).toContain('class="wa-menu-item mi-copy"');
      expect(html).toContain('data-wa-copy="1"');
      expect(html).toContain('<span>Copy message</span>');

      // Verify data-copy-text carries escaped message text
      expect(html).toContain('data-copy-text="Check this link: https://example.com"');
      expect(html).toContain('data-copy-text="Got it, thanks!"');
    });

    test('renders Copy message option for media messages with captions', () => {
      const msgs = [
        {
          messageId: 'msg_media_1',
          chatJid: 'group1@g.us',
          sender: 'Bob',
          mediaType: 'image',
          mediaCaption: 'Project roadmap screenshot',
          timestamp: 1700000003,
        },
      ];

      const html = buildChatMessagesHtml(msgs, 'group1@g.us', null, null);
      expect(html).toContain('data-wa-copy="1"');
      expect(html).toContain('data-copy-text="Project roadmap screenshot"');
      expect(html).toContain('<span>Copy message</span>');
    });

    test('does not render toolbar or copy menu on deleted messages', () => {
      const msgs = [
        {
          messageId: 'msg_del_1',
          chatJid: 'group1@g.us',
          sender: 'Bob',
          text: 'This message was deleted',
          timestamp: 1700000004,
        },
      ];

      const html = buildChatMessagesHtml(msgs, 'group1@g.us', null, null);
      expect(html).not.toContain('data-wa-copy="1"');
      expect(html).not.toContain('bubble-toolbar');
    });
  });

  describe('getMessageBlockCopyText DOM resolution', () => {
    function createMockElement(tag, attrs = {}, children = [], text = '') {
      const attributes = new Map(Object.entries(attrs));
      const childList = [...children];
      return {
        tagName: tag.toUpperCase(),
        innerText: text,
        hasAttribute: (name) => attributes.has(name),
        getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
        setAttribute: (name, val) => attributes.set(name, String(val)),
        querySelector: (sel) => {
          if (sel === '.bubble') return childList.find((c) => c.className === 'bubble') || null;
          if (sel === '.text') return childList.find((c) => c.className === 'text') || null;
          if (sel === '.media-cap') return childList.find((c) => c.className === 'media-cap') || null;
          return null;
        },
        className: attrs.class || '',
      };
    }

    test('extracts text from button data-copy-text attribute first', () => {
      const block = createMockElement('div', { class: 'msg-block' });
      const btn = createMockElement('button', { 'data-copy-text': 'Direct text from attribute' });

      expect(getMessageBlockCopyText(block, btn)).toBe('Direct text from attribute');
    });

    test('falls back to bubble .text if attribute is missing', () => {
      const textNode = createMockElement('span', { class: 'text' }, [], 'Fallback text from bubble');
      const bubble = createMockElement('div', { class: 'bubble' }, [textNode]);
      const block = createMockElement('div', { class: 'msg-block' }, [bubble]);

      expect(getMessageBlockCopyText(block, null)).toBe('Fallback text from bubble');
    });

    test('falls back to media-cap if text is missing', () => {
      const capNode = createMockElement('span', { class: 'media-cap' }, [], 'Fallback caption');
      const bubble = createMockElement('div', { class: 'bubble' }, [capNode]);
      const block = createMockElement('div', { class: 'msg-block' }, [bubble]);

      expect(getMessageBlockCopyText(block, null)).toBe('Fallback caption');
    });
  });

  describe('copyTextToClipboard and handleMessageCopyClick', () => {
    test('writes to navigator.clipboard.writeText when available', async () => {
      let copiedText = '';
      const originalNavigator = globalThis.navigator;
      globalThis.navigator = {
        clipboard: {
          writeText: jest.fn(async (t) => {
            copiedText = t;
          }),
        },
      };

      try {
        const ok = await copyTextToClipboard('Test clipboard payload');
        expect(ok).toBe(true);
        expect(copiedText).toBe('Test clipboard payload');
      } finally {
        if (originalNavigator) globalThis.navigator = originalNavigator;
        else delete globalThis.navigator;
      }
    });

    test('handleMessageCopyClick copies text and displays toast', async () => {
      let copiedText = '';
      const originalNavigator = globalThis.navigator;
      const originalDocument = globalThis.document;

      globalThis.navigator = {
        clipboard: {
          writeText: jest.fn(async (t) => {
            copiedText = t;
          }),
        },
      };

      const toastObj = {
        id: 'wa-message-toast',
        textContent: '',
        style: {},
        setAttribute: jest.fn(),
      };

      globalThis.document = {
        getElementById: jest.fn((id) => (id === 'wa-message-toast' ? toastObj : null)),
        createElement: jest.fn(() => toastObj),
        body: { appendChild: jest.fn() },
        querySelectorAll: jest.fn(() => []),
      };

      const copyBtn = {
        hasAttribute: (n) => n === 'data-copy-text',
        getAttribute: (n) => (n === 'data-copy-text' ? 'Copied message content' : null),
        closest: () => null,
      };

      try {
        const result = await handleMessageCopyClick(copyBtn, copyBtn);
        expect(result).toBe(true);
        expect(copiedText).toBe('Copied message content');
        expect(toastObj.textContent).toBe('Message copied');
      } finally {
        if (toastObj._hideTimer) clearTimeout(toastObj._hideTimer);
        if (originalNavigator) globalThis.navigator = originalNavigator;
        else delete globalThis.navigator;
        if (originalDocument) globalThis.document = originalDocument;
        else delete globalThis.document;
      }
    });
  });
});
