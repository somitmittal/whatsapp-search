import { createRequire } from 'module';
import { createServer } from 'http';
import { resolve } from 'path';
import { randomBytes } from 'node:crypto';
import config from '../config.js';
import { runWithTenant, getCurrentTenantId } from '../storage/tenant-context.js';
import { LEGACY_TENANT_ID } from '../storage/tenant-constants.js';
import { isJwtAuthEnabled, verifyTenantToken } from '../auth/jwt-util.js';
import { registerAuthRoutes } from './auth-routes.js';
import { importExportedChat, extractTextFromZip } from '../import/chat-import.js';
import { syncWhatsAppExportsFromGmail } from '../gmail/gmail-sync.js';
import { createProvider, clearProviderCache, PROVIDER_META } from '../llm/provider.js';
import { fetchOllamaCloudModelNames } from '../llm/ollama-cloud.js';
import {
  effectiveSearchApiKey,
  effectiveSummaryApiKey,
  keyHints,
  publicSettingsFromDb,
} from '../llm/defaults.js';

const require = createRequire(import.meta.url);
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const { google } = require('googleapis');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export default class WebServer {
  constructor({ db, searchEngine, summaryService, mediaIndexService, actionItemService }) {
    this.db = db;
    this.searchEngine = searchEngine;
    this.summaryService = summaryService;
    this._mediaIndexService = mediaIndexService || null;
    this._actionItemService = actionItemService || null;

    this._app = express();
    this._server = createServer(this._app);
    this._clients = new Set();

    this._extensionConnected = false;
    this._syncStats = { syncing: false, total: 0, current: 0, totalMessages: 0 };

    // WhatsApp QR / connection state
    this._waState = 'DISCONNECTED'; // DISCONNECTED | QR_READY | LOADING | READY
    this._waMessage = 'Not connected';
    this._waQrDataUrl = null;
    this._waClient = null; // set by index.js via setWaClient()

    /** @type {Map<string, { ts: number, onboarding: boolean }>} */
    this._gmailOAuthState = new Map();

    /** Background WhatsApp + extension ingest is scoped to this tenant (see `DEFAULT_TENANT_ID`). */
    this._waTenantId = config.defaultTenantId || LEGACY_TENANT_ID;

    /**
     * When set (e.g. Render secret `WEB_ACCESS_TOKEN`), all `/api/*` routes and WebSockets require
     * `X-Web-Access-Token`, `Authorization: Bearer <deploy token>`, or `?access_token=` (WS).
     * User JWT (when JWT_SECRET is set) uses the same `Authorization: Bearer` header — use `X-Web-Access-Token`
     * for the deploy gate so Bearer can carry the login JWT.
     */
    this._webAccessToken = (config.webAccessToken || process.env.WEB_ACCESS_TOKEN || '').trim();

    this._wss = new WebSocketServer({
      server: this._server,
      verifyClient: (info) => this._verifyWsClient(info),
    });
    this._setupWebSocket();
    this._setupRoutes();
  }

  /** @returns {boolean} */
  _verifyWsClient(info) {
    const req = info.req;
    if (this._webAccessToken && !this._requestHasValidAccessToken(req)) return false;
    if (isJwtAuthEnabled()) {
      try {
        const raw = req.url || '';
        const qIdx = raw.indexOf('?');
        const qs = qIdx === -1 ? '' : raw.slice(qIdx + 1);
        const token = new URLSearchParams(qs).get('token');
        const v = verifyTenantToken(token);
        if (!v?.tenantId) return false;
        req.tenantId = v.tenantId;
        return true;
      } catch {
        return false;
      }
    }
    req.tenantId = this._waTenantId;
    return true;
  }

  /**
   * @param {import('http').IncomingMessage} req
   * @returns {boolean}
   */
  _requestHasValidAccessToken(req) {
    if (!this._webAccessToken) return true;
    const deploy = req.headers?.['x-web-access-token'];
    if (deploy && deploy === this._webAccessToken) return true;
    const auth = req.headers?.authorization;
    if (auth && /^Bearer\s+(\S+)/i.test(auth)) {
      const t = auth.replace(/^Bearer\s+/i, '').trim();
      if (t === this._webAccessToken) return true;
    }
    try {
      const raw = req.url || '';
      const qIdx = raw.indexOf('?');
      const qs = qIdx === -1 ? '' : raw.slice(qIdx + 1);
      const params = new URLSearchParams(qs);
      const at = params.get('access_token');
      if (at && at === this._webAccessToken) return true;
    } catch { /* ignore */ }
    return false;
  }

  /** Default callback URL when not using browser `origin` (must match an entry in Google Cloud Console). */
  _defaultGmailRedirectUri() {
    const fixed = (config.googleRedirectUri || process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (fixed) return fixed.replace(/\/$/, '');
    const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${config.webPort}`;
    return `${String(base).replace(/\/$/, '')}/api/gmail/oauth/callback`;
  }

  /**
   * Browser often uses `http://localhost:3000` while the server defaulted to `127.0.0.1` — Google requires
   * an exact redirect_uri match. Prefer `?origin=` from the client, or env override.
   */
  _isAllowedOAuthOrigin(originParam) {
    if (!originParam || typeof originParam !== 'string') return null;
    try {
      const u = new URL(originParam);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      const host = u.hostname;
      if (host === 'localhost' || host === '127.0.0.1') {
        return `${u.protocol}//${u.host}`;
      }
      const render = process.env.RENDER_EXTERNAL_URL;
      if (render) {
        try {
          if (u.origin === new URL(render).origin) return u.origin;
        } catch { /* ignore */ }
      }
      const extra = config.googleOauthPublicOrigins || process.env.GOOGLE_OAUTH_PUBLIC_ORIGINS || '';
      for (const raw of extra.split(',')) {
        const t = raw.trim();
        if (!t) continue;
        try {
          const allowed = new URL(t.includes('://') ? t : `https://${t}`).origin;
          if (u.origin === allowed) return u.origin;
        } catch { /* ignore */ }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Full redirect_uri for authorize + token exchange (one string for both steps).
   * Prefer a validated browser `?origin=` (e.g. http://localhost:3000) over GOOGLE_REDIRECT_URI so local
   * dev works when the env still points at production; Google Console must list both redirect URIs.
   */
  _resolveGmailOAuthRedirectUri(req) {
    const origin = req.query?.origin;
    const allowed = origin ? this._isAllowedOAuthOrigin(origin) : null;
    if (allowed) return `${allowed.replace(/\/$/, '')}/api/gmail/oauth/callback`;
    return this._defaultGmailRedirectUri();
  }

  _gmailOAuth2Client(redirectUri) {
    const id = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
    const secret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret) return null;
    const uri = redirectUri || this._defaultGmailRedirectUri();
    return new google.auth.OAuth2(id, secret, uri);
  }

  _gmailConfigured() {
    return !!this._gmailOAuth2Client();
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
          void runWithTenant(this._waTenantId, async () => {
            try {
              const n = await this._waClient.syncResolvedNamesToDb(this.db);
              if (n > 0) {
                this._broadcast({ type: 'chat-names-refreshed', data: { stats: this.db.getTotalStats() } });
              }
            } catch (e) {
              console.warn('[WA] syncResolvedNamesToDb:', e.message);
            }
          });
        }, 2000);
      }
      // Phone book / saved contact names come from WhatsApp app-state (`contactAction.fullName` → contacts.upsert)
      if (this._waClient?.refreshPhoneBookNamesInDb) {
        setTimeout(() => {
          void runWithTenant(this._waTenantId, async () => {
            try {
              const n = await this._waClient.refreshPhoneBookNamesInDb(this.db);
              this._broadcast({
                type: 'chat-names-refreshed',
                data: { stats: this.db.getTotalStats(), rowsUpdated: n },
              });
            } catch (e) {
              console.warn('[WA] refreshPhoneBookNamesInDb:', e.message);
            }
          });
        }, 5500);
      }
    }
    const stats = runWithTenant(this._waTenantId, () => this.db.getTotalStats());
    this._broadcast({
      type: 'wa-status',
      data: { state, message, stats },
    });
  }

  /** Called by WaClient when messages arrive (real-time or history). */
  onWaMessages(rows) {
    runWithTenant(this._waTenantId, () => {
      const { count: inserted, insertedMessageIds } = this.db.insertMessageBatch(rows);
      const lastNameByChat = new Map();
      for (const r of rows || []) {
        if (r?.chatJid && r?.chatName) lastNameByChat.set(r.chatJid, r.chatName);
      }
      for (const [chatJid, chatName] of lastNameByChat) {
        if (this._waClient?.propagateDisplayNameForChat) {
          void this._waClient.propagateDisplayNameForChat(this.db, chatJid, chatName).catch(() => {});
        } else {
          this.db.propagateChatDisplayName(chatJid, chatName);
        }
      }
      if (inserted > 0) {
        console.log(`[WA] Saved ${inserted} new messages`);
        this._broadcast({ type: 'new-messages', data: { count: inserted, stats: this.db.getTotalStats() } });
        this._mediaIndexService?.scheduleProcess?.();
        this._actionItemService?.enqueueByMessageIds(insertedMessageIds);
      }
    });
  }

  /** Called by WaClient during history sync with progress info. */
  onWaProgress({ completed, total, messages }) {
    this._broadcast({ type: 'sync-progress', data: { completed, total, messages } }, this._waTenantId);
  }

  /** Called by DailySummaryService while indexing thread summaries per chat. */
  onSummaryProgress(data) {
    this._broadcast({ type: 'summary-progress', data }, this._waTenantId);
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
    this._wss.on('connection', (ws, req) => {
      ws.tenantId = req.tenantId || this._waTenantId;
      this._clients.add(ws);
      ws.on('close', () => this._clients.delete(ws));
      ws.on('error', () => this._clients.delete(ws));
      // Send current state immediately on connect (scoped DB via AsyncLocalStorage)
      runWithTenant(ws.tenantId, () => {
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
    });
  }

  _setupRoutes() {
    this._app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Web-Access-Token');
      if (_req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
    this._app.use(express.json({ limit: '10mb' }));

    this._app.use((req, res, next) => {
      if (!this._webAccessToken) return next();
      const path = req.path || '';
      if (path === '/health' || path === '/api/health') return next();
      if (!path.startsWith('/api/')) return next();
      if (path === '/api/gmail/oauth/callback') return next();
      if (this._requestHasValidAccessToken(req)) return next();
      return res.status(401).json({ error: 'Unauthorized', authRequired: true });
    });

    /** Per-request SQLite tenant (JWT sub) or default legacy tenant. */
    this._app.use((req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      const path = req.path || '';
      if (!path.startsWith('/api/') || path === '/api/health' || path.startsWith('/api/auth/') || path === '/api/gmail/oauth/callback') {
        return runWithTenant(LEGACY_TENANT_ID, () => next());
      }
      if (!isJwtAuthEnabled()) {
        return runWithTenant(config.defaultTenantId || LEGACY_TENANT_ID, () => next());
      }
      const auth = req.headers?.authorization;
      const token = auth && /^Bearer\s+(\S+)/i.exec(auth)?.[1];
      const v = verifyTenantToken(token);
      if (!v?.tenantId) {
        return res.status(401).json({ error: 'Unauthorized', needLogin: true });
      }
      req.tenantId = v.tenantId;
      return runWithTenant(v.tenantId, () => next());
    });

    registerAuthRoutes(this._app, this.db.getSqliteDatabase());

    /** WhatsApp + Chrome extension ingest always map to the linked-device tenant partition. */
    this._app.use('/api/wa', (req, res, next) => runWithTenant(this._waTenantId, () => next()));
    this._app.use('/api/extension', (req, res, next) => runWithTenant(this._waTenantId, () => next()));

    // Render / load balancers: use Health Check Path = /health or /api/health
    this._app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));
    this._app.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));

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

    this._app.get('/api/chats/:chatJid/action-items', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid);
        res.json(this.db.getChatActionItemsWithContext(chatJid));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/messages', (req, res) => {
      const chatJid = req.query.chatJid;
      if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 80, 500);
      const offset = parseInt(req.query.offset, 10) || 0;
      const focusMessageId = typeof req.query.focusMessageId === 'string' ? req.query.focusMessageId.trim() : '';
      if (focusMessageId) {
        return res.json(this.db.getMessagesAroundMessageId(chatJid, focusMessageId, limit));
      }
      return res.json(this.db.getMessagesPaginated(chatJid, limit, offset));
    });

    this._app.delete('/api/chats/:chatJid', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid);
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const deleted = this.db.deleteChat(chatJid);
        this._broadcast(
          { type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } },
          getCurrentTenantId(),
        );
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
        this._broadcast(
          {
            type: 'chat-names-refreshed',
            data: { stats: this.db.getTotalStats(), rowsUpdated },
          },
          this._waTenantId,
        );
        res.json({ ok: true, rowsUpdated });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Extension Sync Endpoints ──────────────────────────────────────
    this._app.post('/api/extension/chats', (req, res) => {
      this._extensionConnected = true;
      this._broadcast(
        { type: 'status', data: { connected: true, stats: this.db.getTotalStats() } },
        this._waTenantId,
      );
      res.json({ ok: true });
    });

    this._app.post('/api/extension/messages', (req, res) => {
      try {
        if (!this._extensionConnected) {
          this._extensionConnected = true;
          this._broadcast(
            { type: 'status', data: { connected: true, stats: this.db.getTotalStats() } },
            this._waTenantId,
          );
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

        const { count: inserted, insertedMessageIds } = this.db.insertMessageBatch(rows);
        if (inserted > 0) {
          console.log(`[Extension] Synced ${inserted} new messages`);
          this._broadcast(
            { type: 'new-messages', data: { count: inserted, stats: this.db.getTotalStats() } },
            this._waTenantId,
          );
          this._actionItemService?.enqueueByMessageIds(insertedMessageIds);
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
        const settings = publicSettingsFromDb(this.db);
        const providers = await this._buildProvidersMeta(this.db.getAllSettings());
        res.json({ settings, providers, keyHints: keyHints(this.db) });
      } catch (err) {
        console.error('[Settings] GET error:', err.message);
        res.json({
          settings: publicSettingsFromDb(this.db),
          providers: PROVIDER_META,
          keyHints: keyHints(this.db),
        });
      }
    });

    this._app.post('/api/settings', async (req, res) => {
      try {
        const { provider, apiKey, model } = req.body;

        if (provider) this.db.setSetting('llm_provider', provider);
        if (Object.prototype.hasOwnProperty.call(req.body, 'apiKey')) {
          this.db.setSetting('llm_api_key', apiKey ?? '');
        }
        if (model) this.db.setSetting('llm_model', model);

        clearProviderCache();

        const p = provider || this.db.getSetting('llm_provider') || config.defaultSearchProvider;
        const m = model || this.db.getSetting('llm_model') || config.defaultSearchModel;
        const k = effectiveSearchApiKey(this.db);

        const instance = await createProvider(p, k, m || undefined);
        const healthy = await instance.checkHealth();

        this.searchEngine.setProvider(instance);
        this._mediaIndexService?.setProvider?.(instance);

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
          const mainP = this.db.getSetting('llm_provider') || config.defaultSearchProvider;
          const mainK = effectiveSearchApiKey(this.db);
          const mainM = this.db.getSetting('llm_model') || config.defaultSearchModel;
          const mainInstance = await createProvider(mainP, mainK, mainM || undefined);
          this.summaryService.setProvider(mainInstance);
          this._triggerSummaryGen();
          return res.json({ ok: true, healthy: true, provider: 'same', model: mainInstance.model });
        }

        if (provider) this.db.setSetting('summary_provider', provider);
        if (Object.prototype.hasOwnProperty.call(req.body, 'apiKey')) {
          this.db.setSetting('summary_api_key', apiKey ?? '');
        }
        if (model) this.db.setSetting('summary_model', model);

        clearProviderCache();

        const sp = provider || this.db.getSetting('summary_provider') || config.defaultSummaryProvider;
        const sm = model || this.db.getSetting('summary_model') || config.defaultSummaryModel;
        const sk = effectiveSummaryApiKey(this.db);

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

    // ── Gmail: OAuth + sync WhatsApp exports from attachments ─────────
    this._app.get('/api/gmail/status', (_req, res) => {
      const configured = this._gmailConfigured();
      const connected = !!this.db.getSetting('gmail_refresh_token');
      const email = this.db.getSetting('gmail_email') || null;
      return res.json({ configured, connected, email });
    });

    this._app.get('/api/gmail/auth-url', (req, res) => {
      const id = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
      const secret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
      if (!id || !secret) {
        return res.status(503).json({
          error: 'Gmail sync is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (and GOOGLE_REDIRECT_URI in production).',
        });
      }
      const redirectUri = this._resolveGmailOAuthRedirectUri(req);
      const oauth2 = new google.auth.OAuth2(id, secret, redirectUri);
      const state = randomBytes(24).toString('hex');
      const now = Date.now();
      for (const [k, v] of this._gmailOAuthState) {
        if (now - v.ts > 15 * 60 * 1000) this._gmailOAuthState.delete(k);
      }
      const fromQuery = req.query?.origin ? this._isAllowedOAuthOrigin(String(req.query.origin)) : null;
      const fromHeader = req.headers.origin ? this._isAllowedOAuthOrigin(req.headers.origin) : null;
      let fromReferer = null;
      if (req.headers.referer) {
        try {
          fromReferer = this._isAllowedOAuthOrigin(new URL(req.headers.referer).origin);
        } catch { /* ignore */ }
      }
      const returnOrigin = fromQuery || fromHeader || fromReferer || '';
      this._gmailOAuthState.set(state, {
        ts: now,
        onboarding: req.query.ob === '1',
        redirectUri,
        returnOrigin,
        tenantId: getCurrentTenantId(),
      });
      const url = oauth2.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [GMAIL_SCOPE],
        state,
      });
      return res.json({ url });
    });

    this._app.get('/api/gmail/oauth/callback', async (req, res) => {
      const err = req.query.error;
      if (err) {
        const desc = req.query.error_description;
        const msg = desc ? `${err}: ${desc}` : String(err);
        const pendingErr = req.query.state ? this._gmailOAuthState.get(String(req.query.state)) : null;
        const base = (pendingErr?.returnOrigin || '').trim().replace(/\/$/, '');
        const path = base
          ? `${base}/?gmail_error=${encodeURIComponent(msg)}`
          : `/?gmail_error=${encodeURIComponent(msg)}`;
        return res.redirect(path);
      }
      const code = req.query.code;
      const state = req.query.state;
      if (!code || !state) return res.status(400).send('Missing code or state');
      const pending = this._gmailOAuthState.get(state);
      if (!pending || Date.now() - pending.ts > 15 * 60 * 1000) {
        return res.status(400).send('Invalid or expired OAuth state. Try connecting again.');
      }
      this._gmailOAuthState.delete(state);
      const id = config.googleClientId || process.env.GOOGLE_CLIENT_ID;
      const secret = config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET;
      if (!id || !secret) return res.status(503).send('Gmail is not configured');

      const redirectUri = pending.redirectUri || this._defaultGmailRedirectUri();
      const oauth2 = new google.auth.OAuth2(id, secret, redirectUri);
      const appBase = (pending.returnOrigin || '').trim().replace(/\/$/, '');

      try {
        const { tokens } = await oauth2.getToken({
          code: String(code),
          redirect_uri: redirectUri,
        });
        if (!tokens.refresh_token) {
          const q = `gmail_error=${encodeURIComponent('No refresh token — remove app access in Google Account → Security and try again.')}`;
          return res.redirect(appBase ? `${appBase}/?${q}` : `/?${q}`);
        }
        const tid = pending.tenantId || LEGACY_TENANT_ID;
        runWithTenant(tid, () => {
          this.db.setSetting('gmail_refresh_token', tokens.refresh_token);
        });
        oauth2.setCredentials(tokens);
        try {
          const gmail = google.gmail({ version: 'v1', auth: oauth2 });
          const prof = await gmail.users.getProfile({ userId: 'me' });
          if (prof.data.emailAddress) {
            runWithTenant(tid, () => {
              this.db.setSetting('gmail_email', prof.data.emailAddress);
            });
          }
        } catch (e) {
          console.warn('[Gmail] getProfile:', e.message);
        }
      } catch (e) {
        console.error('[Gmail] token exchange:', e.message);
        const q = `gmail_error=${encodeURIComponent(e.message)}`;
        return res.redirect(appBase ? `${appBase}/?${q}` : `/?${q}`);
      }

      let loc = appBase ? `${appBase}/?gmail_connected=1` : '/?gmail_connected=1';
      if (pending.onboarding) loc += '&ob=1';
      return res.redirect(loc);
    });

    this._app.post('/api/gmail/disconnect', (_req, res) => {
      this.db.setSetting('gmail_refresh_token', '');
      this.db.setSetting('gmail_email', '');
      return res.json({ ok: true });
    });

    this._app.post('/api/gmail/sync', async (_req, res) => {
      const refresh = this.db.getSetting('gmail_refresh_token');
      if (!refresh) return res.status(401).json({ error: 'Gmail not connected. Use Connect Google first.' });
      const oauth2 = this._gmailOAuth2Client();
      if (!oauth2) return res.status(503).json({ error: 'Server Gmail OAuth is not configured.' });
      oauth2.setCredentials({ refresh_token: refresh });
      try {
        const out = await syncWhatsAppExportsFromGmail(this.db, oauth2);
        this._broadcast(
          { type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } },
          getCurrentTenantId(),
        );
        this.summaryService.indexPendingDays().then((count) => {
          if (count > 0) console.log(`[Gmail sync] Generated ${count} daily summaries`);
        }).catch((err) => console.error('[Gmail sync] Summary error:', err.message));
        return res.json({ ok: true, ...out });
      } catch (err) {
        console.error('[Gmail sync]', err.message);
        return res.status(500).json({ error: err.message });
      }
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
        const tid = getCurrentTenantId();
        this.summaryService.indexPendingDays().then((count) => {
          console.log(`[Summaries] Regenerated ${count} thread summaries`);
          runWithTenant(tid, () => {
            this._broadcast(
              { type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } },
              tid,
            );
          });
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

        this._broadcast(
          { type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } },
          getCurrentTenantId(),
        );

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
    const tid = getCurrentTenantId();
    this.summaryService.indexPendingDays().then((count) => {
      if (count > 0) {
        console.log(`[Settings] Generated ${count} summaries`);
        runWithTenant(tid, () => {
          this._broadcast(
            { type: 'status', data: { connected: this._extensionConnected, stats: this.db.getTotalStats() } },
            tid,
          );
        });
      }
    }).catch(err => console.error('[Settings] Summary gen error:', err.message));
  }

  _sendTo(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  /**
   * Push to WebSocket clients for one tenant only (prevents cross-tenant leakage).
   * @param {object} msg
   * @param {string} [tenantId] defaults to WhatsApp pipeline tenant
   */
  _broadcast(msg, tenantId = this._waTenantId) {
    const payload = JSON.stringify(msg);
    for (const ws of this._clients) {
      if (ws.tenantId !== tenantId) continue;
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  start() {
    return new Promise((resolve) => {
      this._server.listen(config.webPort, config.webHost, () => {
        const publicUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${config.webPort}`;
        console.log(`\nListening on ${config.webHost}:${config.webPort}`);
        console.log(`Web UI: ${publicUrl}\n`);
        resolve();
      });
    });
  }

  stop() {
    this._wss.close();
    this._server.close();
  }
}
