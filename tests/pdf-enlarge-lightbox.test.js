import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  buildChatMessagesHtml,
  openChatImageViewer,
  openChatPdfViewer,
} from '../public/js/messages-render.js';
import { store } from '../public/js/store.js';

describe('PDF Enlarge and Lightbox Viewer', () => {
  let prevWaState;
  let originalDocument;
  const bodyChildren = [];

  beforeEach(() => {
    prevWaState = store._waState;
    store._waState = 'READY';
    originalDocument = globalThis.document;

    globalThis.document = {
      createElement(tag) {
        const el = {
          tagName: tag.toUpperCase(),
          className: '',
          hidden: false,
          style: {},
          src: '',
          alt: '',
          title: '',
          dataset: {},
          children: [],
          attributes: new Map(),
          setAttribute(name, val) { el.attributes.set(name, String(val)); },
          getAttribute(name) { return el.attributes.get(name) || null; },
          removeAttribute(name) {
            el.attributes.delete(name);
            if (name === 'src') el.src = '';
          },
          appendChild(child) {
            el.children.push(child);
            return child;
          },
          querySelector(sel) {
            return findSelector(el, sel);
          },
          querySelectorAll(sel) {
            const results = [];
            collectSelector(el, sel, results);
            return results;
          },
          closest(sel) {
            if (matches(el, sel)) return el;
            return null;
          },
          remove() {
            const idx = bodyChildren.indexOf(el);
            if (idx !== -1) bodyChildren.splice(idx, 1);
          },
          addEventListener: jest.fn(),
          dispatchEvent: jest.fn(),
        };

        let _inner = '';
        let _text = '';
        Object.defineProperty(el, 'innerHTML', {
          get() { return _inner; },
          set(val) {
            _inner = String(val);
            el.children = [];
            if (_inner.includes('chat-image-viewer-stage')) {
              const closeBtn = globalThis.document.createElement('button');
              closeBtn.className = 'chat-image-viewer-close';
              const stage = globalThis.document.createElement('div');
              stage.className = 'chat-image-viewer-stage';
              const img = globalThis.document.createElement('img');
              const vid = globalThis.document.createElement('video');
              vid.className = 'chat-image-viewer-video';
              const pdf = globalThis.document.createElement('iframe');
              pdf.className = 'chat-image-viewer-pdf';
              stage.appendChild(img);
              stage.appendChild(vid);
              stage.appendChild(pdf);
              const caption = globalThis.document.createElement('div');
              caption.className = 'chat-image-viewer-caption';
              el.appendChild(closeBtn);
              el.appendChild(stage);
              el.appendChild(caption);
            }
          },
        });

        Object.defineProperty(el, 'textContent', {
          get() { return _text || _inner; },
          set(val) {
            _text = String(val);
            _inner = String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          },
        });

        return el;
      },
      body: {
        appendChild(child) {
          if (!bodyChildren.includes(child)) bodyChildren.push(child);
          return child;
        },
      },
      querySelector(sel) {
        for (const child of bodyChildren) {
          if (matches(child, sel)) return child;
          const found = findSelector(child, sel);
          if (found) return found;
        }
        return null;
      },
      querySelectorAll(sel) {
        const results = [];
        for (const child of bodyChildren) {
          if (matches(child, sel)) results.push(child);
          collectSelector(child, sel, results);
        }
        return results;
      },
      addEventListener: jest.fn(),
    };
  });

  afterEach(() => {
    store._waState = prevWaState;
    globalThis.document = originalDocument;
  });

  function matches(el, sel) {
    if (!el) return false;
    if (sel.startsWith('.') && el.className?.includes(sel.slice(1))) return true;
    if (sel.toLowerCase() === el.tagName?.toLowerCase()) return true;
    return false;
  }

  function findSelector(parent, sel) {
    for (const child of parent.children || []) {
      if (matches(child, sel)) return child;
      const found = findSelector(child, sel);
      if (found) return found;
    }
    return null;
  }

  function collectSelector(parent, sel, out) {
    for (const child of parent.children || []) {
      if (matches(child, sel)) out.push(child);
      collectSelector(child, sel, out);
    }
  }

  test('buildChatMessagesHtml wraps PDF in a clickable msg-media-pdf-container with overlay and badge', () => {
    const messages = [
      {
        messageId: 'pdf-msg-1',
        chatJid: 'user1@s.whatsapp.net',
        sender: 'Sender',
        mediaType: 'document',
        mediaCaption: 'Invoice_Nov_2026.pdf',
        hasMediaFile: 1,
        timestamp: 1732470000,
      },
    ];

    const html = buildChatMessagesHtml(messages, 'user1@s.whatsapp.net');
    expect(html).toContain('msg-media-pdf-container');
    expect(html).toContain('data-pdf-url="/api/message-media?messageId=pdf-msg-1"');
    expect(html).toContain('msg-media-pdf');
    expect(html).toContain('msg-media-pdf-overlay');
    expect(html).toContain('Click to enlarge');
  });

  test('buildChatMessagesHtml leaves non-PDF documents as downloadable links', () => {
    const messages = [
      {
        messageId: 'doc-msg-1',
        chatJid: 'user1@s.whatsapp.net',
        sender: 'Sender',
        mediaType: 'document',
        mediaCaption: 'Accounts_Sheet.xlsx',
        hasMediaFile: 1,
        timestamp: 1732470000,
      },
    ];

    const html = buildChatMessagesHtml(messages, 'user1@s.whatsapp.net');
    expect(html).not.toContain('msg-media-pdf-container');
    expect(html).toContain('msg-media-doc');
    expect(html).toContain('Accounts_Sheet.xlsx');
  });

  test('openChatPdfViewer mounts and displays the enlarged PDF iframe in the lightbox', () => {
    openChatPdfViewer('/api/message-media?messageId=pdf-msg-1', 'Invoice_Nov_2026.pdf');

    const viewer = globalThis.document.querySelector('.chat-image-viewer');
    expect(viewer).not.toBeNull();
    expect(viewer.hidden).toBe(false);

    const pdfFrame = viewer.querySelector('.chat-image-viewer-pdf');
    expect(pdfFrame).not.toBeNull();
    expect(pdfFrame.hidden).toBe(false);
    expect(pdfFrame.src).toContain('/api/message-media?messageId=pdf-msg-1');

    const img = viewer.querySelector('img');
    expect(img.hidden).toBe(true);

    const video = viewer.querySelector('video');
    expect(video.hidden).toBe(true);

    const caption = viewer.querySelector('.chat-image-viewer-caption');
    expect(caption.innerHTML).toContain('Invoice_Nov_2026.pdf');
    expect(caption.innerHTML).toContain('Open in new tab');
    expect(caption.innerHTML).toContain('Download PDF');
  });

  test('openChatImageViewer automatically delegates to openChatPdfViewer when passed a PDF source', () => {
    openChatImageViewer('/api/message-media?messageId=report.pdf', 'Document', 'Quarterly Report.pdf');

    const viewer = globalThis.document.querySelector('.chat-image-viewer');
    expect(viewer).not.toBeNull();
    expect(viewer.hidden).toBe(false);

    const pdfFrame = viewer.querySelector('.chat-image-viewer-pdf');
    expect(pdfFrame).not.toBeNull();
    expect(pdfFrame.hidden).toBe(false);
    expect(pdfFrame.src).toContain('report.pdf');

    const img = viewer.querySelector('img');
    expect(img.hidden).toBe(true);
  });
});
