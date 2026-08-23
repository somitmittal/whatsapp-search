/**
 * wa-client.js — WhatsApp integration via @whiskeysockets/baileys
 *
 * Baileys implements the WhatsApp multi-device WS protocol directly.
 * No Puppeteer / headless browser → no bot-detection / "Can't link" errors.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import config from '../config.js';
import {
    fallbackTitleForOneOnOneJid,
    formatPhoneLocalPart,
    isPlausibleHumanChatTitle,
    looksLikeLidFallbackContactLabel,
    looksLikeOpaqueNumericId,
    looksLikePhoneDigitsOnly,
    looksLikeUrlOrSocialJunk,
    pickBetterChatTitle,
    sanitizePeerSenderName,
} from './chat-display-name.js';
import { buildContactPayloadFromInner } from './contact-card.js';
import { aggregateReactionCountsFromProtoList } from './reaction-counts.js';
import { normalizeUnixSeconds } from '../utils/timestamp.js';

const require = createRequire(import.meta.url);
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isJidGroup,
  isLidUser,
  isPnUser,
  ALL_WA_PATCH_NAMES,
  downloadMediaMessage,
  extractMessageContent,
  getContentType,
} = require('@whiskeysockets/baileys');
const QRCode   = require('qrcode');
const P        = require('pino');

const BATCH_MS = 2000;

const MEDIA_FOR_INDEX = new Set(['image', 'audio', 'video', 'sticker', 'document']);
const MAX_VIDEO_BYTES = 12 * 1024 * 1024;

function safeJidDir(jid) {
  return String(jid || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('pdf')) return 'pdf';
  return 'bin';
}

// ── tiny helpers ─────────────────────────────────────────────────────────────
function loadCfg(configFile) {
  try { if (configFile && existsSync(configFile)) return JSON.parse(readFileSync(configFile, 'utf8')); } catch {}
  return {};
}
function saveCfg(configFile, d) {
  try { if (configFile) writeFileSync(configFile, JSON.stringify(d, null, 2)); } catch {}
}

function summarizeContactsArrayMessage(cam) {
  if (!cam || typeof cam !== 'object') return '';
  const title = cam.displayName != null ? String(cam.displayName).trim() : '';
  const n = Array.isArray(cam.contacts) ? cam.contacts.length : 0;
  if (title && n) return `${title} (${n} contacts)`;
  if (title) return title;
  if (n) return `${n} contact${n !== 1 ? 's' : ''}`;
  return '';
}

/** Plain text from an inner proto message (after unwrap of ephemeral / view-once). */
function extractTextFromInner(m) {
  if (!m) return '';
  let t = (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.liveLocationMessage?.caption ||
    m.locationMessage?.name ||
    m.contactMessage?.displayName ||
    summarizeContactsArrayMessage(m.contactsArrayMessage) ||
    m.pollCreationMessage?.name ||
    m.buttonsMessage?.contentText ||
    m.listMessage?.description ||
    m.templateMessage?.hydratedTemplate?.hydratedContentText ||
    m.viewOnceMessage?.message?.imageMessage?.caption ||
    ''
  ) || '';
  const docFn = m.documentMessage?.fileName ? String(m.documentMessage.fileName).trim() : '';
  if (docFn && !t.includes(docFn)) t = t ? `${t} ${docFn}` : docFn;
  return t;
}

function extractText(msg) {
  if (!msg?.message) return '';
  const inner = extractMessageContent(msg.message) || msg.message;
  return extractTextFromInner(inner);
}

function placeholderForUntracked(inner) {
  const ct = getContentType(inner);
  if (!ct) return '[message]';
  const short = ct.replace(/Message$/, '').replace(/([A-Z])/g, ' $1').trim();
  return `[${short || ct}]`;
}

function normalizeNameForCompare(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isProbablyOwnName(pushName, ownerName) {
  const a = normalizeNameForCompare(pushName);
  const b = normalizeNameForCompare(ownerName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a === 'you') return true;
  if (a.startsWith('you ')) return true;
  return false;
}

/** Public web UI URL (Render / override) or local dev. */
function publicWebBaseUrl() {
  const u = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_WEB_URL;
  if (u) return String(u).replace(/\/$/, '');
  return `http://localhost:${config.webPort}`;
}

/** When the stored title is the LID placeholder "Contact (…)" but the row is keyed by phone JID, show +CC …. */
function replaceLidPlaceholderWithPn(canonJid, chatName) {
  if (
    looksLikeLidFallbackContactLabel(chatName)
    && (canonJid.endsWith('@s.whatsapp.net') || canonJid.endsWith('@hosted'))
  ) {
    return formatPhoneLocalPart(canonJid.split('@')[0]);
  }
  return chatName;
}

// ─────────────────────────────────────────────────────────────────────────────
export default class WaClient {
  constructor({ authDir, configFile, onQr, onReady, onMessages, onChatsPreview, onHistorySyncComplete, onStatus, onProgress, onSearchQuery, onDisconnected, onMediaPath, onReaction }) {
    this._authDir = authDir || join(config.dataDir, '.baileys_auth');
    this._configFile = configFile || join(config.dataDir, 'wa-config.json');
    this._onQr          = onQr;
    this._onReady       = onReady;
    this._onMessages    = onMessages;
    this._onChatsPreview = onChatsPreview;
    this._onHistorySyncComplete = onHistorySyncComplete;
    this._onStatus      = onStatus;
    this._onProgress    = onProgress;
    this._onSearchQuery = onSearchQuery;
    this._onDisconnected = onDisconnected;
    this._onMediaPath   = onMediaPath;
    this._onReaction    = onReaction;

    this._sock          = null;
    this._state         = 'DISCONNECTED';
    this._latestQr      = null;
    this._ownerJid      = null;
    this._ownerName     = null;
    this._chatNames     = new Map();   // jid → display name
    /** Messages received per chat during current history sync (for UI progress). */
    this._syncByChat    = new Map();
    this._totalMsgs     = 0;
    this._syncDoneTimer = null;
    this._historyDone   = false;
    this._destroyed     = false;
    this._pendingBatch  = [];
    this._flushTimer    = null;
    this._mediaQueue    = [];
    this._mediaDraining = false;
    this._mediaLogger   = P({ level: 'silent' });
    /** Serialize connects — parallel _connect() calls used to create overlapping Baileys sockets → disconnect loop. */
    this._connectSeq = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._reconnectTimer = null;
    /** Increments on each non-logout close; reset when `connection === 'open'`. */
    this._reconnectAttempt = 0;
    /** Throttle `SYNCING` status lines so history batches don’t spam WebSocket/UI. */
    this._lastSyncingUiAt = 0;
    /** First time we have DB-visible history (or live traffic) while `SYNCING` → switch UI to `READY` immediately; history may continue in background. */
    this._uiPromotedAfterFirstHistoryBatch = false;
    /** Consecutive close events that usually indicate a stale/expired session rather than a transient blip. */
    this._staleSessionCloseCount = 0;
  }

  get state()    { return this._state; }
  get latestQr() { return this._latestQr; }
  /** True while Baileys may still send `messaging-history.set` batches (UI may already be READY). */
  get isInitialHistorySync() { return !this._historyDone; }

  async start() {
    if (this._sock || this._destroyed) return;
    mkdirSync(this._authDir, { recursive: true });
    await this._connect();
  }

  async logout() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try { await this._sock?.logout(); } catch {}
    this._sock = null;
    this._setState('DISCONNECTED', 'Logged out');
    this._onDisconnected?.();
  }

  async _resetAuthAndRequestQr(reason = 'Session expired — rescan QR to reconnect') {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._sock = null;
    this._latestQr = null;
    this._reconnectAttempt = 0;
    this._staleSessionCloseCount = 0;
    try { rmSync(this._authDir, { recursive: true, force: true }); } catch {}
    mkdirSync(this._authDir, { recursive: true });
    this._setState('DISCONNECTED', reason);
    this._onDisconnected?.();
    if (!this._destroyed) {
      setTimeout(() => { void this._connect(); }, 300);
    }
  }

  /** @param {{ quotedRow?: object }} [options] Optional quoted message row from DB for replies. */
  async sendText(chatJid, text, options = {}) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!chatJid) throw new Error('chatJid required');
    const t = String(text || '').trim();
    if (!t) throw new Error('text required');
    const { quotedRow } = options;
    if (quotedRow) {
      const quoted = this._buildQuotedProto(quotedRow, chatJid);
      return await this._sock.sendMessage(chatJid, { text: t }, { quoted });
    }
    return await this._sock.sendMessage(chatJid, { text: t });
  }

  /** React to a chat or status message (`statusJidList` set for `status@broadcast`). */
  async sendEmojiReaction(chatJid, row, emoji) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!row?.messageId) throw new Error('message row required');
    const key = this._buildReactionKey(row, chatJid);
    const e = String(emoji ?? '');
    const opts = {};
    if (chatJid === 'status@broadcast' && row.senderJid && this._ownerJid) {
      opts.statusJidList = [jidNormalizedUser(row.senderJid), this._ownerJid];
    }
    return await this._sock.sendMessage(
      chatJid,
      { react: { text: e, key } },
      opts,
    );
  }

  _buildReactionKey(row, chatJid) {
    const fromMe = row.sender === 'You';
    const key = {
      remoteJid: row.chatJid,
      id: row.messageId,
      fromMe,
    };
    if (isJidGroup(chatJid) && !fromMe && row.senderJid) {
      key.participant = jidNormalizedUser(row.senderJid);
    }
    if (chatJid === 'status@broadcast' && row.senderJid) {
      key.participant = jidNormalizedUser(row.senderJid);
      key.fromMe = false;
    }
    return key;
  }

  _buildQuotedProto(row, destChatJid) {
    const fromMe = row.sender === 'You';
    const key = {
      remoteJid: row.chatJid,
      id: row.messageId,
      fromMe,
    };
    if (isJidGroup(destChatJid) && !fromMe && row.senderJid) {
      key.participant = jidNormalizedUser(row.senderJid);
    }
    let snippet = String(row.text || row.mediaCaption || '').trim();
    if (!snippet) {
      snippet = row.mediaType ? `[${row.mediaType}]` : '\u200b';
    }
    return {
      key,
      message: { conversation: snippet.slice(0, 1024) },
    };
  }

  async destroy() {
    this._destroyed = true;
    clearTimeout(this._flushTimer);
    clearTimeout(this._syncDoneTimer);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._mediaQueue.length = 0;
    try { this._sock?.end?.(new Error('destroy')); } catch {}
    this._sock = null;
    this._setState('DISCONNECTED', 'Stopped');
  }

  // ── Core connection ────────────────────────────────────────────────────────
  /**
   * Single-flight connect: `/api/wa/connect`, reconnect timers, and pairing must not run `_buildSocket` in parallel.
   */
  async _connect() {
    if (this._destroyed) return;
    if (this._sock) return;

    const run = async () => {
      if (this._destroyed) return;
      if (this._sock) return;
      await this._buildSocket();
    };

    this._connectSeq = this._connectSeq.catch(() => {}).then(run);
    return this._connectSeq;
  }

  async _buildSocket() {
    if (this._destroyed) return;

    const { state: authState, saveCreds } = await useMultiFileAuthState(this._authDir);
    if (this._destroyed) return;
    if (this._sock) return;

    let version = [2, 3000, 1015901307];
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
    } catch {}
    console.log(`[WA] Baileys — WA version ${version.join('.')}`);
    this._setState('LOADING', 'Connecting to WhatsApp…');

    this._sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      auth: authState,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      // Linked-device history depth is still capped by WhatsApp servers (often ~few months of rolling sync).
      // See fetchOlderHistoryFromPhone + POST /api/wa/fetch-older-history and chat export import for more.
      syncFullHistory: config.waSyncFullHistory,
      /**
       * Linked-device label on your phone (Settings → Linked devices).
       * Do **not** use "Chrome" here — WhatsApp surfaces that in OS notifications as
       * "syncing with Google Chrome" even though this is the Node/Baileys client, not web.whatsapp.com.
       */
      browser: ['WhatsApp Search', 'Desktop', '1.0.0'],
    });

    this._sock.ev.on('creds.update', saveCreds);

    // ── Connection state ──────────────────────────────────────────────────
    this._sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this._setState('QR_READY', 'Scan with WhatsApp');
        try {
          const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
          this._latestQr = dataUrl;
          this._onQr?.(dataUrl);
          console.log(`[WA] QR ready — open ${publicWebBaseUrl()} to scan`);
        } catch (e) { console.error('[WA] QR error:', e.message); }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const boomMsg = lastDisconnect?.error?.message || '';
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        const staleSessionClose = code === DisconnectReason.connectionLost
          || code === DisconnectReason.connectionClosed
          || code === DisconnectReason.timedOut;
        console.log(`[WA] Closed — code=${code}, loggedOut=${loggedOut}${boomMsg ? ` — ${boomMsg}` : ''}`);
        this._sock = null;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        if (loggedOut || this._destroyed) {
          this._reconnectAttempt = 0;
          this._staleSessionCloseCount = 0;
          if (loggedOut && !this._destroyed) {
            console.log('[WA] Logged out by server — clearing stale auth and requesting fresh QR');
            await this._resetAuthAndRequestQr('Logged out — generating a new QR…');
            return;
          }
          this._setState('DISCONNECTED', 'Logged out — rescan QR to reconnect');
          this._onDisconnected?.();
        } else if (staleSessionClose) {
          this._staleSessionCloseCount += 1;
          const shouldResetAuth = this._staleSessionCloseCount >= 3;
          if (shouldResetAuth) {
            console.log(`[WA] Forcing fresh QR after ${this._staleSessionCloseCount} stale disconnects`);
            await this._resetAuthAndRequestQr('Session timed out — generating a new QR…');
            return;
          }
          const attempt = this._reconnectAttempt;
          this._reconnectAttempt = Math.min(attempt + 1, 12);
          const delayMs = Math.min(5000 * Math.pow(1.6, attempt), 120000);
          console.log(`[WA] Reconnect in ${Math.round(delayMs / 1000)}s (attempt ${this._reconnectAttempt})`);
          this._setState('LOADING', `Reconnecting in ${Math.round(delayMs / 1000)}s…`);
          this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            void this._connect();
          }, delayMs);
        } else {
          this._staleSessionCloseCount = 0;
          const attempt = this._reconnectAttempt;
          this._reconnectAttempt = Math.min(attempt + 1, 12);
          const delayMs = Math.min(5000 * Math.pow(1.6, attempt), 120000);
          console.log(`[WA] Reconnect in ${Math.round(delayMs / 1000)}s (attempt ${this._reconnectAttempt})`);
          this._setState('LOADING', `Reconnecting in ${Math.round(delayMs / 1000)}s…`);
          this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            void this._connect();
          }, delayMs);
        }
      }

      if (connection === 'open') {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        this._reconnectAttempt = 0;
        this._staleSessionCloseCount = 0;
        this._lastSyncingUiAt = 0;
        const user = this._sock.user;
        const name = user?.name || user?.verifiedName || user?.id?.split(':')[0] || 'unknown';
        this._ownerName = name || null;
        this._ownerJid = user?.id ? jidNormalizedUser(user.id) : null;
        console.log(`[WA] ✅ Connected as ${name}`);
        this._onReady?.({ name, phone: this._ownerJid?.split('@')[0] });
        this._setState('SYNCING', 'Loading chat history…');
        this._historyDone = false;
        this._totalMsgs = 0;
        this._uiPromotedAfterFirstHistoryBatch = false;

        // Fallback if no history batches (unusual)
        this._armSyncDoneTimer(Math.max(config.waSyncDoneDelayMs, 12_000));
      }
    });

    // ── Real-time messages ────────────────────────────────────────────────
    // Baileys uses type `notify` for live traffic and `append` for offline/queued sync — both must be indexed
    // or the DB stops updating (e.g. everything stuck on the last day the socket saw only `append` events).
    this._sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      await this._backfillLidPnChatNamesFromMessages(messages || []);
      const rows = [];
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid || !msg.message) continue;

        const row = this._msgToRow(msg);
        if (!row) continue;
        const enriched = await this._enrichRowWithMedia(msg, row);
        rows.push(enriched);
      }
      if (rows.length) {
        this._enqueueBatch(rows);
        this._promoteUiWhileHistoryContinues();
      }
    });

    /** Incoming emoji reactions — aggregated per message in DB + UI via WebSocket. */
    this._sock.ev.on('messages.reaction', (updates) => {
      for (const u of updates || []) {
        const target = u.key;
        const reactionBody = u.reaction;
        if (!target?.remoteJid || !target?.id || !reactionBody) continue;
        const emoji = reactionBody.text != null ? String(reactionBody.text) : '';
        const reactionMsgId = u.reaction?.key?.id ? String(u.reaction.key.id) : '';
        if (!reactionMsgId) continue;
        this._onReaction?.({
          chatJid: target.remoteJid,
          messageId: String(target.id),
          emoji,
          reactionMsgId,
          groupingKey: reactionBody.groupingKey != null ? String(reactionBody.groupingKey) : '',
          reactionKey: u.reaction?.key || null,
        });
      }
    });

    // ── History sync (fires in one or more batches) ───────────────────────
    this._sock.ev.on('messaging-history.set', async ({ chats, messages, contacts }) => {
      try {
        for (const c of (chats || [])) {
          const label = c.name;
          if (!label) continue;
          await this._applyLabelToLinkedJids(label, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber);
        }
        for (const c of (contacts || [])) {
          const label = c.name || c.notify || c.verifiedName;
          if (!label) continue;
          await this._applyLabelToLinkedJids(label, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber);
        }
      } catch (e) {
        console.warn('[WA] history name hydrate:', e.message);
      }

      const preview = this._buildHistoryChatsPreview(chats);
      if (preview.length) {
        this._onChatsPreview?.(preview);
        this._promoteUiWhileHistoryContinues();
      }

      await this._backfillLidPnChatNamesFromMessages(messages || []);

      for (const m of messages || []) {
        const jid = m.key?.remoteJid;
        if (!jid || !m.message) continue;
        this._syncByChat.set(jid, (this._syncByChat.get(jid) || 0) + 1);
      }

      const rows = (messages || [])
        .filter(m => m.message && m.key?.remoteJid)
        .map(m => this._msgToRow(m))
        .filter(Boolean);

      if (rows.length) {
        this._ingestHistoryRowsChunked(rows);
        console.log(`[WA] History batch queued: ${rows.length} msgs (total ${this._totalMsgs + rows.length})`);
      }

      // Reset the "done" timer — no more batches for waSyncDoneDelayMs → mark ready
      this._armSyncDoneTimer(config.waSyncDoneDelayMs);
    });

    // Chat / contact name updates
    this._sock.ev.on('chats.set', async ({ chats }) => {
      for (const c of chats || []) {
        if (!c?.name) continue;
        await this._applyLabelToLinkedJids(c.name, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber);
      }
    });
    this._sock.ev.on('chats.upsert', async (chats) => {
      for (const c of chats || []) {
        if (!c?.name) continue;
        await this._applyLabelToLinkedJids(c.name, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber);
      }
    });
    this._sock.ev.on('chats.update', async (updates) => {
      for (const u of updates || []) {
        if (!u?.name) continue;
        await this._applyLabelToLinkedJids(u.name, u.id, u.lidJid, u.pnJid, u.lid, u.phoneNumber);
      }
    });
    this._sock.ev.on('contacts.set', async ({ contacts }) => {
      for (const c of contacts || []) await this._ingestContact(c);
    });
    this._sock.ev.on('contacts.upsert', async (contacts) => {
      for (const c of contacts || []) await this._ingestContact(c);
    });
    this._sock.ev.on('contacts.update', async (contacts) => {
      for (const c of contacts || []) await this._ingestContact(c);
    });
  }

  async _applyDisplayName(jid, label) {
    if (!jid || !label) return;
    const s = String(label).trim();
    if (!s || looksLikeUrlOrSocialJunk(s) || looksLikeOpaqueNumericId(s)) return;
    this._chatNames.set(jid, s);
    await this._mirrorDisplayNameAcrossJids(jid, s);
  }

  /**
   * History + live events often carry the same display name on multiple keys (LID chat id, PN contact id, etc.).
   * Baileys `processHistoryMessage` uses id / lidJid / pnJid (chats) and id / lid / phoneNumber (contacts).
   */
  async _applyLabelToLinkedJids(label, ...jids) {
    if (!label || typeof label !== 'string') return;
    const s = label.trim();
    if (!s) return;
    if (looksLikeUrlOrSocialJunk(s) || looksLikeOpaqueNumericId(s)) return;
    const seen = new Set();
    for (const jid of jids) {
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      await this._applyDisplayName(jid, s);
    }
  }

  /**
   * Apply a display name to all messages for `jid` and for the paired LID/PN JID when known, so the sidebar
   * stays consistent when history was stored under @lid but contact names arrived on @s.whatsapp.net.
   */
  async _propagateChatNameToDb(db, jid, name) {
    if (!db?.propagateChatDisplayName || !jid || !name) return 0;
    let total = db.propagateChatDisplayName(jid, name) || 0;
    const lm = this._sock?.signalRepository?.lidMapping;
    if (!lm) return total;
    try {
      let other = null;
      if (isLidUser(jid)) {
        const pn = await lm.getPNForLID(jid);
        if (pn) other = jidNormalizedUser(pn);
      } else if (isPnUser(jid) || jid?.endsWith?.('@hosted')) {
        const lids = await lm.getLIDsForPNs([jid]);
        const lid = lids?.[0]?.lid;
        if (lid) other = jidNormalizedUser(lid);
      }
      if (other && other !== jid) {
        total += db.propagateChatDisplayName(other, name) || 0;
      }
    } catch (_) { /* mapping optional */ }
    return total;
  }

  /**
   * After sync, push resolved titles into SQLite so `getChatStats()` sidebar matches WhatsApp
   * (fixes rows indexed under LID before PN↔LID name mapping was applied).
   */
  async syncResolvedNamesToDb(db) {
    if (!db || typeof db.getDistinctChatJids !== 'function') return 0;
    const jids = db.getDistinctChatJids();
    let rowsUpdated = 0;
    for (const jid of jids) {
      if (isJidGroup(jid)) continue;
      try {
        const details = await this.getChatDetails(jid);
        const name = details?.chatName || details?.displayName;
        const bare = jid.split('@')[0] || '';
        if (!name || name === bare) continue;
        if (!isPlausibleHumanChatTitle(name, jid)) continue;
        rowsUpdated += await this._propagateChatNameToDb(db, jid, name);
      } catch (_) { /* ignore per-chat */ }
    }
    if (rowsUpdated > 0) {
      console.log(`[WA] Backfilled chat_name on ${rowsUpdated} message row(s) from resolved contact titles`);
    }
    return rowsUpdated;
  }

  /**
   * Pulls WhatsApp app-state patches (includes contact mutations with phone-book `fullName`).
   * Emits `contacts.upsert` → `_ingestContact` → `_applyLabelToLinkedJids` for LID + PN.
   */
  async resyncPhoneBookFromWhatsApp() {
    if (!this._sock?.resyncAppState || !ALL_WA_PATCH_NAMES?.length) return;
    try {
      console.log('[WA] Syncing app state from WhatsApp (contact / phone book names)…');
      await this._sock.resyncAppState(ALL_WA_PATCH_NAMES, false);
    } catch (e) {
      console.warn('[WA] resyncAppState:', e.message);
    }
  }

  /** Resync server contact data, wait for events, then push titles into SQLite + FTS. */
  async refreshPhoneBookNamesInDb(db) {
    await this.resyncPhoneBookFromWhatsApp();
    await new Promise((r) => setTimeout(r, 6000));
    return this.syncResolvedNamesToDb(db);
  }

  /** Server: when a new human-readable title is known for a chat, backfill SQLite for LID+PN pair. */
  propagateDisplayNameForChat(db, jid, name) {
    return this._propagateChatNameToDb(db, jid, name);
  }

  /** WhatsApp links the same person under @lid (chat id) and @s.whatsapp.net (contact id) — mirror the label. */
  async _mirrorDisplayNameAcrossJids(jid, label) {
    const sock = this._sock;
    const lm = sock?.signalRepository?.lidMapping;
    if (!lm || !label) return;
    try {
      if (isLidUser(jid)) {
        const pn = await lm.getPNForLID(jid);
        if (pn) this._chatNames.set(jidNormalizedUser(pn), label);
      } else if (isPnUser(jid)) {
        const lid = await lm.getLIDForPN(jid);
        if (lid) this._chatNames.set(jidNormalizedUser(lid), label);
      }
    } catch (_) { /* mapping may lag behind first messages */ }
  }

  async _ingestContact(c) {
    const label = c.name || c.notify || c.verifiedName;
    if (!label) return;
    await this._applyLabelToLinkedJids(label, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber);
  }

  /** Resolve display name from cache (raw JID or Baileys-normalized user id). */
  _nameFromChatMap(jid) {
    if (!jid) return null;
    const direct = this._chatNames.get(jid);
    if (direct) return direct;
    try {
      const n = jidNormalizedUser(jid);
      if (n && n !== jid) return this._chatNames.get(n) || null;
    } catch (_) {}
    return null;
  }

  /**
   * 1:1 chats may use @lid as remoteJid while contact names arrive on @s.whatsapp.net.
   * Message keys often include `remoteJidAlt` / `participantAlt` with the paired address.
   * Signal LID↔PN store fills in the rest once mappings exist.
   */
  async _backfillLidPnChatNamesFromMessages(messages) {
    const lm = this._sock?.signalRepository?.lidMapping;
    if (!lm || !messages?.length) return;
    const jids = [...new Set(messages.map((m) => m.key?.remoteJid).filter(Boolean))];
    for (const jid of jids) {
      try {
        if (isLidUser(jid)) {
          if (this._nameFromChatMap(jid)) continue;
          const pn = await lm.getPNForLID(jid);
          if (!pn) continue;
          const name = this._nameFromChatMap(pn);
          if (name) await this._applyDisplayName(jid, name);
        } else if (isPnUser(jid) || jid?.endsWith?.('@hosted')) {
          const nameHere = this._nameFromChatMap(jid);
          const lids = await lm.getLIDsForPNs([jid]);
          const lid = lids?.[0]?.lid;
          if (lid && nameHere && !this._nameFromChatMap(lid)) {
            await this._applyDisplayName(lid, nameHere);
          } else if (lid && !nameHere) {
            const fromLid = this._nameFromChatMap(lid);
            if (fromLid) await this._applyDisplayName(jid, fromLid);
          }
        }
      } catch (_) { /* mapping can lag first sync */ }
    }
  }

  /**
   * Group titles come from chat/group metadata; 1:1 chats often only get a name via contact events
   * or incoming `pushName` (peer display name) — use that so the sidebar matches WhatsApp.
   */
  _resolveChatDisplayName(jid, msg) {
    if (isJidGroup(jid)) {
      const gn = this._nameFromChatMap(jid);
      if (gn && isPlausibleHumanChatTitle(gn, jid)) return gn;
      return jid.split('@')[0];
    }
    // PN ⇄ LID: paired JID on the key (see Baileys decodeMessageNode / messages-recv mapping)
    const alts = [msg.key?.remoteJidAlt, msg.key?.participantAlt].filter(Boolean);
    for (const alt of alts) {
      const label = this._nameFromChatMap(alt);
      if (label && isPlausibleHumanChatTitle(label, jid)) {
        this._chatNames.set(jid, label);
        try {
          const norm = jidNormalizedUser(jid);
          if (norm && norm !== jid) this._chatNames.set(norm, label);
        } catch (_) {}
        void this._mirrorDisplayNameAcrossJids(jid, label).catch(() => {});
        return label;
      }
    }
    const biz = msg.verifiedBizName;
    if (biz && isPlausibleHumanChatTitle(biz, jid)) {
      this._chatNames.set(jid, biz);
      void this._mirrorDisplayNameAcrossJids(jid, biz).catch(() => {});
      return biz;
    }
    // Push name is often the best available label (esp. when phonebook names aren't accessible via WA APIs).
    // Some multi-device events may mark messages as fromMe; don't rely on that flag here.
    if (msg.pushName && !looksLikePhoneDigitsOnly(msg.pushName) && isPlausibleHumanChatTitle(msg.pushName, jid)) {
      // Never label a 1:1 chat with *our own* profile name (some multi-device/fromMe events report our name here).
      if (!isProbablyOwnName(msg.pushName, this._ownerName)) {
        this._chatNames.set(jid, msg.pushName);
        void this._mirrorDisplayNameAcrossJids(jid, msg.pushName).catch(() => {});
        return msg.pushName;
      }
    }
    const cached = this._nameFromChatMap(jid);
    if (cached && isPlausibleHumanChatTitle(cached, jid)) return cached;
    return fallbackTitleForOneOnOneJid(jid);
  }

  // ── Sync-done gate ─────────────────────────────────────────────────────────
  /**
   * As soon as we have indexed data, mark linked device `READY` so the web UI can load chats.
   * WhatsApp may keep sending `messaging-history.set` for a long time; we do not block the UI for that.
   */
  _promoteUiWhileHistoryContinues() {
    if (this._state !== 'SYNCING' || this._uiPromotedAfterFirstHistoryBatch) return;
    this._uiPromotedAfterFirstHistoryBatch = true;
    const n = this._totalMsgs;
    const msg =
      n > 0
        ? `${n.toLocaleString()} messages · still syncing…`
        : 'Connected — history still loading…';
    this._setState('READY', msg);
  }

  _buildHistoryChatsPreview(chats) {
    return (chats || [])
      .filter((c) => c?.id)
      .map((c) => {
        const ts = c.conversationTimestamp != null ? Number(c.conversationTimestamp) : 0;
        return {
          chatJid: c.id,
          chatName: c.name || null,
          messageCount: 0,
          // API contract: timestamps are always Unix seconds.
          lastMessageTs: normalizeUnixSeconds(ts),
          summarizedCount: 0,
          participantCount: isJidGroup(c.id) ? 2 : 1,
        };
      });
  }

  /**
   * Insert history in small chunks so SQLite + WebSocket work does not block the Baileys socket
   * (blocking here was causing connectionLost / reconnect loops when many chats loaded at once).
   */
  _ingestHistoryRowsChunked(rows) {
    const chunkSize = config.waHistoryChunkSize;
    let offset = 0;
    const drain = () => {
      if (offset >= rows.length) return;
      const chunk = rows.slice(offset, offset + chunkSize);
      offset += chunk.length;
      this._onMessages?.(chunk);
      this._totalMsgs += chunk.length;
      this._onProgress?.({
        completed: 0,
        total: 0,
        messages: this._totalMsgs,
        byChat: Object.fromEntries(this._syncByChat),
      });
      const now = Date.now();
      if (now - this._lastSyncingUiAt >= 1200) {
        this._lastSyncingUiAt = now;
        if (!this._uiPromotedAfterFirstHistoryBatch) {
          this._setState('SYNCING', `Syncing… ${this._totalMsgs.toLocaleString()} messages received`);
        }
      }
      this._promoteUiWhileHistoryContinues();
      if (offset < rows.length) setImmediate(drain);
    };
    drain();
  }

  _armSyncDoneTimer(ms) {
    clearTimeout(this._syncDoneTimer);
    this._syncDoneTimer = setTimeout(() => this._finishSync(), ms);
  }

  _finishSync() {
    if (this._historyDone) return;
    this._historyDone = true;
    this._syncByChat.clear();
    console.log(`[WA] Sync complete — ${this._totalMsgs} messages`);
    this._setState('READY', `${this._totalMsgs.toLocaleString()} messages ready`);
    try { this._onHistorySyncComplete?.(); } catch (e) {
      console.warn('[WA] onHistorySyncComplete:', e.message);
    }
  }

  // ── Batch flush ────────────────────────────────────────────────────────────
  _enqueueBatch(rows) {
    this._pendingBatch.push(...rows);
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        if (this._pendingBatch.length) this._onMessages?.(this._pendingBatch.splice(0));
      }, BATCH_MS);
    }
  }

  _setState(state, message) {
    this._state = state;
    this._onStatus?.({ state, message });
  }

  /**
   * Same title resolution as chat header: direct cache + LID↔PN cross-lookup (names often live on the paired JID).
   * Returns null if no plausible saved/business title — caller falls back to group id chunk or phone-style label.
   */
  async _resolveContactTitleFromCache(jid) {
    if (!jid) return null;
    let cachedName = this._nameFromChatMap(jid);
    const lm = this._sock?.signalRepository?.lidMapping;
    if (!cachedName && lm) {
      try {
        if (isLidUser(jid)) {
          const pn = await lm.getPNForLID(jid);
          if (pn) cachedName = this._nameFromChatMap(pn);
        } else if (isPnUser(jid) || jid?.endsWith?.('@hosted')) {
          const lids = await lm.getLIDsForPNs([jid]);
          const lid = lids?.[0]?.lid;
          if (lid) cachedName = this._nameFromChatMap(lid);
        }
      } catch (_) {}
    }
    if (cachedName && isPlausibleHumanChatTitle(cachedName, jid)) return cachedName;
    return null;
  }

  /**
   * Live metadata (groups + contacts) when the socket is up. Falls back to minimal info on error.
   */
  async getChatDetails(jid) {
    if (!jid) return null;
    const resolvedTitle = await this._resolveContactTitleFromCache(jid);
    const displayName =
      resolvedTitle
        ? resolvedTitle
        : (isJidGroup(jid) ? jid.split('@')[0] : fallbackTitleForOneOnOneJid(jid));
    const base = {
      chatJid: jid,
      displayName,
      isGroup: isJidGroup(jid),
    };
    if (!this._sock) {
      return { ...base, waConnected: false };
    }
    try {
      if (isJidGroup(jid)) {
        const meta = await this._sock.groupMetadata(jid);
        return {
          ...base,
          waConnected: true,
          subject: (meta.subject && isPlausibleHumanChatTitle(meta.subject, jid) ? meta.subject : null) || base.displayName,
          description: meta.desc || '',
          participantCount: meta.participants?.length ?? 0,
          owner: meta.owner || null,
        };
      }
      const phone = jid.split('@')[0] || '';
      return {
        ...base,
        waConnected: true,
        phone,
        chatName: displayName,
      };
    } catch (e) {
      return { ...base, waConnected: true, error: e.message };
    }
  }

  /**
   * Apply in-memory titles (contact events, pushName, LID↔PN mirroring) on top of DB chat stats
   * so the sidebar list matches the chat header and WhatsApp — `/api/chats` uses this.
   * Async: must mirror getChatDetails / _resolveContactTitleFromCache (LID↔PN), not only _nameFromChatMap(jid).
   */
  async overlayResolvedChatNames(stats) {
    if (!Array.isArray(stats) || !stats.length) return stats;
    const uniqueJids = [...new Set(stats.map((row) => row.chatJid).filter(Boolean))];
    const resolvedMap = new Map();
    await Promise.all(
      uniqueJids.map(async (jid) => {
        try {
          resolvedMap.set(jid, await this._resolveContactTitleFromCache(jid));
        } catch {
          resolvedMap.set(jid, null);
        }
      }),
    );
    return stats.map((row) => {
      const jid = row.chatJid;
      if (!jid) return row;
      const resolved = resolvedMap.get(jid);
      if (resolved) return { ...row, chatName: resolved };
      let next = row;
      if (
        (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted'))
        && looksLikeLidFallbackContactLabel(row.chatName)
      ) {
        next = { ...row, chatName: replaceLidPlaceholderWithPn(jid, row.chatName) };
      }
      return next;
    });
  }

  /**
   * Resolve LID ↔ phone-number JID for one 1:1 contact so APIs can query merged history.
   */
  async getLinked1on1Jids(jid) {
    if (!jid || isJidGroup(jid)) return [jid];
    const lm = this._sock?.signalRepository?.lidMapping;
    if (!lm) return [jidNormalizedUser(jid) || jid];
    const out = new Set();
    try {
      const n = jidNormalizedUser(jid) || jid;
      out.add(n);
      if (isLidUser(jid)) {
        const pn = await lm.getPNForLID(jid);
        if (pn) out.add(jidNormalizedUser(pn));
      } else if (isPnUser(jid) || jid?.endsWith?.('@hosted')) {
        const lids = await lm.getLIDsForPNs([jid]);
        const lid = lids?.[0]?.lid;
        if (lid) out.add(jidNormalizedUser(lid));
      }
    } catch (_) {
      /* mapping optional */
    }
    return [...out];
  }

  /**
   * Combine sidebar rows that refer to the same person (indexed under @lid and @s.whatsapp.net).
   */
  async mergeLinkedPersonalChatStats(stats) {
    if (!Array.isArray(stats) || !stats.length) return stats;
    const lm = this._sock?.signalRepository?.lidMapping;
    if (!lm) return stats;

    const resolveCanonical = async (jid) => {
      if (!jid || isJidGroup(jid)) return jid;
      try {
        if (isLidUser(jid)) {
          const pn = await lm.getPNForLID(jid);
          if (pn) return jidNormalizedUser(pn);
        }
        return jidNormalizedUser(jid) || jid;
      } catch {
        return jid;
      }
    };

    const uniqueJids = [...new Set(stats.map((r) => r.chatJid).filter(Boolean))];
    const canonByJid = new Map();
    await Promise.all(
      uniqueJids.map(async (jid) => {
        canonByJid.set(jid, await resolveCanonical(jid));
      }),
    );

    const merged = new Map();
    for (const row of stats) {
      const canon = canonByJid.get(row.chatJid) ?? row.chatJid;
      const existing = merged.get(canon);
      if (!existing) {
        merged.set(canon, {
          ...row,
          chatJid: canon,
          chatName: replaceLidPlaceholderWithPn(canon, row.chatName),
        });
        continue;
      }
      const a = existing;
      const b = row;
      const mc = (a.messageCount || 0) + (b.messageCount || 0);
      const lastTs = Math.max(a.lastMessageTs || 0, b.lastMessageTs || 0);
      const sumT = (a.summarizedThreads || 0) + (b.summarizedThreads || 0);
      const totT = (a.totalThreads || 0) + (b.totalThreads || 0);
      const searchIndexPct =
        totT === 0 ? 100 : Math.min(100, Math.round((sumT / totT) * 100));
      const aiSearchReady = sumT > 0;
      const aiSearchComplete = totT === 0 ? true : sumT >= totT;
      const mergedName = replaceLidPlaceholderWithPn(canon, pickBetterChatTitle(a.chatName, b.chatName, canon));
      merged.set(canon, {
        ...a,
        chatJid: canon,
        chatName: mergedName,
        sidebarTab: (a.sidebarTab === 'feed' || b.sidebarTab === 'feed') ? 'feed' : 'chat',
        messageCount: mc,
        lastMessageTs: lastTs,
        summarizedThreads: sumT,
        totalThreads: totT,
        searchIndexPct,
        aiSearchReady,
        aiSearchComplete,
        participantCount: Math.max(a.participantCount || 0, b.participantCount || 0),
      });
    }
    const rank = (c) => {
      const lm = c.lastMessageTs || 0;
      const n = Math.max(1, c.messageCount || 0);
      return lm * Math.log1p(n);
    };
    return [...merged.values()].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (rb !== ra) return rb - ra;
      return (b.lastMessageTs || 0) - (a.lastMessageTs || 0);
    });
  }

  async _enrichRowWithMedia(msg, row) {
    if (!row?.mediaType || !MEDIA_FOR_INDEX.has(row.mediaType) || !this._sock) return row;
    try {
      const download = async (m) => downloadMediaMessage(m, 'buffer', {}, {
        logger: this._mediaLogger,
        reuploadRequest: (x) => this._sock.updateMediaMessage(x),
      });

      let buffer;
      try {
        buffer = await download(msg);
      } catch (e1) {
        const m = String(e1?.message || '');
        // Common failure: the direct mmg.whatsapp.net URL in older messages is expired.
        // Force a refresh of the media message from WhatsApp and retry once.
        if (m.includes('Failed to fetch stream') || m.includes('Status code: 403') || m.includes('Status code: 401')) {
          try {
            const refreshed = await this._sock.updateMediaMessage(msg);
            buffer = await download(refreshed || msg);
          } catch (e2) {
            throw e2;
          }
        } else {
          throw e1;
        }
      }
      if (row.mediaType === 'video' && buffer.length > MAX_VIDEO_BYTES) {
        console.warn(`[WA] skip large video (${buffer.length} bytes)`);
        return row;
      }
      const m = msg.message;
      const mime =
        m.imageMessage?.mimetype ||
        m.videoMessage?.mimetype ||
        m.audioMessage?.mimetype ||
        m.stickerMessage?.mimetype ||
        m.documentMessage?.mimetype ||
        'application/octet-stream';
      const ext = extFromMime(mime);
      const dir = join(config.mediaDir, safeJidDir(row.chatJid));
      mkdirSync(dir, { recursive: true });
      const filename = `${row.messageId}.${ext}`;
      const fullPath = join(dir, filename);
      writeFileSync(fullPath, buffer);
      return { ...row, mediaPath: fullPath };
    } catch (e) {
      // Avoid spamming full signed URLs (they're ephemeral and noisy in logs)
      const msgText = String(e?.message || 'media download failed');
      console.warn(`[WA] media download ${row.messageId}:`, msgText.replace(/https?:\/\/\S+/g, '<url>'));
      return row;
    }
  }

  _queueMediaDownload(msg, row) {
    if (!row?.mediaType || !MEDIA_FOR_INDEX.has(row.mediaType) || !this._sock) return;
    this._mediaQueue.push({ msg, row });
    this._drainMediaQueue().catch(() => {});
  }

  async _drainMediaQueue() {
    if (this._mediaDraining) return;
    this._mediaDraining = true;
    try {
      while (this._mediaQueue.length && !this._destroyed) {
        const { msg, row } = this._mediaQueue.shift();
        const enriched = await this._enrichRowWithMedia(msg, row);
        if (enriched.mediaPath && this._onMediaPath) {
          this._onMediaPath(enriched.messageId, enriched.mediaPath);
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      this._mediaDraining = false;
    }
  }

  // ── Message → DB row ───────────────────────────────────────────────────────
  _msgToRow(msg) {
    try {
      const jid = msg.key.remoteJid;
      if (!jid || !msg.message) return null;

      const inner = extractMessageContent(msg.message) || msg.message;
      let rxPayload = null;
      if (Array.isArray(msg.reactions)) {
        const rxList = msg.reactions;
        const rxCounts = aggregateReactionCountsFromProtoList(rxList);
        rxPayload = {
          reactionsJson: rxCounts ? JSON.stringify(rxCounts) : null,
          reactionSlots: rxList
            .filter((r) => r?.text != null && String(r.text).trim())
            .map((r) => ({
              groupingKey: r.groupingKey,
              reactionKey: r.key || null,
              text: r.text,
            })),
        };
      }
      let text = extractText(msg);
      const contactBundle = buildContactPayloadFromInner(inner);
      if (contactBundle?.summaryText) {
        text = contactBundle.summaryText;
      }
      const contactPayload = contactBundle ? JSON.stringify(contactBundle.payload) : null;

      const hasMedia = !!(
        inner.imageMessage ||
        inner.videoMessage ||
        inner.audioMessage ||
        inner.documentMessage ||
        inner.stickerMessage
      );
      if (!text && !hasMedia && !contactPayload) {
        text = placeholderForUntracked(inner);
      }

      const mediaType = hasMedia
        ? (inner.imageMessage ? 'image' : inner.videoMessage ? 'video' : inner.audioMessage ? 'audio' : inner.documentMessage ? 'document' : 'sticker')
        : null;

      const senderJid  = msg.key.participant || (msg.key.fromMe ? this._ownerJid : jid);
      let senderName =
        msg.pushName ||
        this._nameFromChatMap(senderJid) ||
        this._nameFromChatMap(msg.key?.participantAlt) ||
        this._nameFromChatMap(msg.key?.remoteJidAlt) ||
        senderJid?.split('@')[0] ||
        'Unknown';
      const snClean = sanitizePeerSenderName(senderName, jid);
      if (snClean) senderName = snClean;
      else if (senderJid?.endsWith?.('@s.whatsapp.net')) {
        senderName = formatPhoneLocalPart(senderJid.split('@')[0]);
      } else {
        senderName = senderJid?.split('@')[0] || 'Unknown';
      }
      let chatName   = this._resolveChatDisplayName(jid, msg);
      // For 1:1 chats, WhatsApp often only gives a good name via pushName on an incoming message.
      // If the resolved chat title is just a number but we have a human sender name, use that.
      if (!isJidGroup(jid) && looksLikePhoneDigitsOnly(chatName) && senderName && senderName !== 'You' && !looksLikePhoneDigitsOnly(senderName)) {
        chatName = senderName;
      }

      return {
        messageId:    msg.key.id || `${msg.messageTimestamp}_${Math.random()}`,
        chatJid:      jid,
        chatName,
        sender:       msg.key.fromMe ? 'You' : senderName,
        senderJid:    senderJid || null,
        text:         text || null,
        mediaType,
        mediaPath:    null,
        mediaCaption:
          inner.imageMessage?.caption ||
          inner.videoMessage?.caption ||
          inner.documentMessage?.caption ||
          (inner.documentMessage?.fileName ? String(inner.documentMessage.fileName).trim() : null) ||
          null,
        timestamp:    Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        contactPayload,
        ...(rxPayload || {}),
      };
    } catch { return null; }
  }

  /**
   * Ask the primary phone for older messages before `anchor` (Baileys PDO history sync on demand).
   * WhatsApp may still cap depth; repeat later or use exported chats for a full offline archive.
   */
  async fetchOlderHistoryFromPhone(anchor, count = 50) {
    if (!this._sock?.fetchMessageHistory) throw new Error('WhatsApp not connected');
    const { chatJid, messageId, timestamp, fromMe } = anchor || {};
    if (!chatJid || !messageId) throw new Error('Missing chat anchor');
    let ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) throw new Error('Invalid anchor timestamp');
    if (ts < 1e12) ts *= 1000;
    const key = {
      remoteJid: chatJid,
      id: String(messageId),
      fromMe: Boolean(fromMe),
    };
    const n = Math.min(100, Math.max(1, Math.floor(Number(count) || 50)));
    return this._sock.fetchMessageHistory(n, key, ts);
  }
}
