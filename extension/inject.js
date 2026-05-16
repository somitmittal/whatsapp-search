/**
 * inject.js — Runs in the PAGE context (not isolated world).
 * Multi-strategy approach to access WhatsApp Web data:
 *   Strategy 1: Webpack Store hook (fastest, most complete)
 *   Strategy 2: Signals content.js to fall back to DOM scraping
 */
(function () {
  'use strict';

  let Store = null;
  let extractionRunning = false;
  let lastSyncTimestamp = 0;

  function post(type, payload) {
    window.postMessage({ source: 'wa-mirror-inject', type, payload }, '*');
  }

  function log(msg) { post('log', { message: msg }); }

  // ═══ Webpack Chunk Detection ═══════════════════════════════════════════

  function findWebpackChunks() {
    const found = [];

    const knownNames = [
      'webpackChunkwhatsapp_web_client',
      'webpackChunk_whatsapp_web_client',
      'webpackChunkbuild',
    ];

    for (const name of knownNames) {
      if (Array.isArray(window[name]) && window[name].push) {
        found.push({ name, arr: window[name] });
      }
    }

    try {
      for (const key of Object.getOwnPropertyNames(window)) {
        if (key.startsWith('webpackChunk') && Array.isArray(window[key])) {
          if (!found.some(c => c.name === key)) {
            found.push({ name: key, arr: window[key] });
          }
        }
      }
    } catch { /* SecurityError on some properties */ }

    return found;
  }

  function getRequireFromChunk(chunkArr) {
    let req = null;
    const probeId = `_wa_probe_${Date.now()}`;

    try {
      chunkArr.push([[probeId], {}, r => { req = r; }]);
    } catch { /* */ }

    if (!req && typeof window.__webpack_require__ === 'function') {
      req = window.__webpack_require__;
    }

    return req;
  }

  // ═══ Store Module Detection (6 heuristics) ═════════════════════════════

  function isChatLikeModel(m) {
    if (!m || typeof m !== 'object') return false;
    const id = m.id;
    if (!id) return false;
    const serialized = id._serialized || id.toString?.() || '';
    const isWhatsAppId = serialized.includes('@s.whatsapp.net')
      || serialized.includes('@g.us')
      || serialized.includes('@c.us')
      || serialized.includes('@lid');
    return isWhatsAppId && (m.msgs || m.lastReceivedKey || typeof m.t === 'number');
  }

  function wrapAsStore(arr) {
    return { getModelsArray: () => arr };
  }

  function scanForChatStore(req) {
    if (!req?.m) return null;

    const moduleIds = Object.keys(req.m);
    log(`Scanning ${moduleIds.length} webpack modules...`);

    for (const id of moduleIds) {
      try {
        const mod = req(id);
        if (!mod || typeof mod !== 'object') continue;

        for (const exp of Object.values(mod)) {
          if (!exp || typeof exp !== 'object') continue;

          // Heuristic 1: exp.Chat.getModelsArray — classic WA store shape
          if (exp.Chat?.getModelsArray) {
            try {
              const models = exp.Chat.getModelsArray();
              if (models?.length > 0 && isChatLikeModel(models[0])) {
                log(`H1: Chat store via .Chat.getModelsArray (${models.length} chats)`);
                return { Chat: exp.Chat };
              }
            } catch { /* */ }
          }

          // Heuristic 2: exp itself has getModelsArray with chat models
          if (typeof exp.getModelsArray === 'function') {
            try {
              const models = exp.getModelsArray();
              if (models?.length > 0 && isChatLikeModel(models[0])) {
                log(`H2: Chat store via getModelsArray (${models.length} chats)`);
                return { Chat: exp };
              }
            } catch { /* */ }
          }

          // Heuristic 3: exp._models is an array of chats
          if (Array.isArray(exp._models) && exp._models.length > 0 && isChatLikeModel(exp._models[0])) {
            log(`H3: Chat store via _models (${exp._models.length} chats)`);
            return { Chat: wrapAsStore(exp._models) };
          }

          // Heuristic 4: exp.models array
          if (Array.isArray(exp.models) && exp.models.length > 0 && isChatLikeModel(exp.models[0])) {
            log(`H4: Chat store via .models (${exp.models.length} chats)`);
            return { Chat: wrapAsStore(exp.models) };
          }

          // Heuristic 5: exp.toArray()
          if (typeof exp.toArray === 'function') {
            try {
              const arr = exp.toArray();
              if (arr?.length > 0 && isChatLikeModel(arr[0])) {
                log(`H5: Chat store via toArray (${arr.length} chats)`);
                return { Chat: wrapAsStore(arr) };
              }
            } catch { /* */ }
          }

          // Heuristic 6: exp.getAll / exp.values (Map-like collections)
          for (const method of ['getAll', 'values']) {
            if (typeof exp[method] === 'function') {
              try {
                const iter = exp[method]();
                const arr = Array.isArray(iter) ? iter : Array.from(iter);
                if (arr.length > 0 && isChatLikeModel(arr[0])) {
                  log(`H6: Chat store via .${method}() (${arr.length} chats)`);
                  return { Chat: wrapAsStore(arr) };
                }
              } catch { /* */ }
            }
          }
        }
      } catch { /* skip broken modules */ }
    }

    log('No Chat store found after scanning all modules');
    return null;
  }

  function tryWebpackStrategy() {
    const chunks = findWebpackChunks();
    if (chunks.length === 0) {
      log('No webpack chunks found on window');
      return false;
    }

    log(`Found ${chunks.length} webpack chunk(s): ${chunks.map(c => c.name).join(', ')}`);

    for (const chunk of chunks) {
      const req = getRequireFromChunk(chunk.arr);
      if (!req) {
        log(`No require from ${chunk.name}`);
        continue;
      }

      log(`Got require from ${chunk.name}, scanning...`);
      const store = scanForChatStore(req);
      if (store?.Chat) {
        Store = store;
        return true;
      }
    }

    return false;
  }

  // ═══ Data Extraction ═══════════════════════════════════════════════════

  function extractChatList() {
    if (!Store?.Chat) return [];
    try {
      const chats = Store.Chat.getModelsArray();
      return chats.map(c => ({
        id: c.id?._serialized || String(c.id),
        name: c.name || c.formattedTitle || c.contact?.pushname || c.id?.user || 'Unknown',
        isGroup: !!c.isGroup,
        unreadCount: c.unreadCount || 0,
        timestamp: c.t || 0,
        muteExpiration: c.muteExpiration || 0,
      }));
    } catch (err) {
      log(`extractChatList error: ${err.message}`);
      return [];
    }
  }

  function extractMessages(chatModel, sinceTimestamp = 0) {
    const results = [];
    try {
      const msgs = chatModel.msgs?.getModelsArray?.()
        || chatModel.msgs?._models
        || chatModel.msgs?.toArray?.()
        || [];

      for (const msg of msgs) {
        const ts = msg.t || msg.timestamp || 0;
        if (ts <= sinceTimestamp) continue;
        if (msg.isNotification) continue;

        const body = msg.body || msg.text || '';
        const caption = msg.caption || '';
        const hasMedia = !!(
          msg.mediaData?.type || msg.isMedia
          || msg.type === 'image' || msg.type === 'video'
          || msg.type === 'audio' || msg.type === 'ptt'
          || msg.type === 'document'
        );

        if (!body && !hasMedia && !caption) continue;

        results.push({
          id: msg.id?._serialized || `${chatModel.id?._serialized || 'x'}_${ts}_${Math.random().toString(36).slice(2, 6)}`,
          chatJid: chatModel.id?._serialized || '',
          chatName: chatModel.name || chatModel.formattedTitle || chatModel.contact?.pushname || '',
          body,
          timestamp: ts,
          fromMe: !!msg.id?.fromMe,
          sender: msg.id?.fromMe
            ? 'You'
            : (msg.senderObj?.pushname || msg.author || msg.from || 'Unknown'),
          type: msg.type || 'chat',
          hasMedia,
          mediaType: msg.mediaData?.type || (hasMedia ? msg.type : null),
          caption,
          quotedBody: msg.quotedMsgObj?.body || msg.quotedMsg?.body || '',
        });
      }
    } catch (err) {
      log(`extractMessages error: ${err.message}`);
    }
    return results;
  }

  function isAuthenticated() {
    return !document.querySelector('[data-testid="qrcode"]') &&
           !document.querySelector('canvas[aria-label="Scan me!"]') &&
           !document.querySelector('[data-testid="link-device-qrcode-canvas"]') &&
           !document.querySelector('div[data-ref]');
  }

  async function extractAll(sinceTimestamp = 0) {
    if (!Store?.Chat || extractionRunning) return;
    if (!isAuthenticated()) {
      log('Extraction skipped: QR code visible (logged out)');
      return;
    }
    extractionRunning = true;

    try {
      const chats = Store.Chat.getModelsArray();
      post('chat-list', { chats: extractChatList() });

      let totalMessages = 0;
      for (let i = 0; i < chats.length; i++) {
        post('sync-progress', {
          total: chats.length,
          current: i + 1,
          chatName: chats[i].name || chats[i].formattedTitle || chats[i].id?.user || 'Unknown',
          totalMessages,
        });

        const messages = extractMessages(chats[i], sinceTimestamp);
        if (messages.length > 0) {
          totalMessages += messages.length;
          post('messages', { messages });
        }
      }

      post('sync-complete', { totalMessages, chats: chats.length });
      lastSyncTimestamp = Math.floor(Date.now() / 1000);
    } catch (err) {
      log(`extractAll error: ${err.message}`);
      post('error', { message: `Extraction failed: ${err.message}` });
    } finally {
      extractionRunning = false;
    }
  }

  // ═══ Real-time Monitor ═════════════════════════════════════════════════

  function startRealtimeMonitor() {
    if (!Store?.Chat) return;
    try {
      for (const chat of Store.Chat.getModelsArray()) {
        if (!chat.msgs?.on) continue;
        try {
          chat.msgs.on('add', (msg) => {
            if (msg.isNotification) return;
            const body = msg.body || msg.text || '';
            const caption = msg.caption || '';
            const hasMedia = !!(msg.mediaData?.type || msg.isMedia);
            if (!body && !hasMedia && !caption) return;

            post('new-message', {
              message: {
                id: msg.id?._serialized || `rt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                chatJid: chat.id?._serialized || '',
                chatName: chat.name || chat.formattedTitle || '',
                body,
                timestamp: msg.t || Math.floor(Date.now() / 1000),
                fromMe: !!msg.id?.fromMe,
                sender: msg.id?.fromMe ? 'You' : (msg.senderObj?.pushname || msg.author || 'Unknown'),
                type: msg.type || 'chat',
                hasMedia,
                mediaType: msg.mediaData?.type || null,
                caption,
              },
            });
          });
        } catch { /* */ }
      }
      log('Real-time monitoring active');
    } catch (err) {
      log(`Monitor setup error: ${err.message}`);
    }
  }

  // ═══ Commands from content.js ══════════════════════════════════════════

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'wa-mirror-content') return;
    switch (event.data.type) {
      case 'extract-all':
        extractAll(event.data.sinceTimestamp || 0);
        break;
      case 'extract-new':
        extractAll(lastSyncTimestamp);
        break;
      case 'get-status':
        const authed = isAuthenticated();
        post('status', {
          storeReady: !!Store?.Chat && authed,
          chatCount: authed ? (Store?.Chat?.getModelsArray?.()?.length || 0) : 0,
          lastSync: lastSyncTimestamp,
          strategy: Store ? 'webpack' : 'none',
          isLoggedOut: !authed,
        });
        break;
    }
  });

  // ═══ Init with retry ═══════════════════════════════════════════════════

  let attempt = 0;
  const MAX_ATTEMPTS = 60;

  function tryInit() {
    attempt++;

    if (tryWebpackStrategy()) {
      const count = Store.Chat.getModelsArray().length;
      log(`Store ready after ${attempt} attempt(s)`);
      post('ready', { chatCount: count, strategy: 'webpack' });
      startRealtimeMonitor();
      setTimeout(() => extractAll(0), 2000);
      return;
    }

    if (attempt >= MAX_ATTEMPTS) {
      log(`All webpack strategies exhausted (${attempt} attempts)`);
      post('webpack-failed', {
        message: 'Webpack hook unavailable. Falling back to DOM scraping.',
      });
      return;
    }

    if (attempt % 10 === 0) {
      log(`Attempt ${attempt}/${MAX_ATTEMPTS} — still searching...`);
    }

    const delay = attempt <= 10 ? 2000 : attempt <= 30 ? 3000 : 5000;
    setTimeout(tryInit, delay);
  }

  function waitForAppLoad() {
    // Check if we are on the login/QR page
    const isLoginPage = !isAuthenticated();

    if (isLoginPage) {
      // If we see a QR code, we are definitely not logged in.
      // Wait and check again later.
      if (attempt % 5 === 0) log('On login page (QR visible) — waiting...');
      attempt++;
      setTimeout(waitForAppLoad, 2000);
      return;
    }

    const hasApp = document.querySelector('#app')
      || document.querySelector('[data-testid="app"]')
      || document.querySelector('#pane-side');

    if (!hasApp) {
      setTimeout(waitForAppLoad, 1000);
      return;
    }

    // Even if #app exists, double check we aren't still on a landing/loading screen
    // that isn't the main chat interface.
    const isMainUI = !!document.querySelector('#pane-side')
      || !!document.querySelector('[data-testid="chat-list"]')
      || !!document.querySelector('[data-testid="sidebar"]');

    if (!isMainUI && attempt < 10) {
      attempt++;
      setTimeout(waitForAppLoad, 2000);
      return;
    }

    setTimeout(tryInit, 3000);
  }

  waitForAppLoad();
})();
