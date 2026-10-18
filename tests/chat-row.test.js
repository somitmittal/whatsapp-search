import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { chatRowHtml } from '../public/js/chat-row.js';

const originalDocument = globalThis.document;
beforeAll(() => {
  globalThis.document = {
    createElement: () => {
      let text = '';
      return {
        set textContent(value) { text = String(value); },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      };
    },
  };
});
afterAll(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

describe('shared chat row renderer', () => {
  test('renders a normal WhatsApp chat row with its AI toggle', () => {
    expect(() => chatRowHtml({
      chatJid: 'site@g.us',
      chatName: 'Site team',
      messageCount: 12,
      participantCount: 4,
      lastMessageTs: 1792311602,
      indexOptedIn: false,
      aiSearchReady: false,
      aiSearchComplete: false,
    })).not.toThrow();

    const html = chatRowHtml({
      chatJid: 'site@g.us',
      chatName: 'Site team',
      messageCount: 12,
      participantCount: 4,
      lastMessageTs: 1792311602,
      indexOptedIn: true,
      aiSearchReady: false,
      aiSearchComplete: false,
    });
    expect(html).toContain('class="chat-item"');
    expect(html).toContain('Site team');
    expect(html).toContain('class="chat-ai-toggle on"');
    expect(html).toContain('aria-pressed="true"');
  });
});
