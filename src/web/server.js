import { parse } from 'cookie';
import cookieParser from 'cookie-parser';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { createServer } from 'http';
import { createRequire } from 'module';
import { randomBytes } from 'node:crypto';
import { basename, join, relative, resolve } from 'path';
import { isJwtAuthEnabled } from '../auth/jwt-util.js';
import { getSessionIdFromRequest, setSessionCookie, UserSessionService } from '../auth/user-session.js';
import config from '../config.js';
import { MAX_MESSAGES_PAGE } from '../constants/api-limits.js';
import { syncWhatsAppExportsFromGmail } from '../gmail/gmail-sync.js';
import { decodeExportBuffer, extractMediaFromZip, extractTextFromZip, importExportedChat, slugForImportChatJid } from '../import/chat-import.js';
import {
    effectiveSearchApiKey,
    effectiveSummaryApiKey,
    keyHints,
    publicSettingsFromDb,
} from '../llm/defaults.js';
import { fetchOllamaCloudModelNames } from '../llm/ollama-cloud.js';
import { applyOllamaMemorySettings, getHardwareRecommendation, resolveSafeOllamaModel } from '../llm/ollama-recommend.js';
import { canSpawnLocalOllama, localOllamaUnsupportedReason } from '../llm/deployment-env.js';
import { clearProviderCache, createProvider, PROVIDER_META } from '../llm/provider.js';
import { hashWhatsAppOwnerId } from '../privacy/wa-identity.js';
import SmbInboxService from '../smb/inbox-service.js';
import AppointmentBoardService from '../smb/appointment-board.js';
import {
  detectSmbLibraryMismatch,
  getSearchPrompts,
  getSmbProfileFromDb,
  listSmbProfileOptions,
  resolveSmbProfile,
  SMB_BUSINESS_NAME_SETTING,
  SMB_PROFILE_SETTING,
} from '../smb/profiles.js';
import { LEGACY_TENANT_ID } from '../storage/tenant-constants.js';
import { getCurrentTenantId, runWithTenant } from '../storage/tenant-context.js';
import WaClient from '../whatsapp/wa-client.js';
import WabaIngestService, { verifyWabaSignature } from '../whatsapp/waba-client.js';
import { getWabaConfig, publicWabaConfig, saveWabaConfig } from '../whatsapp/waba-settings.js';
import { registerAuthRoutes } from './auth-routes.js';

const require = createRequire(import.meta.url);
const express = require('express');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const { google } = require('googleapis');
const QRCode = require('qrcode');

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

/** Never expose raw filesystem paths to the browser — only `hasMediaFile` + `/api/message-media`. */
function sanitizeClientMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const o = { ...m };
  const hadPath = !!(o.mediaPath && String(o.mediaPath).trim());
  if (o.mediaPath) {
    o.hasMediaFile = true;
    delete o.mediaPath;
  }
  o.mediaPending = !!(o.mediaType && !hadPath);
  return o;
}

/** Per-chat latest timestamp + insert count for sidebar reorder without refetching all chats. */
function summarizeChatTouchesFromRows(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const chatJid = r?.chatJid;
    if (!chatJid) continue;
    const ts = Number(r.timestamp) || 0;
    let entry = map.get(chatJid);
    if (!entry) {
      entry = { chatJid, lastMessageTs: ts, count: 0 };
      map.set(chatJid, entry);
    }
    entry.count += 1;
    if (ts > entry.lastMessageTs) entry.lastMessageTs = ts;
  }
  return [...map.values()];
}

function sanitizeMessageList(list) {
  if (!Array.isArray(list)) return list;
  return list.map(sanitizeClientMessage);
}

function assertPathUnderMediaRoot(absFilePath) {
  const file = resolve(absFilePath);
  const root = resolve(config.mediaDir);
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || rel.includes('..')) return null;
  if (!existsSync(file)) return null;
  return file;
}

function contentTypeForMediaFile(filePath) {
  const ext = (String(filePath).split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    pdf: 'application/pdf',
  };
  return map[ext] || 'application/octet-stream';
}

/** Safe single-line filename for Content-Disposition (ASCII; avoids CRLF / quotes). */
function attachmentFilenameFromPath(absPath, fallbackMessageId) {
  let base = basename(String(absPath || ''));
  if (!base || base === '.' || base === '..') {
    base = `whatsapp-media-${String(fallbackMessageId || 'file').slice(0, 40)}`;
  }
  return base.replace(/[^\x20-\x7E]/g, '_').replace(/["\\\r\n]/g, '_').slice(0, 180) || 'download.bin';
}

export default class WebServer {
  constructor({
    db,
    searchEngine,
    summaryService,
    mediaIndexService,
    actionItemService,
    reloadMediaIndexProvider,
  }) {
    this.db = db;
    this.searchEngine = searchEngine;
    this.summaryService = summaryService;
    this._mediaIndexService = mediaIndexService || null;
    this._actionItemService = actionItemService || null;
    this._smbInbox = new SmbInboxService(db);
    this._appointmentBoard = new AppointmentBoardService(db);
    this._wabaIngest = new WabaIngestService({
      db,
      onBroadcast: (payload, tenantId) => this._broadcast(payload, tenantId),
      actionItemService: this._actionItemService,
      mediaIndexService: this._mediaIndexService,
    });
    /** @type {(() => Promise<{ healthy?: boolean, provider?: string, model?: string }|void>)|null} */
    this._reloadMediaIndexProvider = reloadMediaIndexProvider || null;
    this._userSessions = new UserSessionService(this.db.getSqliteDatabase());

    this._app = express();
    this._server = createServer(this._app);
    this._clients = new Set();

    /**
     * Per-tenant runtime state (prevents data/status leakage across users).
     * @type {Map<string, {
     *   extensionConnected: boolean,
     *   waState: string,
     *   waMessage: string,
     *   waQrDataUrl: string | null,
     *   waClient: any | null,
     *   syncStats: { syncing: boolean, total: number, current: number, totalMessages: number }
     * }>}
     */
    this._tenantState = new Map();

    /** @type {Map<string, { ts: number, onboarding: boolean }>} */
    this._gmailOAuthState = new Map();

    this._wss = new WebSocketServer({
      server: this._server,
      verifyClient: (info) => this._verifyWsClient(info),
    });
    this._setupWebSocket();
    this._migrateLegacyDataToWaTenant();
    if (config.isDesktopApp) this._normalizeDesktopSessions();
    this._setupRoutes();
  }

  _isPublicInternetDeploy() {
    return process.env.RENDER === 'true' || Boolean(String(process.env.RENDER_EXTERNAL_URL || '').trim());
  }

  /** Set HttpOnly cookie `Secure` flag: true in production/HTTPS. */
  _isSecureCookieDeployment() {
    return this._isPublicInternetDeploy() || String(process.env.FORCE_SECURE_COOKIES || '').toLowerCase() === 'true';
  }

  /**
   * If exactly one WA identity exists (single-user local deployment), return its tenant_id
   * so new browser sessions can reuse it instead of creating empty tenants.
   */
  _findSoleTenantFromWaIdentity() {
    try {
      const sql = this.db.getSqliteDatabase();
      const rows = sql.prepare('SELECT tenant_id FROM wa_identities LIMIT 2').all();
      if (rows.length === 1) return rows[0].tenant_id;
    } catch (_) { /* table may not exist yet */ }
    return null;
  }

  /** Local installs: reuse the tenant that already holds imported/synced messages. */
  _findLocalTenantWithMostMessages() {
    if (this._isPublicInternetDeploy()) return null;
    try {
      const sql = this.db.getSqliteDatabase();
      const row = sql.prepare(`
        SELECT tenant_id AS tenantId, COUNT(*) AS c
        FROM messages
        GROUP BY tenant_id
        ORDER BY c DESC
        LIMIT 1
      `).get();
      if (row?.tenantId && row.c > 0) return row.tenantId;
    } catch (_) { /* ignore */ }
    return null;
  }

  _desktopTenantId() {
    return config.defaultTenantId || LEGACY_TENANT_ID;
  }

  _normalizeDesktopSessions() {
    try {
      const tid = this._desktopTenantId();
      const sql = this.db.getSqliteDatabase();
      const n = sql.prepare('UPDATE user_sessions SET tenant_id = ? WHERE tenant_id != ?').run(tid, tid).changes;
      if (n > 0) console.log(`[Desktop] Rebound ${n} session(s) to tenant ${tid}`);
    } catch (e) {
      console.warn('[Desktop] session normalize:', e.message);
    }
  }

  /**
   * Desktop app: one stable workspace — never spin up empty UUID tenants per tab/request.
   * @returns {boolean} true when handled
   */
  _applyDesktopTenantSession(req, res, next) {
    if (!config.isDesktopApp) return false;

    const tid = this._desktopTenantId();
    const secure = this._isSecureCookieDeployment();
    let sid = getSessionIdFromRequest(req);
    let row = sid ? this._userSessions.getById(sid) : null;

    if (row && row.tenant_id !== tid) {
      this._userSessions.rebindTenant(sid, tid);
      row = { ...row, tenant_id: tid };
    }

    if (!row) {
      sid = this._userSessions.create(tid);
      setSessionCookie(res, sid, { secure });
    } else {
      this._userSessions.touch(sid);
    }

    req.tenantId = tid;
    req.waSessionId = sid;
    this._getTenantState(tid).sessionId = sid;
    runWithTenant(tid, () => next());
    return true;
  }

  /**
   * On local installs, data imported before multi-tenant was introduced lives
   * under `legacy-default`.  Move it to the active WA tenant so the user sees
   * all their chats in one place.
   */
  _migrateLegacyDataToWaTenant() {
    if (this._isPublicInternetDeploy()) return;
    const waTenant = this._findSoleTenantFromWaIdentity();
    if (!waTenant || waTenant === LEGACY_TENANT_ID) return;
    const sql = this.db.getSqliteDatabase();
    const legacyCount = sql.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE tenant_id = ?',
    ).get(LEGACY_TENANT_ID)?.c || 0;
    if (legacyCount === 0) return;
    console.log(`[Migration] Moving ${legacyCount} legacy-default messages → tenant ${waTenant}`);
    const migrate = sql.transaction(() => {
      // Move messages that don't conflict; delete duplicates that already exist under the target tenant.
      sql.prepare(`
        UPDATE messages SET tenant_id = ?
        WHERE tenant_id = ?
          AND message_id NOT IN (SELECT message_id FROM messages WHERE tenant_id = ?)
      `).run(waTenant, LEGACY_TENANT_ID, waTenant);
      sql.prepare('DELETE FROM messages WHERE tenant_id = ?').run(LEGACY_TENANT_ID);
      try { sql.prepare('UPDATE chat_import_touches SET tenant_id = ? WHERE tenant_id = ?').run(waTenant, LEGACY_TENANT_ID); } catch (_) {}
      try { sql.prepare('UPDATE daily_summaries SET tenant_id = ? WHERE tenant_id = ?').run(waTenant, LEGACY_TENANT_ID); } catch (_) {}
    });
    migrate();
    console.log(`[Migration] Done — legacy data merged into active tenant.`);
  }

  _getTenantState(tenantId) {
    const tid = tenantId || LEGACY_TENANT_ID;
    let st = this._tenantState.get(tid);
    if (!st) {
      const authDir = join(config.dataDir, 'tenants', tid, '.baileys_auth');
      const hasAuth = existsSync(join(authDir, 'creds.json'));

      st = {
        extensionConnected: false,
        waState: 'DISCONNECTED',
        waMessage: hasAuth ? 'Not connected' : 'Logged out — rescan QR to reconnect',
        waQrDataUrl: null,
        waClient: null,
        sessionId: null,
        syncStats: { syncing: false, total: 0, current: 0, totalMessages: 0 },
      };
      this._tenantState.set(tid, st);
    }
    return st;
  }

  _runWaHistoryCompleteHooks(tid, waClient) {
    const st = this._getTenantState(tid);
    if (st.waHistoryHooksDone) return;
    st.waHistoryHooksDone = true;
    this._getCachedTotalStats(tid, { force: true });
    this._mediaIndexService?.scheduleProcess?.();
    if (waClient?.syncResolvedNamesToDb) {
      setTimeout(() => {
        void runWithTenant(tid, async () => {
          try {
            const n = await waClient.syncResolvedNamesToDb(this.db);
            if (n > 0) {
              this._broadcast({
                type: 'chat-names-refreshed',
                data: { stats: this._getCachedTotalStats(tid, { force: true }) },
              }, tid);
            }
          } catch (e) {
            console.warn('[WA] syncResolvedNamesToDb:', e.message);
          }
        });
      }, 2000);
    }
    if (config.waAutoAppStateResync && waClient?.refreshPhoneBookNamesInDb) {
      setTimeout(() => {
        void runWithTenant(tid, async () => {
          try {
            const n = await waClient.refreshPhoneBookNamesInDb(this.db);
            this._broadcast({
              type: 'chat-names-refreshed',
              data: { stats: this._getCachedTotalStats(tid, { force: true }), rowsUpdated: n },
            }, tid);
          } catch (e) {
            console.warn('[WA] refreshPhoneBookNamesInDb:', e.message);
          }
        });
      }, 5500);
    }
  }

  /** True while linked-device history is still streaming (heavy work should yield). */
  isTenantWaHistoryBusy(tenantId) {
    const st = this._getTenantState(tenantId);
    if (st.waState === 'SYNCING' || st.waState === 'LOADING') return true;
    return Boolean(st.waClient?.isInitialHistorySync);
  }

  _getCachedTotalStats(tenantId, { force = false } = {}) {
    const st = this._getTenantState(tenantId);
    const busy = this.isTenantWaHistoryBusy(tenantId);
    const now = Date.now();
    if (!force && busy && st._statsCache && now - (st._statsCacheAt || 0) < 2500) {
      return st._statsCache;
    }
    const stats = runWithTenant(tenantId, () => this.db.getTotalStats());
    st._statsCache = stats;
    st._statsCacheAt = now;
    return stats;
  }

  /** @returns {boolean} */
  _verifyWsClient(info) {
    const req = info.req;
    if (isJwtAuthEnabled()) {
      const cookies = parse(String(req.headers?.cookie || ''));
      const sid = getSessionIdFromRequest({ cookies, headers: req.headers });
      const row = sid ? this._userSessions.getById(sid) : null;
      if (!row) return false;
      this._userSessions.touch(sid);
      req.tenantId = row.tenant_id;
      req.waSessionId = sid;
      return true;
    }
    req.tenantId = config.defaultTenantId || LEGACY_TENANT_ID;
    return true;
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

  _ensureTenantWaClient(tenantId) {
    const tid = tenantId || LEGACY_TENANT_ID;
    const st = this._getTenantState(tid);
    if (st.waClient) return st.waClient;

    const baseDir = join(config.dataDir, 'tenants', tid);
    const authDir = join(baseDir, '.baileys_auth');
    const cfgFile = join(baseDir, 'wa-config.json');
    mkdirSync(baseDir, { recursive: true });

    const waClient = new WaClient({
      authDir,
      configFile: cfgFile,
      onQr: (dataUrl) => {
        st.waQrDataUrl = dataUrl;
        st.waState = 'QR_READY';
        this._broadcast({ type: 'wa-qr', data: { qr: dataUrl } }, tid);
      },
      onReady: async (info) => {
        console.log(`[WA] Tenant ${tid} logged in as ${info.name || info.phone}`);
        try {
          const ownerJid = waClient?._ownerJid || (info?.phone ? `${info.phone}@s.whatsapp.net` : '');
          await this._maybeBindSessionToWhatsAppIdentity({
            currentTenantId: tid,
            sessionId: st.sessionId,
            ownerJid,
          });
        } catch (e) {
          console.warn('[WA] identity bind:', e.message);
        }
      },
      onStatus: ({ state, message }) => {
        st.waState = state;
        st.waMessage = message;

        if (state !== 'READY' && state !== 'SYNCING') {
          st.extensionConnected = false;
        }

        if (state === 'QR_READY' || state === 'DISCONNECTED' || state === 'LOADING') {
          st.waHistoryHooksDone = false;
        }
        if (state === 'READY') {
          st.waQrDataUrl = null;
          st.extensionConnected = true;
        }
        const stats = this._getCachedTotalStats(tid);
        this._broadcast({ type: 'wa-status', data: { state, message, stats } }, tid);
      },
      onProgress: ({ completed, total, messages }) => {
        this._broadcast({ type: 'sync-progress', data: { completed, total, messages } }, tid);
      },
      onChatsPreview: (preview) => {
        if (Array.isArray(preview) && preview.length) {
          this._broadcast({ type: 'sync-chats-preview', data: { chats: preview } }, tid);
        }
      },
      onHistorySyncComplete: () => this._runWaHistoryCompleteHooks(tid, waClient),
      onMessages: (rows) => {
        const historyBusy = this.isTenantWaHistoryBusy(tid);
        runWithTenant(tid, () => {
          const { count: inserted, insertedMessageIds } = this.db.insertMessageBatch(rows);
          const lastNameByChat = new Map();
          for (const r of rows || []) {
            if (r?.chatJid && r?.chatName) lastNameByChat.set(r.chatJid, r.chatName);
          }
          for (const [chatJid, chatName] of lastNameByChat) {
            if (!historyBusy && waClient?.propagateDisplayNameForChat) {
              void waClient.propagateDisplayNameForChat(this.db, chatJid, chatName).catch(() => {});
            } else {
              this.db.propagateChatDisplayName(chatJid, chatName);
            }
          }
          if (inserted > 0) {
            if (!historyBusy || inserted >= 200) {
              console.log(`[WA] Tenant ${tid} saved ${inserted} new messages`);
            }
            this._broadcast({
              type: 'new-messages',
              data: {
                count: inserted,
                stats: this._getCachedTotalStats(tid),
                chatTouches: summarizeChatTouchesFromRows(rows),
              },
            }, tid);
            if (!historyBusy) {
              this._mediaIndexService?.scheduleProcess?.();
              this._actionItemService?.enqueueByMessageIds(insertedMessageIds);
            }
          }
        });
      },
      onSearchQuery: async (query) => {
        try {
          return await runWithTenant(tid, async () => this.searchEngine.search(query, null));
        } catch (e) {
          return { error: e.message };
        }
      },
      onDisconnected: () => console.log(`[WA] Tenant ${tid} connection closed`),
      onMediaPath: (messageId, mediaPath) => {
        runWithTenant(tid, () => {
          this.db.updateMessageMediaPath(messageId, mediaPath);
          const chatJid = this.db.getMessageChatJid(messageId);
          this._broadcast(
            { type: 'message-media-ready', data: { messageId: String(messageId), chatJid } },
            tid,
          );
          this._mediaIndexService?.scheduleProcess?.();
        });
      },
      onReaction: (payload) => {
        runWithTenant(tid, () => {
          const counts = this.db.mergeReactionEvent(
            payload.chatJid,
            payload.messageId,
            payload.emoji,
            payload.reactionMsgId,
            {
              groupingKey: payload.groupingKey,
              reactionKey: payload.reactionKey,
            },
          );
          if (counts) {
            this._broadcast(
              {
                type: 'message-reaction',
                data: {
                  chatJid: payload.chatJid,
                  messageId: payload.messageId,
                  counts,
                },
              },
              tid,
            );
          }
        });
      },
    });

    st.waClient = waClient;
    return waClient;
  }

  _tenantBaseDir(tid) {
    return join(config.dataDir, 'tenants', String(tid || LEGACY_TENANT_ID));
  }

  _moveTenantAuth(fromTid, toTid) {
    try {
      const fromBase = this._tenantBaseDir(fromTid);
      const toBase = this._tenantBaseDir(toTid);
      const fromAuth = join(fromBase, '.baileys_auth');
      const toAuth = join(toBase, '.baileys_auth');
      const fromCfg = join(fromBase, 'wa-config.json');
      const toCfg = join(toBase, 'wa-config.json');

      if (existsSync(fromAuth)) {
        // If destination already exists, back it up.
        if (existsSync(toAuth)) {
          const bak = `${toAuth}.bak-${Date.now()}`;
          renameSync(toAuth, bak);
        }
        renameSync(fromAuth, toAuth);
      }
      if (existsSync(fromCfg)) {
        if (existsSync(toCfg)) {
          const bak = `${toCfg}.bak-${Date.now()}`;
          renameSync(toCfg, bak);
        }
        renameSync(fromCfg, toCfg);
      }
    } catch (e) {
      console.warn('[WA] auth move:', e.message);
    }
  }

  async _maybeBindSessionToWhatsAppIdentity({ currentTenantId, sessionId, ownerJid }) {
    if (!isJwtAuthEnabled()) return;
    if (!sessionId) return;
    if (!ownerJid) return;
    const waHash = hashWhatsAppOwnerId(ownerJid);
    const sql = this.db.getSqliteDatabase();
    const now = Math.floor(Date.now() / 1000);
    sql.prepare('DELETE FROM wa_identities WHERE tenant_id IS NULL').run();

    const existing = sql.prepare('SELECT wa_hash, tenant_id FROM wa_identities WHERE wa_hash = ?').get(waHash);
    if (!existing) {
      sql.prepare(
        'INSERT INTO wa_identities (wa_hash, tenant_id, created_at, updated_at) VALUES (?,?,?,?)',
      ).run(waHash, currentTenantId, now, now);
      return;
    }
    const canonicalTenant = existing.tenant_id;
    if (!canonicalTenant || canonicalTenant === currentTenantId) {
      // refresh timestamp
      sql.prepare('UPDATE wa_identities SET updated_at = ? WHERE wa_hash = ?').run(now, waHash);
      return;
    }

    // Switch this session to canonical tenant and ask the browser to reload.
    sql.prepare('UPDATE user_sessions SET tenant_id = ? WHERE id = ?').run(canonicalTenant, sessionId);
    sql.prepare('UPDATE wa_identities SET updated_at = ? WHERE wa_hash = ?').run(now, waHash);

    // MUST stop Baileys before renaming `.baileys_auth` — moving creds while the socket / saveCreds is active
    // corrupts the session and typically yields immediate disconnect (408) right after scanning QR.
    const st = this._getTenantState(currentTenantId);
    const wa = st.waClient;
    if (wa && typeof wa.destroy === 'function') {
      try {
        await wa.destroy();
      } catch (e) {
        console.warn('[WA] destroy before auth move:', e.message);
      }
    }
    st.waClient = null;
    st.waQrDataUrl = null;
    st.waState = 'DISCONNECTED';
    st.waMessage = 'Switching workspace…';
    await new Promise((r) => setTimeout(r, 400));

    // Move newly-scanned Baileys auth into the canonical tenant dir so reconnects work.
    this._moveTenantAuth(currentTenantId, canonicalTenant);

    // Notify old-tenant websocket clients to reload; cookie now points to canonical tenant.
    this._broadcast({ type: 'session-switched', data: { toTenantId: canonicalTenant } }, currentTenantId);
  }

  /** Called by DailySummaryService while indexing thread summaries per chat. */
  onSummaryProgress(data) {
    this._broadcast({ type: 'summary-progress', data }, getCurrentTenantId());
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
      ws.tenantId = req.tenantId;
      this._clients.add(ws);
      ws.on('close', () => this._clients.delete(ws));
      ws.on('error', () => this._clients.delete(ws));
      // Send current state immediately on connect (scoped DB via AsyncLocalStorage)
      runWithTenant(ws.tenantId, () => {
        const st = this._getTenantState(ws.tenantId);
        this._sendTo(ws, {
          type: 'status',
          data: { connected: st.extensionConnected, stats: this.db.getTotalStats() },
        });
        this._sendTo(ws, {
          type: 'wa-status',
          data: { state: st.waState, message: st.waMessage, stats: this.db.getTotalStats() },
        });
        if (st.waQrDataUrl) {
          this._sendTo(ws, { type: 'wa-qr', data: { qr: st.waQrDataUrl } });
        }
      });
    });
  }

  _publicBaseUrl(req) {
    const render = String(process.env.RENDER_EXTERNAL_URL || '').trim();
    if (render) return render.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${config.webPort}`;
    return `${proto}://${host}`.replace(/\/$/, '');
  }

  _resolveTenantFromWabaBody(body) {
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const pid = change.value?.metadata?.phone_number_id;
        if (!pid) continue;
        const tid = this.db.findTenantIdBySetting('waba_phone_number_id', String(pid));
        if (tid) return tid;
      }
    }
    return config.defaultTenantId
      || this._findLocalTenantWithMostMessages()
      || LEGACY_TENANT_ID;
  }

  /** Meta Cloud API webhooks — no session cookie; tenant resolved from verify token / phone_number_id. */
  _registerWabaWebhookRoutes() {
    this._app.get('/api/waba/webhook', (req, res) => {
      try {
        const verifyToken = String(req.query['hub.verify_token'] || '');
        const tenantId = this.db.findTenantIdBySetting('waba_verify_token', verifyToken)
          || config.defaultTenantId
          || LEGACY_TENANT_ID;
        return runWithTenant(tenantId, () => {
          const result = this._wabaIngest.handleVerification(req.query, this.db);
          if (result.ok) return res.status(200).send(result.challenge);
          return res.sendStatus(403);
        });
      } catch (err) {
        console.error('[WABA] verify:', err.message);
        return res.sendStatus(500);
      }
    });

    this._app.post('/api/waba/webhook', async (req, res) => {
      try {
        const tenantId = this._resolveTenantFromWabaBody(req.body);
        await runWithTenant(tenantId, async () => {
          const cfg = getWabaConfig(this.db);
          if (cfg.appSecret) {
            const sig = req.headers['x-hub-signature-256'];
            const raw = JSON.stringify(req.body);
            if (!verifyWabaSignature(cfg.appSecret, raw, sig)) {
              return res.sendStatus(403);
            }
          }
          await this._wabaIngest.ingestWebhookBody(req.body, tenantId);
        });
        return res.sendStatus(200);
      } catch (err) {
        console.error('[WABA] webhook:', err.message);
        return res.sendStatus(500);
      }
    });
  }

  _setupRoutes() {
    this._app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');
      if (_req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
    this._app.use(cookieParser());
    this._app.use(express.json({ limit: '10mb' }));

    this._registerWabaWebhookRoutes();

    /**
     * Per-request tenant: httpOnly `ws.sid` cookie and/or `Authorization: Bearer` opaque sessionId (extension/mobile).
     * No client-side password or JWT; identity is a server-issued session (WhatsApp-like single URL, isolated data).
     */
    this._app.use((req, res, next) => {
      if (req.method === 'OPTIONS') return next();
      const path = req.path || '';
      if (!path.startsWith('/api/') || path === '/api/health' || path === '/api/gmail/oauth/callback') {
        return runWithTenant(LEGACY_TENANT_ID, () => next());
      }
      if (this._applyDesktopTenantSession(req, res, next)) return;
      if (!isJwtAuthEnabled()) {
        const tid = config.defaultTenantId
          || this._findSoleTenantFromWaIdentity()
          || LEGACY_TENANT_ID;
        return runWithTenant(tid, () => next());
      }
      // Claim endpoints must be accessible without creating a brand-new tenant implicitly.
      if (path === '/api/session/transfer/claim') {
        return runWithTenant(LEGACY_TENANT_ID, () => next());
      }
      const secure = this._isSecureCookieDeployment();
      let sid = getSessionIdFromRequest(req);
      let row = sid ? this._userSessions.getById(sid) : null;
      if (row) {
        this._userSessions.touch(sid);
        req.tenantId = row.tenant_id;
        req.waSessionId = sid;
        // Remember which session owns this tenant (used for WA identity binding on connect).
        this._getTenantState(req.tenantId).sessionId = sid;
        return runWithTenant(req.tenantId, () => next());
      }
      // On local-only installs, reuse the sole WA tenant (or existing message data) so the user
      // isn't locked out of their own imports after clearing cookies. On deployed servers, always
      // give new visitors a fresh isolated tenant — never leak User A's chats.
      const reuseLocal = !this._isPublicInternetDeploy()
        ? (this._findSoleTenantFromWaIdentity() || this._findLocalTenantWithMostMessages())
        : null;
      let c;
      if (reuseLocal) {
        const sessionId = this._userSessions.create(reuseLocal);
        c = { sessionId, tenantId: reuseLocal };
      } else {
        c = this._userSessions.createTenantWithSession();
      }
      req.tenantId = c.tenantId;
      req.waSessionId = c.sessionId;
      this._getTenantState(req.tenantId).sessionId = c.sessionId;
      setSessionCookie(res, c.sessionId, { secure });
      return runWithTenant(req.tenantId, () => next());
    });

    registerAuthRoutes(this._app, {
      sessions: this._userSessions,
      isSecureCookie: () => this._isSecureCookieDeployment(),
    });

    // WhatsApp + Chrome extension ingest are tenant-scoped via the JWT middleware above.

    // Render / load balancers: use Health Check Path = /health or /api/health
    this._app.get('/health', (_req, res) => res.status(200).type('text/plain').send('ok'));
    this._app.get('/api/health', (_req, res) => res.status(200).json({ ok: true }));

    this._app.get('/api/desktop/info', (_req, res) => {
      res.json({
        desktop: config.isDesktopApp,
        platform: process.platform,
        arch: process.arch,
        dataDir: config.isDesktopApp ? config.dataDir : undefined,
      });
    });

    this._app.use(express.static(config.publicDir));

    // ── Status ────────────────────────────────────────────────────────
    this._app.get('/api/app-config', (_req, res) => {
      res.json({
        importFirstMvp: config.importFirstMvp,
        waLiveSyncAutoConnect: config.waLiveSyncAutoConnect && !config.importFirstMvp,
        desktop: config.isDesktopApp,
      });
    });

    this._app.get('/api/status', (_req, res) => {
      const st = this._getTenantState(getCurrentTenantId());
      res.json({
        connected: st.extensionConnected,
        syncStatus: { ...st.syncStats },
        stats: this.db.getTotalStats(),
      });
    });

    // ── Session transfer (WhatsApp Web–style “link this device”) ──────
    this._app.post('/api/session/transfer/start', async (_req, res) => {
      try {
        const token = randomBytes(18).toString('hex'); // short-ish but unguessable
        const tenantId = getCurrentTenantId();
        const now = Math.floor(Date.now() / 1000);
        const expires = now + 5 * 60;
        const sql = this.db.getSqliteDatabase();
        // best-effort cleanup
        sql.prepare('DELETE FROM session_transfers WHERE expires_at < ?').run(now);
        sql.prepare('INSERT INTO session_transfers (token, tenant_id, created_at, expires_at) VALUES (?,?,?,?)')
          .run(token, tenantId, now, expires);
        const payload = JSON.stringify({ t: token });
        const qr = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 280 });
        return res.json({ ok: true, token, expiresAt: expires, qr });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    });

    this._app.post('/api/session/transfer/claim', (req, res) => {
      if (!isJwtAuthEnabled()) return res.status(503).json({ error: 'Server sessions are not enabled.' });
      const raw = req.body?.token || req.body?.t || '';
      let token = '';
      try {
        const parsed = typeof raw === 'string' ? raw : JSON.stringify(raw);
        if (parsed && parsed.trim().startsWith('{')) {
          const j = JSON.parse(parsed);
          token = String(j?.t || '').trim();
        } else {
          token = String(raw || '').trim();
        }
      } catch {
        token = String(raw || '').trim();
      }
      if (!token) return res.status(400).json({ error: 'token required' });

      const sql = this.db.getSqliteDatabase();
      const now = Math.floor(Date.now() / 1000);
      const row = sql.prepare('SELECT token, tenant_id, expires_at FROM session_transfers WHERE token = ?').get(token);
      if (!row) return res.status(404).json({ error: 'Invalid or expired code' });
      if (row.expires_at < now) {
        sql.prepare('DELETE FROM session_transfers WHERE token = ?').run(token);
        return res.status(404).json({ error: 'Invalid or expired code' });
      }
      // Consume token and mint a new session id for same tenant.
      sql.prepare('DELETE FROM session_transfers WHERE token = ?').run(token);
      const sid = this._userSessions.create(row.tenant_id);
      setSessionCookie(res, sid, { secure: this._isSecureCookieDeployment() });
      return res.json({ ok: true, sessionId: sid, tenantId: row.tenant_id });
    });

    // ── Chat & Message APIs ───────────────────────────────────────────
    this._app.get('/api/chats', async (_req, res) => {
      try {
        const tid = getCurrentTenantId();
        if (!this._repairedFutureTs) {
          this._repairedFutureTs = true;
          const repaired = this.db.repairFutureMessageTimestamps();
          if (repaired > 0) {
            console.log(`[DB] Repaired ${repaired} future-dated import message(s)`);
          }
        }
        let stats = this.db.getChatStats();
        try {
          const st = this._getTenantState(tid);
          const wa = st?.waClient;
          const skipHeavyOverlay = this.isTenantWaHistoryBusy(tid);
          if (!skipHeavyOverlay && wa && typeof wa.overlayResolvedChatNames === 'function') {
            stats = await wa.overlayResolvedChatNames(stats);
          }
          if (!skipHeavyOverlay && wa && typeof wa.mergeLinkedPersonalChatStats === 'function') {
            stats = await wa.mergeLinkedPersonalChatStats(stats);
          }
        } catch (_) {
          /* keep DB-only titles */
        }
        res.json(stats);
      } catch (err) {
        console.error('[/api/chats]', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/chats/:chatJid/action-items', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid);
        res.json(this.db.getChatActionItemsWithContext(chatJid));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/messages', async (req, res) => {
      const chatJid = req.query.chatJid;
      if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 80, MAX_MESSAGES_PAGE);
      const offset = parseInt(req.query.offset, 10) || 0;
      const focusMessageId = typeof req.query.focusMessageId === 'string' ? req.query.focusMessageId.trim() : '';
      let jids = [chatJid];
      try {
        const st = this._getTenantState(getCurrentTenantId());
        const wa = st?.waClient;
        if (wa && typeof wa.getLinked1on1Jids === 'function') {
          jids = await wa.getLinked1on1Jids(chatJid);
        }
      } catch (_) {
        /* single jid */
      }
      const unique = [...new Set(jids)].filter(Boolean);
      try {
        if (focusMessageId) {
          if (unique.length <= 1) {
            return res.json(sanitizeMessageList(this.db.getMessagesAroundMessageId(chatJid, focusMessageId, limit)));
          }
          return res.json(sanitizeMessageList(this.db.getMessagesAroundMessageIdForJids(unique, focusMessageId, limit)));
        }
        if (unique.length <= 1) {
          return res.json(sanitizeMessageList(this.db.getMessagesPaginated(chatJid, limit, offset)));
        }
        return res.json(sanitizeMessageList(this.db.getMessagesPaginatedForJids(unique, limit, offset)));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/wa/status-feed', (_req, res) => {
      try {
        return res.json(this.db.getStatusBroadcastFeed(80));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/message-media', (req, res) => {
      try {
        const messageId = String(req.query.messageId || '').trim();
        if (!messageId) return res.status(400).json({ error: 'messageId is required' });
        const row = this.db.getMessageMediaRecord(messageId);
        const rawPath = row?.mediaPath ? String(row.mediaPath).trim() : '';
        if (!rawPath) return res.status(404).json({ error: 'No media for this message' });
        const safe = assertPathUnderMediaRoot(rawPath);
        if (!safe) return res.status(403).json({ error: 'Invalid media path' });
        const q = req.query || {};
        const wantDownload =
          q.download === '1' ||
          q.download === 'true' ||
          String(q.disposition || '').toLowerCase() === 'attachment';
        res.setHeader('Content-Type', contentTypeForMediaFile(safe));
        res.setHeader('Cache-Control', 'private, max-age=3600');
        if (wantDownload) {
          const fname = attachmentFilenameFromPath(safe, messageId);
          res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
        }
        return res.sendFile(safe);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    // ── While you were away (per chat) ───────────────────────────────
    this._app.post('/api/chats/:chatJid/seen', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid || '');
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const ts = req.body?.ts != null ? Number(req.body.ts) : null;
        const lastSeenTs = this.db.markChatSeen(chatJid, ts);
        return res.json({ ok: true, lastSeenTs });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    /** Queue AI thread-summary indexing for this chat before others (same tenant). Prefer POST body — see /api/summaries/priority-chat. */
    this._app.post('/api/chats/:chatJid/priority-index', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid || '');
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const tid = getCurrentTenantId();
        this.summaryService.setPriorityChatForTenant(tid, chatJid);
        this._mediaIndexService?.notePriorityChange?.();
        void runWithTenant(tid, async () => {
          try {
            await this.summaryService.indexPendingDays();
          } catch (err) {
            console.error('[priority-index]', err.message);
          }
        });
        return res.json({ ok: true, priorityChatJid: chatJid });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/chats/:chatJid/away-summary', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid || '');
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const limit = Math.min(parseInt(req.query.limit, 10) || 3, 10);
        return res.json(this.db.getAwayThreadSummaries(chatJid, limit));
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    /** Media, documents, and extracted URLs for the chat attachments panel. */
    this._app.get('/api/chats/:chatJid/attachments', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid || '');
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const rowLimit = Math.min(parseInt(req.query.limit, 10) || 1200, 5000);
        const data = this.db.getChatAttachmentsGrouped(chatJid, rowLimit);
        return res.json(data);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.delete('/api/chats/:chatJid', (req, res) => {
      try {
        const chatJid = decodeURIComponent(req.params.chatJid);
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const deleted = this.db.deleteChat(chatJid);
        const tid = getCurrentTenantId();
        const st = this._getTenantState(tid);
        this._broadcast(
          { type: 'status', data: { connected: st.extensionConnected, stats: this.db.getTotalStats() } },
          tid,
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
        const { query, chatJid, mediaType, businessContext } = req.body;
        if (!query || typeof query !== 'string') {
          return res.status(400).json({ error: 'query is required' });
        }

        const result = await this.searchEngine.search(
          query,
          chatJid || null,
          mediaType || null,
          { businessContext: !!businessContext },
        );
        return res.json(result);
      } catch (err) {
        console.error('Search API error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    /** BM25 prototype UI: LLM rerank for in-browser uploaded chats (uses configured search provider). */
    this._app.post('/api/wa-search/rerank', async (req, res) => {
      try {
        const { query, candidates } = req.body;
        if (!query || typeof query !== 'string') {
          return res.status(400).json({ error: 'query is required' });
        }
        if (!Array.isArray(candidates) || !candidates.length) {
          return res.status(400).json({ error: 'candidates array is required' });
        }

        const providerName = this.db.getSetting('llm_provider') || config.defaultSearchProvider;
        const model = this.db.getSetting('llm_model') || config.defaultSearchModel;
        const apiKey = effectiveSearchApiKey(this.db);
        const provider = await createProvider(providerName, apiKey, model || undefined);

        const numbered = candidates
          .map((c, i) => `[${i}] ${c.sender}: ${c.text}`)
          .join('\n');
        const system = `You are a semantic search reranker for WhatsApp chat messages.
Given a user query and candidate messages, score each by true semantic relevance.
Return ONLY a raw JSON array, no markdown, no explanation.`;
        const user = `Query: "${query}"

Candidates:
${numbered}

Return JSON array for ALL ${candidates.length} candidates:
[{"index": 0, "score": 0.0-1.0, "reason": "one short phrase"}, ...]

Score 1.0 = directly answers the query. Score 0.0 = completely unrelated.`;

        const raw = await provider.chat([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ], { maxTokens: 1500 });

        const cleaned = String(raw || '[]').replace(/```json|```/g, '').trim();
        let scores;
        try {
          scores = JSON.parse(cleaned);
        } catch {
          return res.status(502).json({ error: 'LLM returned invalid JSON', raw: cleaned.slice(0, 500) });
        }
        return res.json({ scores, raw: cleaned });
      } catch (err) {
        console.error('[/api/wa-search/rerank]', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    // ── Contact directory sync (mobile app) ───────────────────────────
    this._app.post('/api/contacts/sync', (req, res) => {
      try {
        const contacts = req.body?.contacts;
        if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array required' });
        const out = this.db.syncContactDirectory(contacts);
        return res.json({ ok: true, ...out });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    // ── WhatsApp Linked-Device Endpoints ─────────────────────────────
    this._app.get('/api/wa/status', (_req, res) => {
      const st = this._getTenantState(getCurrentTenantId());
      res.json({
        state: st.waState,
        message: st.waMessage,
        hasQr: !!st.waQrDataUrl,
      });
    });

    this._app.get('/api/wa/qr', (_req, res) => {
      const st = this._getTenantState(getCurrentTenantId());
      const wa = st.waClient;
      // Always serve the freshest QR — from the live client if available
      const liveQr = wa?.latestQr;
      const qr = liveQr || st.waQrDataUrl;
      if (!qr) return res.status(404).json({ error: 'No QR available' });
      // Update cache too
      if (liveQr) st.waQrDataUrl = liveQr;
      res.json({ qr });
    });

    this._app.get('/api/wa/chat-details', async (req, res) => {
      const chatJid = req.query.chatJid;
      if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
      try {
        const stats = this.db.getQuickChatInfo(chatJid);
        const local = {
          chatJid,
          chatName: stats?.chatName ?? null,
          messageCount: stats?.messageCount ?? 0,
          participantCountFromDb: stats?.participantCount ?? 0,
          lastMessageTs: stats?.lastMessageTs ?? null,
          isGroup: chatJid.includes('@g.us'),
        };
        const st = this._getTenantState(getCurrentTenantId());
        const wa = st.waClient && typeof st.waClient.getChatDetails === 'function'
          ? await st.waClient.getChatDetails(chatJid)
          : null;
        return res.json({ ...local, ...(wa || {}) });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/wa/connect', async (_req, res) => {
      const tid = getCurrentTenantId();
      const st = this._getTenantState(tid);
      if (st.waClient?._destroyed) {
        st.waClient = null;
      }
      const wa = this._ensureTenantWaClient(tid);
      if (st.waState === 'READY') return res.json({ ok: true, state: 'READY' });
      try {
        // start() is idempotent — safe to call again if disconnected
        wa.start().catch(err => console.error('[WA] Start error:', err.message));
        res.json({ ok: true, state: st.waState });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/wa/logout', async (_req, res) => {
      const tid = getCurrentTenantId();
      const st = this._getTenantState(tid);
      if (!st.waClient) return res.status(409).json({ error: 'WhatsApp not connected' });
      try {
        await st.waClient.logout();
        st.waClient = null;
        st.waQrDataUrl = null;
        st.waState = 'DISCONNECTED';
        st.waMessage = 'Logged out — rescan QR to reconnect';
        st.extensionConnected = false;
        this._broadcast({ type: 'wa-status', data: { state: st.waState, message: st.waMessage, stats: this.db.getTotalStats() } }, tid);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /** Re-fetch WhatsApp app state (contact / phone book names) and update indexed chat titles. */
    this._app.post('/api/wa/sync-contacts', async (_req, res) => {
      const tid = getCurrentTenantId();
      const st = this._getTenantState(tid);
      if (!st.waClient) return res.status(409).json({ error: 'WhatsApp not connected' });
      if (st.waState !== 'READY') return res.status(409).json({ error: 'WhatsApp not ready' });
      if (typeof st.waClient.refreshPhoneBookNamesInDb !== 'function') {
        return res.status(503).json({ error: 'Contact sync not available' });
      }
      try {
        const rowsUpdated = await st.waClient.refreshPhoneBookNamesInDb(this.db);
        this._broadcast({ type: 'chat-names-refreshed', data: { stats: this.db.getTotalStats(), rowsUpdated } }, tid);
        res.json({ ok: true, rowsUpdated });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    /**
     * Ask the paired phone for older messages before our oldest stored row (Baileys PDO on-demand sync).
     * Initial linked-device sync is still limited by WhatsApp; this may need repeating or full exports for years of history.
     */
    this._app.post('/api/wa/fetch-older-history', async (req, res) => {
      const tid = getCurrentTenantId();
      const st = this._getTenantState(tid);
      const wa = st?.waClient;
      if (!wa || typeof wa.fetchOlderHistoryFromPhone !== 'function') {
        return res.status(409).json({ error: 'WhatsApp not connected' });
      }
      if (st.waState !== 'READY') return res.status(409).json({ error: 'WhatsApp not ready' });
      const chatJid = String(req.body?.chatJid || '').trim();
      if (!chatJid) return res.status(400).json({ error: 'chatJid required' });
      const count = Math.min(100, Math.max(1, parseInt(req.body?.count, 10) || 50));
      try {
        const anchorRow = this.db.getOldestMessageAnchor(chatJid);
        if (!anchorRow?.messageId) {
          return res.status(400).json({ error: 'No messages indexed for this chat yet' });
        }
        const requestId = await wa.fetchOlderHistoryFromPhone({ chatJid, ...anchorRow }, count);
        res.json({ ok: true, requestId: requestId ?? null });
      } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    this._app.post('/api/wa/send', async (req, res) => {
      const tid = getCurrentTenantId();
      const st = this._getTenantState(tid);
      if (!st.waClient) return res.status(409).json({ error: 'WhatsApp not connected' });
      if (st.waState !== 'READY') return res.status(409).json({ error: 'WhatsApp not ready' });
      const chatJid = req.body?.chatJid ? String(req.body.chatJid) : '';
      const text = req.body?.text ? String(req.body.text) : '';
      const quotedMessageId = typeof req.body?.quotedMessageId === 'string' ? req.body.quotedMessageId.trim() : '';
      if (!chatJid || !text.trim()) return res.status(400).json({ error: 'chatJid and text required' });
      try {
        let quotedRow = null;
        if (quotedMessageId) {
          quotedRow = this.db.getMessageForActions(chatJid, quotedMessageId);
          if (!quotedRow) {
            return res.status(404).json({ error: 'Quoted message not found in this chat' });
          }
        }
        const sent = await st.waClient.sendText(chatJid, text, { quotedRow });
        return res.json({ ok: true, messageId: sent?.key?.id || null });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/wa/react', async (req, res) => {
      const tid = getCurrentTenantId();
      const st = this._getTenantState(tid);
      if (!st.waClient) return res.status(409).json({ error: 'WhatsApp not connected' });
      if (st.waState !== 'READY') return res.status(409).json({ error: 'WhatsApp not ready' });
      const chatJid = req.body?.chatJid ? String(req.body.chatJid) : '';
      const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : '';
      const emoji = req.body?.emoji != null ? String(req.body.emoji) : '';
      if (!chatJid || !messageId) return res.status(400).json({ error: 'chatJid and messageId required' });
      try {
        const row = this.db.getMessageForActions(chatJid, messageId);
        if (!row) return res.status(404).json({ error: 'Message not found' });
        if (typeof st.waClient.sendEmojiReaction !== 'function') {
          return res.status(503).json({ error: 'Reactions not available' });
        }
        await st.waClient.sendEmojiReaction(chatJid, row, emoji);
        return res.json({ ok: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    // ── Extension Sync Endpoints ──────────────────────────────────────
    this._app.post('/api/extension/chats', (req, res) => {
      const tid = getCurrentTenantId();
      const st = this._getTenantState(tid);
      st.extensionConnected = true;
      this._broadcast({ type: 'status', data: { connected: true, stats: this.db.getTotalStats() } }, tid);
      res.json({ ok: true });
    });

    this._app.post('/api/extension/messages', (req, res) => {
      try {
        const tid = getCurrentTenantId();
        const st = this._getTenantState(tid);
        if (!st.extensionConnected) {
          st.extensionConnected = true;
          this._broadcast({ type: 'status', data: { connected: true, stats: this.db.getTotalStats() } }, tid);
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
            {
              type: 'new-messages',
              data: {
                count: inserted,
                stats: this.db.getTotalStats(),
                chatTouches: summarizeChatTouchesFromRows(rows),
              },
            },
            getCurrentTenantId(),
          );
          this._actionItemService?.enqueueByMessageIds(insertedMessageIds);
        }

        return res.json({ inserted, total: rows.length });
      } catch (err) {
        console.error('Extension sync error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    // ── SMB / business profiles ───────────────────────────────────────
    this._app.get('/api/smb/profiles', (_req, res) => {
      res.json({ profiles: listSmbProfileOptions() });
    });

    this._app.get('/api/smb/profile', (_req, res) => {
      const profile = getSmbProfileFromDb(this.db);
      const mismatch = detectSmbLibraryMismatch(this.db);
      res.json({
        profile: profile.id,
        businessName: (this.db.getSetting(SMB_BUSINESS_NAME_SETTING) || '').trim(),
        prompts: getSearchPrompts(profile),
        dataMismatch: mismatch.mismatch,
        mismatchReason: mismatch.reason || '',
      });
    });

    this._app.post('/api/smb/profile', (req, res) => {
      try {
        const { profile, businessName } = req.body || {};
        if (profile != null) {
          const resolved = resolveSmbProfile(profile);
          this.db.setSetting(SMB_PROFILE_SETTING, resolved.id);
        }
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'businessName')) {
          this.db.setSetting(SMB_BUSINESS_NAME_SETTING, String(businessName || '').trim());
        }
        const current = getSmbProfileFromDb(this.db);
        const mismatch = detectSmbLibraryMismatch(this.db);
        return res.json({
          ok: true,
          profile: current.id,
          businessName: (this.db.getSetting(SMB_BUSINESS_NAME_SETTING) || '').trim(),
          prompts: getSearchPrompts(current),
          dataMismatch: mismatch.mismatch,
          mismatchReason: mismatch.reason || '',
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/smb/inbox', (_req, res) => {
      try {
        res.json(this._smbInbox.getDashboard());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/api/smb/prompts', (_req, res) => {
      const profile = getSmbProfileFromDb(this.db);
      res.json({ profile: profile.id, prompts: getSearchPrompts(profile) });
    });

    this._app.get('/api/smb/appointments', (_req, res) => {
      try {
        res.json(this._appointmentBoard.getBoard());
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── WhatsApp Business API (Cloud API) ─────────────────────────────
    this._app.get('/api/waba/config', (req, res) => {
      res.json({
        ...publicWabaConfig(this.db),
        webhookUrl: `${this._publicBaseUrl(req)}/api/waba/webhook`,
      });
    });

    this._app.post('/api/waba/config', (req, res) => {
      try {
        saveWabaConfig(this.db, req.body || {});
        res.json({
          ok: true,
          ...publicWabaConfig(this.db),
          webhookUrl: `${this._publicBaseUrl(req)}/api/waba/webhook`,
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/waba/test', async (_req, res) => {
      try {
        const cfg = getWabaConfig(this.db);
        if (!cfg.phoneNumberId || !cfg.accessToken) {
          return res.status(400).json({ error: 'Phone Number ID and Access Token required' });
        }
        const GRAPH_VERSION = (process.env.WABA_GRAPH_API_VERSION || 'v21.0').trim();
        const r = await fetch(
          `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}`,
          { headers: { Authorization: `Bearer ${cfg.accessToken}` } },
        );
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          return res.status(502).json({
            ok: false,
            error: data.error?.message || `Graph API ${r.status}`,
          });
        }
        return res.json({ ok: true, display: data.display_phone_number || data.verified_name || 'connected' });
      } catch (err) {
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

        let p = provider || this.db.getSetting('llm_provider') || config.defaultSearchProvider;
        let m = model || this.db.getSetting('llm_model') || config.defaultSearchModel;
        let memoryWarning = null;

        if (p === 'ollama' && m) {
          const safe = resolveSafeOllamaModel(m);
          memoryWarning = safe.warning;
          applyOllamaMemorySettings(this.db, safe);
          if (safe.warning) {
            console.warn(`[Ollama] ${safe.warning}`);
          }
        }

        if (model || p === 'ollama') this.db.setSetting('llm_model', m);
        clearProviderCache();

        const k = effectiveSearchApiKey(this.db);

        const instance = await createProvider(p, k, m || undefined);
        if (typeof instance.resetHealthCache === 'function') instance.resetHealthCache();
        const healthy = await instance.checkHealth();
        const pulling = !healthy && instance.pullStatus?.status === 'downloading';

        this.searchEngine.setProvider(instance);
        await this._reloadMediaIndexProvider?.();

        this.summaryService.setFallbackProvider(instance);
        const sumP = this.db.getSetting('summary_provider');
        if (!sumP || sumP === 'same') {
          this.summaryService.setProvider(instance);
          if (healthy) { this._triggerSummaryGen(); }
        }

        return res.json({
          ok: true,
          healthy,
          pulling,
          provider: p,
          model: instance.model,
          memoryWarning,
          exceedsBudget: memoryWarning != null,
        });
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
        if (typeof instance.resetHealthCache === 'function') instance.resetHealthCache();
        const healthy = await instance.checkHealth();
        const pulling = !healthy && instance.pullStatus?.status === 'downloading';

        this.summaryService.setProvider(instance);

        if (healthy) { this._triggerSummaryGen(); }

        return res.json({ ok: true, healthy, pulling, provider: sp, model: instance.model });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.post('/api/settings/media-index', async (req, res) => {
      try {
        const { provider, apiKey, model } = req.body;

        if (provider === 'same') {
          this.db.setSetting('media_index_provider', 'same');
          this.db.setSetting('media_index_api_key', '');
          this.db.setSetting('media_index_model', '');
          clearProviderCache();
          const meta = await this._reloadMediaIndexProvider?.();
          return res.json({
            ok: true,
            healthy: meta?.healthy ?? false,
            provider: 'same',
            model: meta?.model || '',
          });
        }

        if (provider) this.db.setSetting('media_index_provider', provider);
        if (Object.prototype.hasOwnProperty.call(req.body, 'apiKey')) {
          this.db.setSetting('media_index_api_key', apiKey ?? '');
        }
        if (model) this.db.setSetting('media_index_model', model);

        clearProviderCache();

        const meta = await this._reloadMediaIndexProvider?.();
        return res.json({
          ok: true,
          healthy: meta?.healthy ?? false,
          provider: meta?.provider ?? provider ?? config.defaultMediaIndexProvider,
          model: meta?.model || '',
        });
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
      const sp = this.summaryService?._provider;
      if (sp?.pullStatus) return res.json(sp.pullStatus);
      return res.json(null);
    });

    // ── Ollama Hardware Recommendation ─────────────────────────────────
    this._app.get('/api/ollama/recommend', async (_req, res) => {
      try {
        if (!canSpawnLocalOllama()) {
          return res.json({
            supported: false,
            reason: localOllamaUnsupportedReason(),
          });
        }
        const provider = this.searchEngine?._provider;
        const rec = await getHardwareRecommendation(provider);
        return res.json({ supported: true, ...rec });
      } catch (err) {
        console.error('[Recommend] Error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    // ── Ollama: apply recommended model + trigger background download ──
    this._app.post('/api/ollama/apply-recommendation', async (req, res) => {
      try {
        if (!canSpawnLocalOllama()) {
          return res.status(400).json({ error: localOllamaUnsupportedReason() });
        }
        const { model } = req.body;
        const safe = resolveSafeOllamaModel(model || undefined);
        if (safe.warning) {
          console.warn(`[Ollama] ${safe.warning}`);
        }

        this.db.setSetting('llm_provider', 'ollama');
        this.db.setSetting('llm_model', safe.model);
        applyOllamaMemorySettings(this.db, safe);
        clearProviderCache();

        const instance = await createProvider('ollama', '', safe.model);
        if (typeof instance.resetHealthCache === 'function') instance.resetHealthCache();

        // Fire health check — this starts Ollama + triggers background pull if needed.
        const healthPromise = instance.checkHealth();

        this.searchEngine.setProvider(instance);
        await this._reloadMediaIndexProvider?.();
        this.summaryService.setFallbackProvider(instance);
        const sumP = this.db.getSetting('summary_provider');
        if (!sumP || sumP === 'same') {
          this.summaryService.setProvider(instance);
        }

        const healthy = await healthPromise;
        const pulling = !healthy && instance.pullStatus?.status === 'downloading';

        if (healthy) this._triggerSummaryGen();

        return res.json({
          ok: true,
          healthy,
          pulling,
          model: instance.model,
          numCtx: safe.numCtx,
          budgetRam: safe.budgetGb,
          exceedsBudget: safe.exceedsBudget,
          suggestedModel: safe.suggestedModel,
          warning: safe.warning,
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
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
        // Better UX: use whichever Google account the user is already signed into, with explicit consent.
        prompt: 'select_account consent',
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
        const tid = getCurrentTenantId();
        const st = this._getTenantState(tid);
        const totalInserted = (out.results || []).reduce((n, r) => n + (Number(r.inserted) || 0), 0);
        this._broadcast(
          { type: 'status', data: { connected: st.extensionConnected, stats: this.db.getTotalStats() } },
          tid,
        );
        if (totalInserted > 0) {
          this._broadcast(
            { type: 'new-messages', data: { count: totalInserted, stats: this.db.getTotalStats() } },
            tid,
          );
        }
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

    /** Index this chat before others for AI thread summaries (JSON body avoids JID-in-URL / router edge cases). */
    this._app.post('/api/summaries/priority-chat', (req, res) => {
      try {
        const chatJid = String(req.body?.chatJid ?? '').trim();
        if (!chatJid) return res.status(400).json({ error: 'chatJid is required' });
        const tid = getCurrentTenantId();
        this.summaryService.setPriorityChatForTenant(tid, chatJid);
        this._mediaIndexService?.notePriorityChange?.();
        void runWithTenant(tid, async () => {
          try {
            await this.summaryService.indexPendingDays();
          } catch (err) {
            console.error('[summaries/priority-chat]', err.message);
          }
        });
        return res.json({ ok: true, priorityChatJid: chatJid });
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
        const st = this._getTenantState(tid);
        this.summaryService.indexPendingDays().then((count) => {
          console.log(`[Summaries] Regenerated ${count} thread summaries`);
          runWithTenant(tid, () => {
            this._broadcast(
              { type: 'status', data: { connected: st.extensionConnected, stats: this.db.getTotalStats() } },
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
          let mediaMap;
          const chatName = fileName.replace(/\.(zip|txt)$/i, '').replace(/^WhatsApp Chat with /i, '');

          if (isZip) {
            textContent = extractTextFromZip(file.buffer);
            if (!textContent) { results.push({ chatName, error: 'No chat .txt found in zip' }); continue; }
            const slug = slugForImportChatJid(chatName);
            const chatJid = `import_${slug}@imported`;
            mediaMap = extractMediaFromZip(file.buffer, chatJid);
          } else {
            textContent = decodeExportBuffer(file.buffer);
          }

          const result = importExportedChat(this.db, textContent, chatName, mediaMap);
          results.push({ chatName, ...result });
        }

        const tid = getCurrentTenantId();
        const st = this._getTenantState(tid);
        const totalInserted = results.reduce((n, r) => n + (Number(r.inserted) || 0), 0);
        const totalParsed = results.reduce((n, r) => n + (Number(r.parsedCount ?? r.total) || 0), 0);
        const stats = this.db.getTotalStats();
        this._broadcast(
          { type: 'status', data: { connected: st.extensionConnected, stats } },
          tid,
        );
        const parsedResults = results.filter(
          (r) => !r.error && (Number(r.parsedCount ?? r.total) || 0) > 0 && r.chatJid,
        );
        if (parsedResults.length > 0) {
          const chatTouches = parsedResults.map((r) => ({
            chatJid: r.chatJid,
            lastMessageTs: Number(r.lastMessageTs) || Math.floor(Date.now() / 1000),
            count: Number(r.inserted) || 0,
          }));
          this._broadcast(
            {
              type: 'new-messages',
              data: { count: totalInserted, stats, chatTouches },
            },
            tid,
          );
          this._mediaIndexService?.scheduleProcess?.();
        }

        this.summaryService.indexPendingDays().then((count) => {
          if (count > 0) console.log(`Post-import: generated ${count} daily summaries`);
        }).catch((err) => console.error('Post-import summary error:', err.message));

        const primary = results.find((r) => r.chatJid && !r.error) || results[0];
        if (results.length === 1) {
          return res.json({ ...results[0], pinnedChatJid: primary?.chatJid || results[0].chatJid });
        }
        return res.json({
          results,
          totalFiles: results.length,
          pinnedChatJid: primary?.chatJid || null,
        });
      } catch (err) {
        console.error('Import API error:', err.message);
        return res.status(500).json({ error: err.message });
      }
    });

    this._app.get('/', (_req, res) => res.sendFile(resolve(config.publicDir, 'index.html')));
  }

  _triggerSummaryGen() {
    const tid = getCurrentTenantId();
    const st = this._getTenantState(tid);
    this.summaryService.indexPendingDays().then((count) => {
      if (count > 0) {
        console.log(`[Settings] Generated ${count} summaries`);
        runWithTenant(tid, () => {
          this._broadcast(
            { type: 'status', data: { connected: st.extensionConnected, stats: this.db.getTotalStats() } },
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
   * @param {string} tenantId
   */
  _broadcast(msg, tenantId) {
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

  /** Gracefully tear down all Baileys clients (e.g. SIGINT). */
  async destroyAllWhatsAppClients() {
    const tasks = [];
    for (const st of this._tenantState.values()) {
      if (st.waClient && typeof st.waClient.destroy === 'function') {
        tasks.push(st.waClient.destroy().catch(() => {}));
      }
    }
    await Promise.all(tasks);
  }
}
