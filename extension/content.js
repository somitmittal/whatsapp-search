/**
 * content.js — Chrome extension content script (isolated world).
 * Two-layer approach:
 *   1. Inject inject.js → tries webpack Store hook (fast, complete)
 *   2. If webpack fails within timeout → fall back to DOM scraping (always works)
 */
(function () {
  'use strict';

  const SERVER_URL = 'http://localhost:3000';
  const FLUSH_INTERVAL_MS = 3000;
  const FLUSH_BATCH_SIZE = 200;
  const WEBPACK_TIMEOUT_MS = 45000;

  let messageBuffer = [];
  let flushTimer = null;
  let domMode = false;
  let domObserver = null;
  let webpackReadyTimeout = null;
  const seenDomMsgKeys = new Set();

  // ═══ Inject page-context script ════════════════════════════════════════

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  webpackReadyTimeout = setTimeout(() => {
    if (!domMode) {
      console.log('[WA Mirror] Webpack timeout — switching to DOM mode');
      startDOMMode();
    }
  }, WEBPACK_TIMEOUT_MS);

  // ═══ Messages from inject.js ═══════════════════════════════════════════

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'wa-mirror-inject') return;

    const { type, payload } = event.data;

    switch (type) {
      case 'ready':
        clearTimeout(webpackReadyTimeout);
        console.log('[WA Mirror] Webpack store ready:', payload.chatCount, 'chats');
        chrome.runtime.sendMessage({
          type: 'status',
          payload: { connected: true, strategy: 'webpack', ...payload },
        });
        break;

      case 'webpack-failed':
        console.log('[WA Mirror] Webpack failed — starting DOM mode');
        startDOMMode();
        break;

      case 'chat-list':
        sendToServer('/api/extension/chats', payload);
        break;

      case 'messages':
        if (payload.messages?.length > 0) {
          messageBuffer.push(...payload.messages);
          scheduleFlush();
        }
        break;

      case 'new-message':
        if (payload.message) {
          messageBuffer.push(payload.message);
          scheduleFlush();
        }
        break;

      case 'sync-progress':
        chrome.runtime.sendMessage({ type: 'sync-progress', payload });
        break;

      case 'sync-complete':
        flushNow();
        chrome.runtime.sendMessage({ type: 'sync-complete', payload });
        console.log('[WA Mirror] Sync complete:', payload.totalMessages, 'messages from', payload.chats, 'chats');
        break;

      case 'status':
        chrome.runtime.sendMessage({ type: 'status', payload });
        break;

      case 'log':
        console.log('[WA Mirror]', payload.message);
        break;

      case 'error':
        console.error('[WA Mirror]', payload.message);
        chrome.runtime.sendMessage({ type: 'error', payload });
        break;
    }
  });

  // ═══ DOM Scraping Fallback ═════════════════════════════════════════════

  function startDOMMode() {
    if (domMode) return;
    domMode = true;
    clearTimeout(webpackReadyTimeout);

    console.log('[WA Mirror] DOM scraping mode activated');
    chrome.runtime.sendMessage({
      type: 'status',
      payload: { connected: true, strategy: 'dom', chatCount: 0 },
    });

    setTimeout(extractFromDOM, 2000);
    setInterval(extractFromDOM, 30000);
    setupDOMObserver();
  }

  function extractFromDOM() {
    try {
      const chats = extractChatListDOM();
      if (chats.length > 0) {
        sendToServer('/api/extension/chats', { chats });
        chrome.runtime.sendMessage({
          type: 'status',
          payload: { connected: true, strategy: 'dom', chatCount: chats.length },
        });
      }

      const messages = extractVisibleMessagesDOM();
      if (messages.length > 0) {
        messageBuffer.push(...messages);
        scheduleFlush();
      }
    } catch (err) {
      console.error('[WA Mirror] DOM extraction error:', err);
    }
  }

  // ── Chat list from sidebar DOM ─────────────────────────────────────────

  function extractChatListDOM() {
    const chats = [];

    const selectors = [
      '#pane-side [role="listitem"]',
      '[data-testid="cell-frame-container"]',
      '#pane-side div[role="row"]',
    ];

    let items = [];
    for (const sel of selectors) {
      items = document.querySelectorAll(sel);
      if (items.length > 0) break;
    }

    if (items.length === 0) {
      const pane = document.querySelector('#pane-side');
      if (pane) {
        items = pane.querySelectorAll('div[tabindex="-1"]');
      }
    }

    items.forEach((el, i) => {
      const nameSpan = el.querySelector('span[title]');
      if (!nameSpan) return;

      const name = nameSpan.getAttribute('title') || nameSpan.textContent?.trim();
      if (!name) return;

      let timestamp = 0;
      const timeEl = el.querySelector('div[class*="timestamp"] span, span[class*="time"]');
      if (timeEl) {
        const t = timeEl.textContent?.trim();
        try {
          const d = new Date(t);
          if (!isNaN(d.getTime())) timestamp = Math.floor(d.getTime() / 1000);
        } catch { /* */ }
      }

      const stableId = `dom_${name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}@c.us`;

      chats.push({
        id: stableId,
        name,
        isGroup: false,
        unreadCount: 0,
        timestamp,
      });
    });

    return chats;
  }

  // ── Messages from conversation panel DOM ───────────────────────────────

  function extractVisibleMessagesDOM() {
    const messages = [];

    const headerEl = document.querySelector('#main header span[title]')
      || document.querySelector('[data-testid="conversation-header"] span[title]');
    const chatName = headerEl?.getAttribute('title') || headerEl?.textContent?.trim();
    if (!chatName) return messages;

    const chatJid = `dom_${chatName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}@c.us`;

    const containers = document.querySelectorAll(
      '[data-testid="msg-container"], .message-in, .message-out'
    );

    containers.forEach((el) => {
      try {
        const isOut = el.classList.contains('message-out')
          || el.closest('.message-out') !== null
          || !!el.querySelector('[data-testid="msg-dblcheck"]');

        const textEl = el.querySelector('.selectable-text span[dir], span.selectable-text');
        const body = textEl?.innerText?.trim() || '';

        const metaEl = el.querySelector('[data-testid="msg-meta"] span, span[data-testid="msg-time"]');
        const timeText = metaEl?.textContent?.trim() || '';

        const senderEl = el.querySelector('[data-testid="author"] span, span[aria-label]');
        const sender = isOut ? 'You' : (senderEl?.textContent?.trim() || 'Unknown');

        const hasMedia = !!el.querySelector(
          'img[src*="blob:"], video, [data-testid="media-state"], [data-testid="image-thumb"]'
        );

        if (!body && !hasMedia) return;

        const dedupKey = `${chatJid}|${sender}|${body.slice(0, 50)}|${timeText}`;
        if (seenDomMsgKeys.has(dedupKey)) return;
        seenDomMsgKeys.add(dedupKey);

        let timestamp = Math.floor(Date.now() / 1000);
        if (timeText) {
          const match = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
          if (match) {
            let h = parseInt(match[1], 10);
            const m = parseInt(match[2], 10);
            if (match[3]?.toUpperCase() === 'PM' && h < 12) h += 12;
            if (match[3]?.toUpperCase() === 'AM' && h === 12) h = 0;
            const now = new Date();
            now.setHours(h, m, 0, 0);
            timestamp = Math.floor(now.getTime() / 1000);
          }
        }

        messages.push({
          id: `dom_${chatJid}_${timestamp}_${messages.length}`,
          chatJid,
          chatName,
          body,
          timestamp,
          fromMe: isOut,
          sender,
          type: hasMedia ? 'media' : 'chat',
          hasMedia,
          mediaType: null,
          caption: '',
          quotedBody: '',
        });
      } catch { /* skip */ }
    });

    return messages;
  }

  // ── MutationObserver for live messages ─────────────────────────────────

  function setupDOMObserver() {
    const target = document.querySelector('#main')
      || document.querySelector('[data-testid="conversation-panel-messages"]');

    if (!target) {
      const bodyObs = new MutationObserver(() => {
        const main = document.querySelector('#main');
        if (main) {
          bodyObs.disconnect();
          setupDOMObserver();
        }
      });
      bodyObs.observe(document.body, { childList: true, subtree: true });
      return;
    }

    if (domObserver) domObserver.disconnect();

    let debounceTimer = null;
    domObserver = new MutationObserver((mutations) => {
      let hasNew = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) { hasNew = true; break; }
      }
      if (!hasNew) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const msgs = extractVisibleMessagesDOM();
        if (msgs.length > 0) {
          messageBuffer.push(...msgs);
          scheduleFlush();
        }
      }, 500);
    });

    domObserver.observe(target, { childList: true, subtree: true });
    console.log('[WA Mirror] DOM observer active');
  }

  // ═══ Batching & Server Communication ═══════════════════════════════════

  function scheduleFlush() {
    if (flushTimer) return;
    if (messageBuffer.length >= FLUSH_BATCH_SIZE) { flushNow(); return; }
    flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, FLUSH_INTERVAL_MS);
  }

  function flushNow() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (messageBuffer.length === 0) return;
    const batch = messageBuffer.splice(0);
    sendToServer('/api/extension/messages', { messages: batch });
  }

  async function sendToServer(path, data) {
    try {
      const res = await fetch(`${SERVER_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        console.error('[WA Mirror] Server error:', res.status);
      }
    } catch (err) {
      console.error('[WA Mirror] Server unreachable:', err.message);
    }
  }

  // ═══ Commands from background.js ═══════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'trigger-sync') {
      if (domMode) {
        extractFromDOM();
      } else {
        window.postMessage(
          { source: 'wa-mirror-content', type: 'extract-all', sinceTimestamp: msg.since || 0 },
          '*',
        );
      }
    } else if (msg.type === 'trigger-new') {
      if (domMode) {
        extractFromDOM();
      } else {
        window.postMessage({ source: 'wa-mirror-content', type: 'extract-new' }, '*');
      }
    } else if (msg.type === 'get-status') {
      window.postMessage({ source: 'wa-mirror-content', type: 'get-status' }, '*');
    }
  });

  // ═══ Periodic Re-sync ═════════════════════════════════════════════════

  setInterval(() => {
    if (domMode) {
      extractFromDOM();
    } else {
      window.postMessage({ source: 'wa-mirror-content', type: 'extract-new' }, '*');
    }
  }, 5 * 60 * 1000);

  console.log('[WA Mirror] Content script loaded');
})();
