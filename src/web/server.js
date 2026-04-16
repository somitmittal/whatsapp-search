import { createRequire } from 'module';
import { createServer } from 'http';
import { resolve } from 'path';
import config from '../config.js';
import { importExportedChat, extractTextFromZip } from '../import/chat-import.js';
import { createProvider, clearProviderCache, PROVIDER_META } from '../llm/provider.js';
import { fetchOllamaCloudModelNames } from '../llm/ollama-cloud.js';

const require = createRequire(import.meta.url);
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export default class WebServer {
  constructor({ db, searchEngine, summaryService }) {
    this.db = db;
    this.searchEngine = searchEngine;
    this.summaryService = summaryService;

    this._app = express();
    this._server = createServer(this._app);
    this._wss = new WebSocketServer({ server: this._server });
    this._clients = new Set();

    this._extensionConnected = false;
    this._syncStats = { syncing: false, total: 0, current: 0, totalMessages: 0 };

    // WhatsApp QR / connection state
    this._waState = 'DISCONNECTED'; // DISCONNECTED | QR_READY | LOADING | READY
    this._waMessage = 'Not connected';
    this._waQrDataUrl = null;
    this._waClient = null; // set by index.js via setWaClient()

    this._setupWebSocket();
    this._setupRoutes();
  }

  /** Called from index.js to give the server a reference to the WA client. */
  setWaClient(waClient) {
    this._waClient = waClient;
  }

  /** Called by WaClient when QR changes. */
  onWaQr(dataUrl) {
    this._waQrDataUrl = dataUrl;
    this._waState = 'QR_READY';
    this._broadcast({ type: 'wa-qr', data: { qr: dataUrl } });
  }

  /** Called by WaClient on status changes. */
  onWaStatus({ state, message }) {
    this._waState = state;
    this._waMessage = message;
    if (state === 'READY') {
      this._waQrDataUrl = null;
      this._extensionConnected = true;
      if (this._waClient?.syncResolvedNamesToDb) {
        setTimeout(() => {
          this._waClient
            .syncResolvedNamesToDb(this.db)
            .then((n) => {
              if (n > 0) {
                this._broadcast({ type: 'chat-names-refreshed', data: { stats: this.db.getTotalStats() } });
              }
            })
            .catch((e) => {
              console.warn('[WA] syncResolvedNamesToDb:', e.message);
            });
        }, 2000);
      }
      // Phone book / saved contact names come from WhatsApp app-state (`contactAction.fullName` → contacts.upsert)
      if (this._waClient?.refreshPhoneBookNamesInDb) {
        setTimeout(() => {
          this._waClient
            .refreshPhoneBookNamesInDb(this.db)
            .then((n) => {
              this._broadcast({
                type: 'chat-names-refreshed',
                data: { stats: this.db.getTotalStats(), rowsUpdated: n },
              });
            })
            .catch((e) => {
              console.warn('[WA] refreshPhoneBookNamesInDb:', e.message);
            });
        }, 5500);
      }
    }
    this._broadcast({
      type: 'wa-status',
      data: { state, message, stats: this.db.getTotalStats() },
    });
  }

  /** Called by WaClient when messages arrive (real-time or history). */
  onWaMessages(rows) {
    const inserted = this.db.insertMessageBatch(rows);
    const lastNameByChat = new Map();
    for (const r of rows || []) {
      if (r?.chatJid && r?.chatName) lastNameByChat.set(r.chatJid, r.chatName);
    }
    for (const [chatJid, chatName] of lastNameByChat) {
      this.db.propagateChatDisplayName(chatJid, chatName);
    }
    if (inserted > 0) {
      console.log(`[WA] Saved ${inserted} new messages`);
      this._broadcast({ type: 'new-messages', data: { count: inserted, stats: this.db.getTotalStats() } });
    }
  }

  /** Called by WaClient during history sync with progress info. */
  onWaProgress({ completed, total, messages }) {
    this._broadcast({ type: 'sync-progress', data: { completed, total, messages } });
  }

  /** Called by DailySummaryService while indexing thread summaries per chat. */
  onSummaryProgress(data) {
    this._broadcast({ type: 'summary-progress', data });
  }

  /** Merge static PROVIDER_META with live Ollama Cloud /api/tags when an API key is available. */
  async _buildProvidersMeta(settings) {
    const oc = PROVIDER_META.ollama_cloud;
    const providers = {
      ...PROVIDER_META,
      ollama_cloud: { ...oc, models: [...oc.models] },
    };
    const sumProv = settings.summary_provider;
    const llmProv = settings.llm_provider;
    const key =
      (sumProv === 'ollama_cloud' ? (settings.summary_api_key || '') : '') ||
      (llmProv === 'ollama_cloud' ? (settings.llm_api_key || '') : '') ||
      (settings.llm_api_key || '') ||
      (settings.summary_api_key || '');
    if (key && String(key).trim()) {
      const remote = await fetchOllamaCloudModelNames(key);
      if (remote.length) {
        providers.ollama_cloud.models = [...new Set([...remote, ...providers.ollama_cloud.models])];
      }
    }
    return providers;
  }

  _setupWebSocket() {
    this._wss.on('connection', (ws) => {
      this._clients.add(ws);
      ws.on('close', () => this._clients.delete(ws));
      ws.on('error', () => this._clients.delete(ws));
      // Send current state immediately on connect
      this._sendTo(ws, {
        type: 'status',
        data: { connected: this._extensionConnected, stats: this.db.getTotalStats() },
      });
      this._sendTo(ws, {
        type: 'wa-status',
        data: { state: this._waState, message: this._waMessage, stats: this.db.getTotalStats() },
      });
      if (this._waQrDataUrl) {
        this._sendTo(ws, { type: 'wa-qr', data: { qr: this._waQrDataUrl } });
      }
    });
  }

  _setupRoutes() {
    this._app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      if (_req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
    this._app.use(express.json({ limit: '10mb' }));
    this._app.use(express.static(config.publicDir));

    // ── Status ────────────────────────────────────────────────────────
    this._app.get('/api/status', (_req, res) => {
      res.json({
        connected: this._extensionConnected,
        syncStatus: { ...this._syncStats },
        stats: this.db.getTotalStats(),
      });
    });

    // ── Chat & Message APIs ───────────────────────────────────────────
    this._app.get('/api/chats', (_req, res) => res.json(this.db.getChatStats()));

    this._app.get('/api/messages', (req, res) => {
      const chatJid = req.query.chatJid;
      if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 80, 500);
      const offset = parseInt(req.query.offset, 10) || 0;
      return res.json(this.db.getMessagesPaginated(chatJid, limit, offset));
    });

    this._app.delete('/api/chats/:chatJid', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid);
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const deleted = this.db.deleteChat(chatJid);
        this._broadcast({ type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } });
        return res.json({ ok: true, deleted });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/media', (req, res) => {
      const chatJid = req.query.chatJid || null;
      const mediaType = req.query.type || null;
      const limit = parseInt(req.query.limit, 10) || 50;
      return res.json(this.db.getMediaMessages(chatJid, mediaType, limit));
    });

    // ── Search ────────────────────────────────────────────────────────
    this._app.post('/api/search', async (req, res) => {
      try {
        const { query, chatJid, mediaType } = req.body;
        if (!query || typeof query !== 'string') {
          return res.status(400).json({ error: 'query is required' });
        }

        const result = await this.searchEngine.search(query, chatJid || null, mediaType || null);
        return res.json(result);
      } catch (err) {
        console.error('Search API error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    // ── WhatsApp Linked-Device Endpoints ─────────────────────────────
    this._app.get('/api/wa/status', (_req, res) => {
      res.json({
        state: this._waState,
        message: this._waMessage,
        hasQr: !!this._waQrDataUrl,
      });
    });

    this._app.get('/api/wa/qr', (_req, res) => {
      // Always serve the freshest QR — from the live client if available
      const liveQr = this._waClient?.latestQr;
      const qr = liveQr || this._waQrDataUrl;
      if (!qr) return res.status(404).json({ error: 'No QR available' });
      // Update cache too
      if (liveQr) this._waQrDataUrl = liveQr;
      res.json({ qr });
    });

    this._app.get('/api/wa/chat-details', async (req, res) => {
      const chatJid = req.query.chatJid;
      if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
      try {
        const stats = this.db.getChatStats().find((c) => c.chatJid === chatJid);
        const local = {
          chatJid,
          chatName: stats?.chatName ?? null,
          messageCount: stats?.messageCount ?? 0,
          participantCountFromDb: stats?.participantCount ?? 0,
          lastMessageTs: stats?.lastMessageTs ?? null,
          isGroup: chatJid.includes('@g.us'),
        };
        const wa = this._waClient && typeof this._waClient.getChatDetails === 'function'
          ? await this._waClient.getChatDetails(chatJid)
          : null;
        return res.json({ ...local, ...(wa || {}) });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/wa/connect', async (_req, res) => {
      if (!this._waClient) return res.status(503).json({ error: 'WA client not initialised' });
      if (this._waState === 'READY') return res.json({ ok: true, state: 'READY' });
      try {
        // start() is idempotent — safe to call again if disconnected
        this._waClient.start().catch(err => console.error('[WA] Start error:', err.message));
        res.json({ ok: true, state: this._waState });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/wa/logout', async (_req, res) => {
      if (!this._waClient) return res.status(503).json({ error: 'WA client not initialised' });
      try {
        await this._waClient.logout();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /** Re-fetch WhatsApp app state (contact / phone book names) and update indexed chat titles. */
    this._app.post('/api/wa/sync-contacts', async (_req, res) => {
      if (!this._waClient) return res.status(503).json({ error: 'WA client not initialised' });
      if (this._waState !== 'READY') return res.status(409).json({ error: 'WhatsApp not ready' });
      if (typeof this._waClient.refreshPhoneBookNamesInDb !== 'function') {
        return res.status(503).json({ error: 'Contact sync not available' });
      }
      try {
        const rowsUpdated = await this._waClient.refreshPhoneBookNamesInDb(this.db);
        this._broadcast({
          type: 'chat-names-refreshed',
          data: { stats: this.db.getTotalStats(), rowsUpdated },
        });
        res.json({ ok: true, rowsUpdated });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Extension Sync Endpoints ──────────────────────────────────────
    this._app.post('/api/extension/chats', (req, res) => {
      this._extensionConnected = true;
      this._broadcast({ type: 'status', data: { connected: true, stats: this.db.getTotalStats() } });
      res.json({ ok: true });
    });

    this._app.post('/api/extension/messages', (req, res) => {
      try {
        if (!this._extensionConnected) {
          this._extensionConnected = true;
          this._broadcast({ type: 'status', data: { connected: true, stats: this.db.getTotalStats() } });
        }
        const { messages } = req.body;
        if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

        const rows = messages.map(m => ({
          messageId: m.id,
          chatJid: m.chatJid,
          chatName: m.chatName || null,
          sender: m.sender || (m.fromMe ? 'You' : 'Unknown'),
          senderJid: m.sender || null,
          text: m.body || m.caption || (m.hasMedia ? `[${m.mediaType || 'media'}]` : ''),
          mediaType: m.hasMedia ? (m.mediaType || m.type || 'unknown') : null,
          mediaPath: null,
          mediaCaption: m.caption || null,
          timestamp: m.timestamp || Math.floor(Date.now() / 1000),
        }));

        const inserted = this.db.insertMessageBatch(rows);
        if (inserted > 0) {
          console.log(`[Extension] Synced ${inserted} new messages`);
          this._broadcast({ type: 'new-messages', data: { count: inserted, stats: this.db.getTotalStats() } });
        }

        return res.json({ inserted, total: rows.length });
      } catch (err) {
        console.error('Extension sync error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    // ── Settings API ──────────────────────────────────────────────────
    this._app.get('/api/settings', async (_req, res) => {
      try {
        const settings = this.db.getAllSettings();
        const providers = await this._buildProvidersMeta(settings);
        res.json({ settings, providers });
      } catch (err) {
        console.error('[Settings] GET error:', err.message);
        res.json({ settings: this.db.getAllSettings(), providers: PROVIDER_META });
      }
    });

    this._app.post('/api/settings', async (req, res) => {
      try {
        const { provider, apiKey, model } = req.body;

        if (provider) this.db.setSetting('llm_provider', provider);
        if (apiKey !== undefined) this.db.setSetting('llm_api_key', apiKey);
        if (model) this.db.setSetting('llm_model', model);

        clearProviderCache();

        const p = provider || this.db.getSetting('llm_provider') || 'gemini';
        const k = apiKey !== undefined ? apiKey : (this.db.getSetting('llm_api_key') || '');
        const m = model || this.db.getSetting('llm_model') || '';

        const instance = await createProvider(p, k, m || undefined);
        const healthy = await instance.checkHealth();

        this.searchEngine.setProvider(instance);

        this.summaryService.setFallbackProvider(instance);
        const sumP = this.db.getSetting('summary_provider');
        if (!sumP || sumP === 'same') {
          this.summaryService.setProvider(instance);
          if (healthy) { this._triggerSummaryGen(); }
        }

        return res.json({ ok: true, healthy, provider: p, model: instance.model });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/settings/summary-provider', async (req, res) => {
      try {
        const { provider, apiKey, model } = req.body;

        if (provider === 'same') {
          this.db.setSetting('summary_provider', 'same');
          this.db.setSetting('summary_api_key', '');
          this.db.setSetting('summary_model', '');
          clearProviderCache();
          const mainP = this.db.getSetting('llm_provider') || 'gemini';
          const mainK = this.db.getSetting('llm_api_key') || '';
          const mainM = this.db.getSetting('llm_model') || '';
          const mainInstance = await createProvider(mainP, mainK, mainM || undefined);
          this.summaryService.setProvider(mainInstance);
          this._triggerSummaryGen();
          return res.json({ ok: true, healthy: true, provider: 'same', model: mainInstance.model });
        }

        if (provider) this.db.setSetting('summary_provider', provider);
        if (apiKey !== undefined) this.db.setSetting('summary_api_key', apiKey);
        if (model) this.db.setSetting('summary_model', model);

        clearProviderCache();

        const sp = provider || this.db.getSetting('summary_provider') || 'ollama';
        const sk = apiKey !== undefined ? apiKey : (this.db.getSetting('summary_api_key') || '');
        const sm = model || this.db.getSetting('summary_model') || '';

        const instance = await createProvider(sp, sk, sm || undefined);
        const healthy = await instance.checkHealth();

        this.summaryService.setProvider(instance);

        if (healthy) { this._triggerSummaryGen(); }

        return res.json({ ok: true, healthy, provider: sp, model: instance.model });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/settings/test', async (req, res) => {
      try {
        const { provider, apiKey, model } = req.body;
        if (!provider) return res.status(400).json({ error: 'provider required' });

        const instance = await createProvider(provider, apiKey || '', model || undefined);
        const healthy = await instance.checkHealth();
        return res.json({ healthy, provider, model: instance.model });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    // ── Ollama Pull Status ────────────────────────────────────────────
    this._app.get('/api/pull-status', (_req, res) => {
      const p = this.searchEngine?._provider;
      if (p?.pullStatus) return res.json(p.pullStatus);
      return res.json(null);
    });

    // ── Summaries ─────────────────────────────────────────────────────
    this._app.post('/api/summaries/generate', async (_req, res) => {
      try {
        const count = await this.summaryService.indexPendingDays();
        return res.json({ generated: count });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/summaries/regenerate', async (_req, res) => {
      try {
        const clearedDaily = this.db.clearAllSummaries();
        const clearedThread = this.db.clearAllThreadSummaries();
        const cleared = clearedDaily + clearedThread;
        console.log(`[Summaries] Cleared ${clearedDaily} daily + ${clearedThread} thread summaries (and thread facts) — regenerating...`);
        res.json({ cleared, status: 'regenerating' });
        this.summaryService.indexPendingDays().then(count => {
          console.log(`[Summaries] Regenerated ${count} thread summaries`);
          this._broadcast({ type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } });
        }).catch(err => console.error('Regeneration error:', err.message));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    // ── Import (single or batch) ─────────────────────────────────────
    this._app.post('/api/import', upload.array('file', 50), (req, res) => {
      try {
        const files = req.files || [];
        if (files.length === 0) return res.status(400).json({ error: 'No file uploaded' });

        const results = [];
        for (const file of files) {
          const fileName = file.originalname || 'import';
          const isZip = fileName.toLowerCase().endsWith('.zip');
          const isTxt = fileName.toLowerCase().endsWith('.txt');

          if (!isZip && !isTxt) { results.push({ chatName: fileName, error: 'Only .zip or .txt supported' }); continue; }

          let textContent;
          if (isZip) {
            textContent = extractTextFromZip(file.buffer);
            if (!textContent) { results.push({ chatName: fileName, error: 'No chat .txt found in zip' }); continue; }
          } else {
            textContent = file.buffer.toString('utf-8');
          }

          const chatName = fileName.replace(/\.(zip|txt)$/i, '').replace(/^WhatsApp Chat with /i, '');
          const result = importExportedChat(this.db, textContent, chatName);
          results.push({ chatName, ...result });
        }

        this._broadcast({ type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } });

        this.summaryService.indexPendingDays().then((count) => {
          if (count > 0) console.log(`Post-import: generated ${count} daily summaries`);
        }).catch((err) => console.error('Post-import summary error:', err.message));

        if (results.length === 1) return res.json(results[0]);
        return res.json({ results, totalFiles: results.length });
      } catch (err) {
        console.error('Import API error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/', (_req, res) => res.sendFile(resolve(config.publicDir, 'index.html')));
  }

  _triggerSummaryGen() {
    this.summaryService.indexPendingDays().then(count => {
      if (count > 0) {
        console.log(`[Settings] Generated ${count} summaries`);
        this._broadcast({ type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } });
      }
    }).catch(err => console.error('[Settings] Summary gen error:', err.message));
  }

  _sendTo(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  _broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of this._clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  start() {
    return new Promise((resolve) => {
      this._server.listen(config.webPort, () => {
        console.log(`\nWeb UI: http://localhost:${config.webPort}\n`);
        resolve();
      });
    });
  }

  stop() {
    this._wss.close();
    this._server.close();
  }
}
