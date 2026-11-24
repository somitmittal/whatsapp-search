/**
 * wa-client.js — WhatsApp integration via @whiskeysockets/baileys
 *
 * Baileys implements the WhatsApp multi-device WS protocol directly.
 * No Puppeteer / headless browser → no bot-detection / "Can't link" errors.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { rename, rm as rmAsync, writeFile } from 'fs/promises';
import { createRequire } from 'module';
import { extname, join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import config from '../config.js';
import { normalizeUnixSeconds } from '../utils/timestamp.js';
import {
    avatarActionForContact,
    avatarFileName,
    imageExtFromBytes,
    isAvatarEligibleJid,
    profilePictureFailure,
} from './chat-avatars.js';
import {
    fallbackTitleForOneOnOneJid,
    formatPhoneLocalPart,
    isPlausibleHumanChatTitle,
    isPlaceholderSenderName,
    isResolvedHumanChatTitle,
    isUpgradeableSenderName,
    looksLikeLidFallbackContactLabel,
    looksLikeMaskedPhoneLabel,
    looksLikeOpaqueNumericId,
    looksLikePhoneDigitsOnly,
    looksLikeUnusableChatTitle,
    looksLikeUrlOrSocialJunk,
    pickBetterChatTitle,
    sanitizePeerSenderName,
} from './chat-display-name.js';
import { buildContactPayloadFromInner } from './contact-card.js';
import { normalizeGroupCreateInput } from './group-create.js';
import { groupSubjectUpdates } from './group-subjects.js';
import {
  evaluatePhoneHistoryQuota,
  filterRowsByRetention,
  fullHistoryBackoffSec,
  HISTORY_SYNC_TYPE_ON_DEMAND,
  PHONE_HISTORY_DEFAULT_COUNT,
  PHONE_HISTORY_INFLIGHT_MS,
  shouldSyncHistoryMessage,
} from './history-sync-policy.js';
import { isHistorySyncInFlight } from './ingestion-gate.js';
import { isImportedChatJid, isWhatsAppLowPriorityFeed, shouldPreserveRawChatJid, sidebarTabForJid } from './jid-filters.js';
import { sortDeferredMediaByChatActivity, takeNextDeferredMediaItem } from './media-download-priority.js';
import {
  MEDIA_TOO_LARGE_PATH,
  MEDIA_UNAVAILABLE_PATH,
  WA_MEDIA_DRAIN_GAP_MS,
  isPermanentMediaFailure,
  isTerminalMediaPath,
} from './media-constants.js';
import { buildMediaDownloadStub } from './media-download-stub.js';
import { downloadMediaMessageSafe } from './safe-media-download.js';
import {
  audioSendContent,
  inferAudioMimeFromFilename,
  isAudioMime,
  normalizeAudioMime,
} from './voice-content.js';
import { prepareOutboundAudioForWhatsApp, probeMediaStreams } from '../web/audio-transcode.js';
import {
    extractRenderableTextFromInner,
    isControlOnlyContentType,
    peelNestedMessage,
    placeholderForContentType,
} from './message-content.js';
import {
    normalizeReceiptStatus,
    receiptAfterSuccessfulRelay,
    receiptFromGroupReceipt,
} from './message-receipt.js';
import {
    isImmediateReconnectCode,
    isQrUsable,
    qrTtlMsForIndex,
    reconnectDelayMs,
    shouldResetAuthAfterStaleCloses,
} from './qr-lifecycle.js';
import { aggregateReactionCountsFromProtoList } from './reaction-counts.js';
import { captureUnreadCounts, clearUnreadCount, unreadCountForChat } from './unread-tracker.js';

import makeWASocket, {
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
} from '@whiskeysockets/baileys';

const require = createRequire(import.meta.url);
const QRCode   = require('qrcode');
const P        = require('pino');

const BATCH_MS = 2000;

/** Pause between WhatsApp network calls while draining media and profile pictures. */
const WA_DRAIN_GAP_MS = config.waMediaDrainGapMs ?? WA_MEDIA_DRAIN_GAP_MS;

const MEDIA_FOR_INDEX = new Set(['image', 'audio', 'video', 'sticker', 'document']);
/** Drain order bias: light types first so videos cannot monopolize the shared worker pool. */
const MEDIA_QUEUE_TYPES = ['image', 'audio', 'sticker', 'document', 'video'];
/** Auto-download cap for background video sync (defers very large videos so other messages aren't blocked). */
const MAX_VIDEO_BYTES_BACKGROUND = 32 * 1024 * 1024; // 32 MiB
/** Cap for active chat or user-requested video downloads (streams direct to disk). */
const MAX_VIDEO_BYTES_EXPLICIT = 100 * 1024 * 1024; // 100 MiB

function safeJidDir(jid) {
  return String(jid || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('ogg') || (m.includes('opus') && !m.includes('webm'))) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.startsWith('audio/') && (m.includes('mp4') || m.includes('m4a') || m.includes('aac'))) return 'm4a';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  if (m.includes('amr')) return 'amr';
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('spreadsheetml') || m.includes('excel')) return 'xlsx';
  if (m.includes('csv')) return 'csv';
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
  let t = extractRenderableTextFromInner(m) || '';
  const contacts = summarizeContactsArrayMessage(m.contactsArrayMessage);
  if (contacts && !t) t = contacts;
  const docFn = m.documentMessage?.fileName ? String(m.documentMessage.fileName).trim() : '';
  if (docFn && !t.includes(docFn)) t = t ? `${t} ${docFn}` : docFn;
  return t;
}

/** Peel device-sent / bot-forward / ephemeral wrappers, then Baileys' extract. */
function resolveInnerContent(rawMessage) {
  if (!rawMessage) return null;
  const peeled = peelNestedMessage(rawMessage);
  return extractMessageContent(peeled) || peeled;
}

function extractText(msg) {
  if (!msg?.message) return '';
  return extractTextFromInner(resolveInnerContent(msg.message));
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

/**
 * When a row is keyed by phone JID but still carries a LID leftover title
 * ("Contact (…)", opaque LID digits, masked +91∙∙∙…), show +CC ….
 */
function replaceLidPlaceholderWithPn(canonJid, chatName) {
  if (!(canonJid.endsWith('@s.whatsapp.net') || canonJid.endsWith('@hosted'))) {
    return chatName;
  }
  if (
    looksLikeLidFallbackContactLabel(chatName)
    || looksLikeOpaqueNumericId(chatName)
    || looksLikeMaskedPhoneLabel(chatName)
  ) {
    return formatPhoneLocalPart(canonJid.split('@')[0]);
  }
  return chatName;
}

// ─────────────────────────────────────────────────────────────────────────────
export default class WaClient {
  constructor({
    authDir, configFile, onQr, onReady, onMessages, onChatsPreview, onHistorySyncComplete,
    onStatus, onProgress, onSyncActivityChange, onSearchQuery, onDisconnected, onMediaPath, onReaction,
    onResolvedDisplayName, onResolvedSenderName, onUnreadCounts, onMessageRevoked, onMessageEdited,
    onChatAvatar, onMessageReceipt, onLoadPendingMediaStubs, onLoadDeferredLargeVideos, onClearDeferredVideoPath, onMediaNeedsDownload, onMediaSettled,
    onClaimMediaDownload, onReleaseMediaDownloadClaim,
  }) {
    this._authDir = authDir || join(config.dataDir, '.baileys_auth');
    this._configFile = configFile || join(config.dataDir, 'wa-config.json');
    this._onQr          = onQr;
    this._onReady       = onReady;
    this._onMessages    = onMessages;
    this._onChatsPreview = onChatsPreview;
    this._onHistorySyncComplete = onHistorySyncComplete;
    this._onStatus      = onStatus;
    this._onProgress    = onProgress;
    this._onSyncActivityChange = onSyncActivityChange;
    this._onSearchQuery = onSearchQuery;
    this._onDisconnected = onDisconnected;
    this._onMediaPath   = onMediaPath;
    this._onLoadPendingMediaStubs = onLoadPendingMediaStubs;
    this._onLoadDeferredLargeVideos = onLoadDeferredLargeVideos;
    this._onClearDeferredVideoPath = onClearDeferredVideoPath;
    this._onMediaNeedsDownload = onMediaNeedsDownload;
    this._onMediaSettled = onMediaSettled;
    this._onClaimMediaDownload = onClaimMediaDownload;
    this._onReleaseMediaDownloadClaim = onReleaseMediaDownloadClaim;
    this._onReaction    = onReaction;
    this._onResolvedDisplayName = onResolvedDisplayName;
    this._onResolvedSenderName = onResolvedSenderName;
    this._onUnreadCounts = onUnreadCounts;
    this._onMessageRevoked = onMessageRevoked;
    this._onMessageEdited = onMessageEdited;
    this._onChatAvatar = onChatAvatar;
    this._onMessageReceipt = onMessageReceipt;

    this._sock          = null;
    this._state         = 'DISCONNECTED';
    /** WhatsApp-reported unread count by chat JID (runtime state from chat events). */
    this._unreadByChat  = new Map();
    this._latestQr      = null;
    this._qrIssuedAt    = 0;
    this._qrTtlMs       = 0;
    /** QRs emitted by the current socket — WhatsApp gives the first one a longer life. */
    this._qrIndex       = 0;
    this._ownerJid      = null;
    this._ownerName     = null;
    this._chatNames     = new Map();   // jid → display name
    this._lidToPn       = new Map();   // lid jid -> pn jid
    this._pnToLid       = new Map();   // pn jid -> lid jid
    this._groupMetaFetchedAt = new Map(); // group jid -> ms timestamp
    this._preloadLidMappingsFromAuthDir();
    /** Messages received per chat during current history sync (for UI progress). */
    this._syncByChat    = new Map();
    this._totalMsgs     = 0;
    /** WhatsApp-reported history transfer progress (0–100); null when the phone sends none. */
    this._historyProgress = null;
    this._syncDoneTimer = null;
    this._historyDone   = false;
    /**
     * True only between `connection: 'open'` and the end of that connection's history sync.
     * Without it a client that is merely constructed, showing a QR nobody scans, or stuck in
     * reconnect backoff would report an in-flight history sync forever and stall AI indexing.
     */
    this._historySyncStarted = false;
    /** Rows queued through setImmediate but not yet handed to SQLite. */
    this._pendingHistoryRows = 0;
    /** The idle timer fired while history rows were still draining. */
    this._finishSyncRequested = false;
    this._destroyed     = false;
    this._pendingBatch  = [];
    this._flushTimer    = null;
    this._liveFlushTimer = null;
    // Per-type queues so a slow video cannot sit ahead of small images in a single FIFO.
    // Shared worker budget below preserves the configured concurrency.
    this._mediaQueues = new Map(MEDIA_QUEUE_TYPES.map((type) => [type, []]));
    this._mediaQueueCursor = 0;
    /**
     * Opened / refreshed chats, newest first. Cap matches `liveRecentWindowDays` so a
     * click-tour cannot turn into a whole-archive download.
     */
    this._priorityMediaChatJids = [];
    /** Chats that may ask the phone to re-upload expired CDN media (explicit Retry / Load). */
    this._phoneReuploadChatJids = new Set();
    /** Individual messages explicitly retried by the user (always eligible for phone re-upload). */
    this._retryMediaIds = new Set();
    /** In-memory queue/in-flight set for UI `isMediaQueued` + cheap enqueue dedupe. */
    this._queuedMediaIds = new Set();
    /** Recently persisted outbound media paths keyed by messageId (avoids upsert echo race). */
    this._recentOutboundMediaPaths = new Map();
    /** In-memory cache of media downloads that failed from CDN (avoids infinite background re-queue loops). */
    this._failedMediaDownloads = new Map();
    this._mediaDraining = false;
    /** Sidebar profile / group pictures. Filled newest-first and drained after history sync. */
    this._avatarQueue = [];
    this._avatarQueued = new Set();
    this._avatarDraining = false;
    this._avatarEpoch = 0;
    this._mediaLogger   = P({ level: 'silent' });
    /** Serialize connects — parallel _connect() calls used to create overlapping Baileys sockets → disconnect loop. */
    this._connectSeq = Promise.resolve();
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._reconnectTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._historyRetryTimer = null;
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
  /** Null once WhatsApp has expired the code — an unscannable QR is worse than none. */
  get latestQr() {
    return isQrUsable(this._qrIssuedAt, Date.now(), this._qrTtlMs) ? this._latestQr : null;
  }
  /** True while saved credentials exist, i.e. we are reconnecting rather than pairing. */
  get hasSavedCreds() {
    return existsSync(join(this._authDir, 'creds.json'));
  }

  isInitialHistorySyncDone() {
    return Boolean(loadCfg(this._configFile).initialHistorySyncDone);
  }

  isMediaDraining() {
    return Boolean(this._mediaDraining || this._mediaQueueLength() > 0);
  }

  isPhoneHistoryInflight() {
    const state = this._phoneHistory;
    if (!state?.inflight) return false;
    if (Date.now() >= state.inflight.until) {
      state.inflight = null;
      return false;
    }
    return true;
  }

  _notifySyncActivity() {
    try { this._onSyncActivityChange?.(); } catch (_) {}
  }

  _clearInitialHistorySyncFlag() {
    this._acceptPhoneHistorySync = true;
    // Linking / QR-scan / resync are user actions — never hold them for backoff.
    // requestHistoryResync({ auto: true }) overrides right after with auto pacing.
    this._forceFullHistoryOnce = true;
    const cfg = loadCfg(this._configFile);
    saveCfg(this._configFile, {
      ...cfg,
      initialHistorySyncDone: false,
      // Survives the “already linked → skip history” guard in `_buildSocket`.
      acceptHistoryOnce: true,
    });
  }

  _clearQr() {
    this._latestQr = null;
    this._qrIssuedAt = 0;
    this._qrTtlMs = 0;
  }

  /** ── Full-history retry backoff (never refuses, only delays) ──────────────
   *  Rows are timestamps (ms) of past full-history requests, persisted in
   *  wa-config.json so restarts do not reset the pacing. */
  _fullHistoryRequestsInWindow(cfg = {}) {
    const now = Date.now();
    const WINDOW_MS = 24 * 60 * 60 * 1000;
    const list = Array.isArray(cfg.fullHistoryRequests) ? cfg.fullHistoryRequests : [];
    return list
      .map(Number)
      .filter((t) => Number.isFinite(t) && t > 0 && now - t >= 0 && now - t < WINDOW_MS)
      .sort((a, b) => a - b);
  }

  /** How much longer must zero-touch retries wait, given the persisted request log. */
  _fullHistoryRemainingWaitMs(cfg = {}) {
    const requests = this._fullHistoryRequestsInWindow(cfg);
    if (!requests.length) return 0;
    const last = requests[requests.length - 1];
    const gapSec = fullHistoryBackoffSec(requests.length);
    if (!gapSec) return 0;
    const elapsed = Date.now() - last;
    return Math.max(0, gapSec * 1000 - elapsed);
  }

  /** Persist a new request timestamp; returns the updated cfg for follow-up saves. */
  _recordFullHistoryRequest(cfg = {}) {
    const next = { ...cfg, fullHistoryRequests: [...this._fullHistoryRequestsInWindow(cfg), Date.now()] };
    try {
      saveCfg(this._configFile, next);
    } catch (err) {
      console.warn('[WA] Could not persist history request log:', err?.message || err);
    }
    return next;
  }

  /** Zero-touch retry hook: ask again automatically when the backoff gap expires. */
  _scheduleHistoryRetry(remainingMs) {
    if (this._destroyed) return;
    clearTimeout(this._historyRetryTimer);
    const wait = Math.max(Math.ceil(Number(remainingMs) || 0), 1000);
    console.log(`[WA] Auto history retry scheduled in ${Math.round(wait / 1000)}s (backoff; full history is not skipped)`);
    this._historyRetryTimer = setTimeout(() => {
      this._historyRetryTimer = null;
      if (this._destroyed) return;
      // Skip an already-fulfilled retry: if the archive landed while the timer waited,
      // a soft-reconnect now would just raise one more phone alert for nothing.
      try {
        const cfg = loadCfg(this._configFile);
        if (cfg.initialHistorySyncDone && !cfg.acceptHistoryOnce) {
          console.log('[WA] Auto history retry skipped — full history already synced');
          return;
        }
      } catch { /* proceed */ }
      void this.requestHistoryResync({ auto: true });
    }, wait);
  }
  /** True while Baileys may still send `messaging-history.set` batches (UI may already be READY). */
  get isInitialHistorySync() {
    return isHistorySyncInFlight({
      historySyncStarted: this._historySyncStarted,
      historyDone: this._historyDone,
    });
  }

  async start() {
    if (this._sock || this._destroyed) return;
    // An explicit start supersedes a pending backoff retry — the caller wants a QR now.
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    mkdirSync(this._authDir, { recursive: true });
    await this._connect();
  }

  async logout() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try { await this._sock?.logout(); } catch {}
    this._sock = null;
    this._clearInitialHistorySyncFlag();
    this._setState('DISCONNECTED', 'Logged out');
    this._onDisconnected?.();
  }

  async _resetAuthAndRequestQr(reason = 'Session expired — rescan QR to reconnect') {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._sock = null;
    this._clearQr();
    this._reconnectAttempt = 0;
    this._staleSessionCloseCount = 0;
    try { rmSync(this._authDir, { recursive: true, force: true }); } catch {}
    mkdirSync(this._authDir, { recursive: true });
    this._clearInitialHistorySyncFlag();
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
      return this._noteSuccessfulSend(await this._sock.sendMessage(chatJid, { text: t }, { quoted }));
    }
    return this._noteSuccessfulSend(await this._sock.sendMessage(chatJid, { text: t }));
  }

  /**
   * Relay already succeeded. Baileys still labels the echo PENDING and, in groups,
   * reports later ticks on `message-receipt.update` rather than `messages.update`.
   */
  _noteSuccessfulSend(sent) {
    if (!sent?.key?.id || sent.key.fromMe === false) return sent;
    const next = receiptAfterSuccessfulRelay(sent.status);
    sent.status = next;
    const chatJid = sent.key.remoteJid ? String(sent.key.remoteJid) : '';
    const messageId = String(sent.key.id || '');
    // Index before the HTTP send handler returns so the open chat can reload and see it.
    // Baileys does not always emit a messages.upsert echo for our own sends.
    try {
      const row = this._msgToRow(sent);
      if (row) this._onMessages?.([row]);
    } catch (e) {
      console.warn('[WA] index outbound send:', e?.message || e);
    }
    if (chatJid) {
      process.nextTick(() => {
        try {
          this._onMessageReceipt?.({ chatJid, messageId, receiptStatus: next });
        } catch (e) {
          console.warn('[WA] relay ack:', e?.message || e);
        }
      });
    }
    return sent;
  }

  async sendDocument(chatJid, filePath, {
    fileName = 'document.xlsx',
    mimetype = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    caption = '',
  } = {}) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!chatJid) throw new Error('chatJid required');
    if (!filePath || !existsSync(filePath)) throw new Error('Document file not found');
    return this._noteSuccessfulSend(await this._sock.sendMessage(chatJid, {
      document: readFileSync(filePath),
      fileName: String(fileName || 'document.xlsx').slice(0, 120),
      mimetype,
      caption: String(caption || '').trim() || undefined,
    }));
  }

  async sendFile(chatJid, buffer, { fileName = 'file', mimetype = 'application/octet-stream', caption = '', ptt = false, quotedRow = null } = {}) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!chatJid) throw new Error('chatJid required');
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('File is empty');
    const name = String(fileName || 'file').replace(/[\\/\0]/g, '_').slice(0, 120);
    const rawMime = String(mimetype || 'application/octet-stream').slice(0, 160);
    let effectiveMime = normalizeAudioMime(rawMime) || 'application/octet-stream';
    const inferredAudioMime = inferAudioMimeFromFilename(name);
    const lowerExt = (name.split('.').pop() || '').toLowerCase();
    // Browsers often send missing/generic MIMEs (or video/mp4 / video/webm) for audio files.
    if (
      inferredAudioMime
      && (
        effectiveMime === 'application/octet-stream'
        || !effectiveMime
        || (effectiveMime.startsWith('video/') && lowerExt !== 'mp4')
      )
    ) {
      effectiveMime = inferredAudioMime;
    }
    // Audio-only .mp4 / .webm containers (such as prior recordings or downloaded voice notes)
    // arrive from browsers as video/mp4 or video/webm — reclassify to audio when there is no video track.
    if (effectiveMime.startsWith('video/')) {
      const probed = await probeMediaStreams(buffer, { fileName: name });
      if (probed && probed.hasAudio && !probed.hasVideo) {
        effectiveMime = effectiveMime.includes('webm') ? 'audio/webm' : 'audio/mp4';
      }
    }

    const text = String(caption || '').trim().slice(0, 4000) || undefined;
    let content;
    let mediaType = null;
    let sendBuffer = buffer;
    let sendMime = effectiveMime;
    let extOverride = null;
    if (effectiveMime.startsWith('image/')) {
      content = { image: sendBuffer, mimetype: sendMime, caption: text };
      mediaType = 'image';
    } else if (effectiveMime.startsWith('video/')) {
      content = { video: sendBuffer, mimetype: sendMime, caption: text };
      mediaType = 'video';
    } else if (isAudioMime(effectiveMime)) {
      const prepared = await prepareOutboundAudioForWhatsApp(buffer, {
        mimeType: effectiveMime,
        fileName: name,
        ptt,
      });
      sendBuffer = prepared.buffer;
      sendMime = prepared.mimeType;
      extOverride = prepared.ext;
      const built = audioSendContent(sendBuffer, {
        mimeType: sendMime,
        ptt,
        seconds: prepared.durationSeconds,
        waveform: prepared.waveform,
      });
      if (built.error) throw new Error(built.error);
      content = built.content;
      mediaType = 'audio';
    } else {
      content = { document: sendBuffer, fileName: name, mimetype: sendMime, caption: text };
      mediaType = 'document';
    }
    let quoted = null;
    if (quotedRow) {
      quoted = this._buildQuotedProto(quotedRow, chatJid);
    }
    const sent = await this._sock.sendMessage(chatJid, content, quoted ? { quoted } : undefined);
    // Keep the bytes we just uploaded so Searchable can play/download without
    // waiting on a WhatsApp CDN round-trip (self-chat echoes often skip media).
    const persistedPath = this._writeOutboundMediaFile(sent, chatJid, sendBuffer, {
      mediaType,
      mime: sendMime,
      fileName: name,
      extOverride,
    });
    this._noteSuccessfulSend(sent);
    if (persistedPath && sent?.key?.id) {
      this._onMediaPath?.(String(sent.key.id), persistedPath);
    }
    return sent;
  }

  _rememberOutboundMediaPath(messageId, fullPath) {
    if (!messageId || !fullPath) return;
    const mid = String(messageId);
    if (this._recentOutboundMediaPaths.size >= 200) {
      const firstKey = this._recentOutboundMediaPaths.keys().next().value;
      if (firstKey !== undefined) this._recentOutboundMediaPaths.delete(firstKey);
    }
    this._recentOutboundMediaPaths.set(mid, fullPath);
  }

  _writeOutboundMediaFile(sent, chatJid, buffer, { mediaType, mime, fileName, extOverride } = {}) {
    try {
      const messageId = sent?.key?.id ? String(sent.key.id) : '';
      if (!messageId || !mediaType || !MEDIA_FOR_INDEX.has(mediaType)) return null;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
      const cleanOverride = extOverride ? String(extOverride).replace(/^\./, '').toLowerCase() : '';
      const fromName = extname(String(fileName || '')).slice(1).toLowerCase();
      const ext = cleanOverride
        || (fromName && fromName !== 'bin' && !(mediaType === 'audio' && fromName === 'mp4') ? fromName : null)
        || extFromMime(mime)
        || 'bin';
      const dir = join(config.mediaDir, safeJidDir(chatJid));
      mkdirSync(dir, { recursive: true });
      const fullPath = join(dir, `${messageId}.${ext}`);
      writeFileSync(fullPath, buffer);
      this._rememberOutboundMediaPath(messageId, fullPath);
      return fullPath;
    } catch (e) {
      console.warn('[WA] persist outbound media:', e?.message || e);
      return null;
    }
  }

  /**
   * Write an outbound attach/voice buffer next to inbound media and publish the path.
   * Safe to no-op when the send result has no message id.
   */
  _persistOutboundMediaFile(sent, chatJid, buffer, opts = {}) {
    const fullPath = this._writeOutboundMediaFile(sent, chatJid, buffer, opts);
    if (fullPath && sent?.key?.id) {
      this._onMediaPath?.(String(sent.key.id), fullPath);
    }
    return fullPath;
  }

  /**
   * People you can start / continue a 1:1 chat with from the linked WhatsApp session.
   * Drawn from contact/push-name cache (not the phone OS address book — browsers cannot
   * silently read that). Groups, status, and imports are excluded.
   */
  listMessageableContacts({ limit = 500 } = {}) {
    const out = [];
    const seen = new Set();
    const max = Math.max(1, Math.min(Number(limit) || 500, 2000));
    for (const [jid, name] of this._chatNames.entries()) {
      if (!jid || seen.has(jid)) continue;
      if (isJidGroup(jid) || isImportedChatJid(jid) || isWhatsAppLowPriorityFeed(jid)) continue;
      if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@hosted'))) continue;
      const label = String(name || '').trim();
      if (!label || !isResolvedHumanChatTitle(label, jid)) continue;
      seen.add(jid);
      out.push({
        chatJid: jid,
        chatName: label,
        phone: jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted')
          ? formatPhoneLocalPart(jid.split('@')[0])
          : null,
      });
      if (out.length >= max) break;
    }
    out.sort((a, b) => String(a.chatName).localeCompare(String(b.chatName), undefined, { sensitivity: 'base' }));
    return out;
  }

  /**
   * Create a WhatsApp group. Prefers phone-number JIDs when a LID↔PN mapping exists —
   * Baileys' create call is more reliable with `@s.whatsapp.net` participants.
   * @param {{ subject: string, participantJids: string[] }} input
   */
  async createGroup(input) {
    if (!this._sock?.groupCreate) throw new Error('WhatsApp not connected');
    const normalized = normalizeGroupCreateInput(input);
    if (!normalized.ok) throw new Error(normalized.error);

    const participants = [];
    const seen = new Set();
    for (const jid of normalized.participantJids) {
      let inviteJid = jid;
      try {
        const linked = await this.getLinked1on1Jids(jid);
        const pn = (linked || []).find((x) => x.endsWith('@s.whatsapp.net') || x.endsWith('@hosted'));
        if (pn) inviteJid = pn;
      } catch (_) { /* mapping optional */ }
      if (seen.has(inviteJid)) continue;
      seen.add(inviteJid);
      participants.push(inviteJid);
    }
    if (!participants.length) throw new Error('Add at least one contact to the group');

    const meta = await this._sock.groupCreate(normalized.subject, participants);
    const chatJid = meta?.id || meta?.jid || null;
    if (!chatJid) throw new Error('WhatsApp did not return a group id');
    const subject = meta?.subject || normalized.subject;
    await this._applyDisplayName(chatJid, subject);
    this._onChatsPreview?.([{
      chatJid,
      chatName: subject,
      sidebarTab: 'chat',
      messageCount: 0,
      lastMessageTs: Math.floor(Date.now() / 1000),
      summarizedCount: 0,
      participantCount: participants.length + 1,
    }]);
    return {
      chatJid,
      chatName: subject,
      participantCount: Array.isArray(meta?.participants) ? meta.participants.length : participants.length + 1,
    };
  }

  async resolvePhoneToWhatsAppJid(rawPhone) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    const digits = String(rawPhone || '').replace(/[^\d]/g, '');
    if (digits.length < 8 || digits.length > 15) {
      throw new Error('Enter a full phone number with country code (8–15 digits)');
    }
    const candidates = [digits];
    // Common India shortcut: 10-digit national → try +91
    if (digits.length === 10) candidates.push(`91${digits}`);

    let match = null;
    for (const phone of candidates) {
      try {
        const results = await this._sock.onWhatsApp(phone);
        const hit = Array.isArray(results) ? results.find((r) => r?.exists && r?.jid) : null;
        if (hit) {
          match = {
            exists: true,
            chatJid: jidNormalizedUser(hit.jid) || hit.jid,
            phone: phone,
          };
          break;
        }
      } catch (e) {
        console.warn('[WA] onWhatsApp:', e.message);
      }
    }
    if (!match) {
      return { exists: false, chatJid: null, phone: digits };
    }
    const cached = this._nameFromChatMap(match.chatJid);
    return {
      ...match,
      chatName: cached && isResolvedHumanChatTitle(cached, match.chatJid) ? cached : formatPhoneLocalPart(match.phone),
    };
  }

  getUnreadCount(chatJid) {
    return unreadCountForChat(this._unreadByChat, chatJid);
  }

  /** Snapshot of in-memory WhatsApp unread counts for sidebar overlay. */
  getUnreadCountsMap() {
    return new Map(this._unreadByChat);
  }

  /**
   * Zero live + persisted unread for a chat the user opened in Searchable.
   * Emits `onUnreadCounts` so UIs drop the badge without waiting for WhatsApp.
   */
  clearChatUnread(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return false;
    clearUnreadCount(this._unreadByChat, jid);
    if (typeof this._onUnreadCounts === 'function') {
      try {
        this._onUnreadCounts([{ chatJid: jid, unreadCount: 0 }]);
      } catch (e) {
        console.warn('[WA] onUnreadCounts clear:', e.message);
      }
    }
    return true;
  }

  /**
   * Best-effort WhatsApp mark-as-read so the phone/linked session also clears the badge.
   * Local unread is cleared by {@link clearChatUnread} regardless of this result.
   */
  async markChatRead(chatJid, lastMessageRow) {
    if (!this._sock) return { ok: false, error: 'WhatsApp not connected' };
    const jid = String(chatJid || '').trim();
    if (!jid || isImportedChatJid(jid) || isWhatsAppLowPriorityFeed(jid)) {
      return { ok: true, skipped: true };
    }
    if (!lastMessageRow?.messageId) return { ok: false, error: 'last message required' };
    let ts = Number(lastMessageRow.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) ts = Math.floor(Date.now() / 1000);
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    const fromMe = lastMessageRow.sender === 'You';
    const key = {
      remoteJid: jid,
      id: String(lastMessageRow.messageId),
      fromMe,
    };
    if (!fromMe && jid.endsWith('@g.us')) {
      const participant = String(lastMessageRow.senderJid || '').trim();
      if (!participant) {
        return { ok: false, error: 'group last message missing participant' };
      }
      key.participant = participant;
    }
    try {
      await this._sock.chatModify(
        {
          markRead: true,
          lastMessages: [{ key, messageTimestamp: ts }],
        },
        jid,
      );
      return { ok: true };
    } catch (e) {
      console.warn('[WA] markChatRead:', e?.message || e);
      return { ok: false, error: e?.message || String(e) };
    }
  }

  _captureUnreadCounts(chats) {
    captureUnreadCounts(this._unreadByChat, chats);
    if (typeof this._onUnreadCounts !== 'function') return;
    const updates = [];
    for (const chat of chats || []) {
      if (!chat?.id || !Number.isFinite(chat.unreadCount)) continue;
      updates.push({
        chatJid: String(chat.id),
        unreadCount: Math.max(0, Number(chat.unreadCount)),
      });
    }
    if (updates.length) {
      try { this._onUnreadCounts(updates); } catch (e) {
        console.warn('[WA] onUnreadCounts:', e.message);
      }
    }
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

  /**
   * Delete a message for everyone (WhatsApp revoke). Usually only works for your own
   * messages within WhatsApp's time window.
   */
  async deleteMessageForEveryone(chatJid, row) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!row?.messageId) throw new Error('message row required');
    if (isImportedChatJid(chatJid) || isImportedChatJid(row.chatJid)) {
      throw new Error('Cannot delete-for-everyone on imported chats');
    }
    const key = this._buildReactionKey(row, chatJid);
    return await this._sock.sendMessage(chatJid, { delete: key });
  }

  /**
   * Best-effort "delete for me" on the linked WhatsApp account via chatModify.
   * Local DB deletion is handled by the caller regardless of this result.
   */
  async deleteMessageForMe(chatJid, row) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!row?.messageId) throw new Error('message row required');
    if (isImportedChatJid(chatJid) || isImportedChatJid(row.chatJid)) {
      return { ok: true, skipped: true };
    }
    const fromMe = row.sender === 'You';
    let ts = Number(row.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) ts = Math.floor(Date.now() / 1000);
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    try {
      await this._sock.chatModify(
        {
          clear: {
            messages: [{
              id: String(row.messageId),
              fromMe,
              timestamp: String(ts),
            }],
          },
        },
        chatJid,
      );
      return { ok: true };
    } catch (e) {
      // Local delete still proceeds; WhatsApp clear is best-effort.
      console.warn('[WA] delete for me (chatModify):', e?.message || e);
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * Forward a stored message to another chat. Rebuilds content from DB (+ local media
   * when available) because we do not keep full Baileys message protos.
   */
  async forwardMessage(targetJid, row, { force = true } = {}) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!targetJid) throw new Error('targetJid required');
    if (!row?.messageId) throw new Error('message row required');
    if (isImportedChatJid(targetJid)) throw new Error('Cannot forward to an imported chat');
    if (isWhatsAppLowPriorityFeed(targetJid)) throw new Error('Cannot forward to this chat');

    const mediaPath = row.mediaPath && existsSync(row.mediaPath) ? String(row.mediaPath) : '';
    const caption = String(row.mediaCaption || row.text || '').trim();
    const contextInfo = { isForwarded: true, forwardingScore: force ? 1 : 0 };

    if (mediaPath && row.mediaType === 'image') {
      return this._noteSuccessfulSend(await this._sock.sendMessage(targetJid, {
        image: readFileSync(mediaPath),
        caption: caption || undefined,
        contextInfo,
      }));
    }
    if (mediaPath && row.mediaType === 'video') {
      return this._noteSuccessfulSend(await this._sock.sendMessage(targetJid, {
        video: readFileSync(mediaPath),
        caption: caption || undefined,
        contextInfo,
      }));
    }
    if (mediaPath && row.mediaType === 'audio') {
      const prepared = await prepareOutboundAudioForWhatsApp(readFileSync(mediaPath), {
        fileName: mediaPath,
        ptt: false,
      });
      const built = audioSendContent(prepared.buffer, {
        mimeType: prepared.mimeType,
        ptt: false,
        seconds: prepared.durationSeconds,
      });
      if (built.error) throw new Error(built.error);
      const sent = await this._sock.sendMessage(targetJid, {
        ...built.content,
        contextInfo,
      });
      const persistedPath = this._writeOutboundMediaFile(sent, targetJid, prepared.buffer, {
        mediaType: 'audio',
        mime: prepared.mimeType,
        fileName: mediaPath,
        extOverride: prepared.ext,
      });
      this._noteSuccessfulSend(sent);
      if (persistedPath && sent?.key?.id) {
        this._onMediaPath?.(String(sent.key.id), persistedPath);
      }
      return sent;
    }
    if (mediaPath && row.mediaType === 'sticker') {
      return this._noteSuccessfulSend(await this._sock.sendMessage(targetJid, {
        sticker: readFileSync(mediaPath),
        contextInfo,
      }));
    }
    if (mediaPath && row.mediaType === 'document') {
      const name = String(row.mediaCaption || row.text || 'document').trim() || 'document';
      return this._noteSuccessfulSend(await this._sock.sendMessage(targetJid, {
        document: readFileSync(mediaPath),
        mimetype: 'application/octet-stream',
        fileName: name.slice(0, 120),
        caption: caption || undefined,
        contextInfo,
      }));
    }

    // Text / missing media: forward via a minimal reconstructed WAMessage.
    let snippet = String(row.text || row.mediaCaption || '').trim();
    if (!snippet) {
      snippet = row.mediaType ? `[${row.mediaType}]` : '';
    }
    if (!snippet) throw new Error('Nothing to forward');

    const fromMe = row.sender === 'You';
    const sourceJid = row.chatJid || targetJid;
    const key = {
      remoteJid: sourceJid,
      id: row.messageId,
      fromMe,
    };
    if (isJidGroup(sourceJid) && !fromMe && row.senderJid) {
      key.participant = jidNormalizedUser(row.senderJid);
    }
    const msg = {
      key,
      message: { conversation: snippet.slice(0, 65536) },
    };
    try {
      return this._noteSuccessfulSend(await this._sock.sendMessage(targetJid, { forward: msg, force: !!force }));
    } catch (e) {
      // Fallback: plain send marked as forwarded.
      return this._noteSuccessfulSend(await this._sock.sendMessage(targetJid, {
        text: snippet,
        contextInfo,
      }));
    }
  }

  /** Edit your own text message in place. */
  async editMessage(chatJid, row, newText) {
    if (!this._sock) throw new Error('WhatsApp not connected');
    if (!row?.messageId) throw new Error('message row required');
    if (row.sender !== 'You') throw new Error('You can only edit your own messages');
    const t = String(newText || '').trim();
    if (!t) throw new Error('text required');
    if (isImportedChatJid(chatJid) || isImportedChatJid(row.chatJid)) {
      throw new Error('Cannot edit imported chat messages on WhatsApp');
    }
    const key = this._buildReactionKey(row, chatJid);
    return await this._sock.sendMessage(chatJid, { text: t, edit: key });
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
    if (row.mediaType === 'image') {
      return {
        key,
        message: { imageMessage: { caption: snippet !== '[image]' ? snippet : '' } },
      };
    }
    return {
      key,
      message: { conversation: snippet.slice(0, 1024) },
    };
  }

  _buildQuotedPayloadFromInner(inner, fallbackChatJid, msg) {
    if (!inner || typeof inner !== 'object') return null;
    let contextInfo = null;
    for (const k of Object.keys(inner)) {
      const val = inner[k];
      if (val && typeof val === 'object' && val.contextInfo) {
        contextInfo = val.contextInfo;
        break;
      }
    }
    if (!contextInfo && inner.contextInfo) {
      contextInfo = inner.contextInfo;
    }
    if (!contextInfo || !contextInfo.stanzaId) return null;

    const stanzaId = String(contextInfo.stanzaId);
    const participant = contextInfo.participant ? String(contextInfo.participant) : null;
    const qMsg = contextInfo.quotedMessage;

    let sender = null;
    if (participant) {
      if (this._ownerJid && (participant === this._ownerJid || jidNormalizedUser(participant) === jidNormalizedUser(this._ownerJid))) {
        sender = 'You';
      } else {
        sender = (typeof this.getSenderDisplayNameFast === 'function' ? this.getSenderDisplayNameFast(participant) : null)
          || (typeof this._nameFromChatMap === 'function' ? this._nameFromChatMap(participant) : null)
          || (participant.includes('@') ? formatPhoneLocalPart(participant.split('@')[0]) : null)
          || 'Contact';
      }
    } else if (msg?.key?.fromMe) {
      sender = 'You';
    }

    if (!qMsg) {
      return {
        messageId: stanzaId,
        sender,
        senderJid: participant,
      };
    }

    const peeledQ = peelNestedMessage(qMsg);
    const qContent = extractMessageContent(peeledQ) || peeledQ;
    let text = extractTextFromInner(qContent) || '';
    let mediaType = null;
    let thumbData = null;

    if (qContent?.imageMessage) {
      mediaType = 'image';
      if (!text && qContent.imageMessage.caption) text = qContent.imageMessage.caption;
      if (qContent.imageMessage.jpegThumbnail) {
        const rawThumb = qContent.imageMessage.jpegThumbnail;
        const buf = Buffer.isBuffer(rawThumb)
          ? rawThumb
          : typeof rawThumb === 'string'
            ? Buffer.from(rawThumb, 'base64')
            : Buffer.from(rawThumb);
        if (buf.length > 0) {
          thumbData = `data:image/jpeg;base64,${buf.toString('base64')}`;
        }
      }
    } else if (qContent?.videoMessage) {
      mediaType = 'video';
      if (!text && qContent.videoMessage.caption) text = qContent.videoMessage.caption;
      if (qContent.videoMessage.jpegThumbnail) {
        const rawThumb = qContent.videoMessage.jpegThumbnail;
        const buf = Buffer.isBuffer(rawThumb)
          ? rawThumb
          : typeof rawThumb === 'string'
            ? Buffer.from(rawThumb, 'base64')
            : Buffer.from(rawThumb);
        if (buf.length > 0) {
          thumbData = `data:image/jpeg;base64,${buf.toString('base64')}`;
        }
      }
    } else if (qContent?.documentMessage) {
      mediaType = 'document';
      if (!text) text = qContent.documentMessage.fileName || qContent.documentMessage.caption || 'Document';
    } else if (qContent?.audioMessage) {
      mediaType = 'audio';
      if (!text) text = qContent.audioMessage.ptt ? 'Voice message' : 'Audio';
    } else if (qContent?.stickerMessage) {
      mediaType = 'sticker';
      if (qContent.stickerMessage.pngThumbnail) {
        const rawThumb = qContent.stickerMessage.pngThumbnail;
        const buf = Buffer.isBuffer(rawThumb)
          ? rawThumb
          : typeof rawThumb === 'string'
            ? Buffer.from(rawThumb, 'base64')
            : Buffer.from(rawThumb);
        if (buf.length > 0) {
          thumbData = `data:image/png;base64,${buf.toString('base64')}`;
        }
      }
    }

    return {
      messageId: stanzaId,
      sender,
      senderJid: participant,
      text: text ? String(text).slice(0, 300) : null,
      mediaType,
      thumbData,
    };
  }

  async destroy() {
    this._destroyed = true;
    clearTimeout(this._flushTimer);
    clearTimeout(this._liveFlushTimer);
    this._liveFlushTimer = null;
    clearTimeout(this._syncDoneTimer);
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._historyRetryTimer);
    clearTimeout(this._phoneInflightTimer);
    this._reconnectTimer = null;
    this._historyRetryTimer = null;
    this._phoneInflightTimer = null;
    for (const queue of this._mediaQueues.values()) queue.length = 0;
    this._queuedMediaIds.clear();
    this._failedMediaDownloads.clear();
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

  /**
   * Reopen the socket after a close.
   *
   * @param {boolean} qrExpired A pairing QR ran out. There is no session to protect and a
   *   new code can only come from a new socket, so retry promptly — backing off here is
   *   what leaves the QR panel blank for progressively longer on each retry.
   */
  _scheduleReconnect(qrExpired) {
    const attempt = this._reconnectAttempt;
    this._reconnectAttempt = qrExpired ? 0 : Math.min(attempt + 1, 12);
    const delayMs = reconnectDelayMs({ hasCreds: !qrExpired, attempt });
    if (qrExpired) {
      console.log('[WA] QR expired — requesting a fresh one');
      this._setState('LOADING', 'Refreshing QR code…');
    } else {
      console.log(`[WA] Reconnect in ${Math.round(delayMs / 1000)}s (attempt ${this._reconnectAttempt})`);
      this._setState('LOADING', `Reconnecting in ${Math.round(delayMs / 1000)}s…`);
    }
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      void this._connect();
    }, delayMs);
  }

  async _buildSocket() {
    if (this._destroyed) return;
    // Each socket gets its own ref list, so QR lifetimes restart at the longer first TTL.
    this._qrIndex = 0;

    const { state: authState, saveCreds } = await useMultiFileAuthState(this._authDir);
    if (this._destroyed) return;
    if (this._sock) return;

    const priorCfg = loadCfg(this._configFile);
    // One-shot FULL history (recovery). Keep the flag until a history batch arrives so
    // conflict/reconnect loops do not permanently skip the phone archive.
    //
    // Important: do NOT auto-flip `initialHistorySyncDone` here when creds exist.
    // After a QR scan Baileys reconnects with saved creds while the flag is still
    // false — treating that as “already synced” skipped the entire archive (empty chats).
    let syncFullHistoryOnce = false;
    const isInitialSync = !priorCfg.initialHistorySyncDone;
    const isExplicitResync = Boolean(priorCfg.acceptHistoryOnce) || this._forceFullHistoryOnce === true;

    if (isExplicitResync || isInitialSync) {
      syncFullHistoryOnce = true;
    }
    // Paced acceptance: user-initiated resyncs and initial pairings always run immediately;
    // automated zero-touch retries wait out the backoff gap first, then retry automatically.
    // Initial sync and explicit user resyncs must NEVER be held back by backoff.
    const forcedByUser = this._forceFullHistoryOnce === true || isExplicitResync || isInitialSync;
    const waitingMs = forcedByUser ? 0 : this._fullHistoryRemainingWaitMs(priorCfg);
    if (waitingMs > 0) {
      this._acceptPhoneHistorySync = false;
      syncFullHistoryOnce = false;
      console.warn(`[WA] Holding phone history request ${Math.round(waitingMs / 1000)}s (pacing recent sync attempts — no repeat alert storm)`);
      this._scheduleHistoryRetry(waitingMs);
    } else if (isExplicitResync) {
      this._forceFullHistoryOnce = false;
      this._acceptPhoneHistorySync = true;
      syncFullHistoryOnce = true;
      console.log('[WA] Accepting phone history sync (one-shot FULL resync)');
    } else if (isInitialSync) {
      this._forceFullHistoryOnce = false;
      this._acceptPhoneHistorySync = true;
      syncFullHistoryOnce = true;
      console.log('[WA] Accepting phone history sync (initial / recovery)');
    } else {
      this._acceptPhoneHistorySync = false;
    }
    let version = [2, 3000, 1015901307];
    try {
      // Bounded fetch: this HTTPS call has no timeout inside Baileys, and DNS/TCP
      // stalls would hang startup before the socket is ever created (log stuck at
      // the WA_SYNC separator with no "Baileys — WA version" line). 8s cap, then
      // fall back to the bundled version — a stale version still connects fine.
      version = await Promise.race([
        fetchLatestBaileysVersion().then((v) => v.version),
        new Promise((_, reject) => setTimeout(() => reject(new Error('version fetch timeout')), 8000)),
      ]).catch(() => version);
    } catch {}
    console.log(`[WA] Baileys — WA version ${version.join('.')}`);
    this._setState('LOADING', 'Connecting to WhatsApp…');

    const wantFullHistory = Boolean(config.waSyncFullHistory || syncFullHistoryOnce);
    this._sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      auth: authState,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      // Keep the linked-device WebSocket warm the way WhatsApp Web does.
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      syncFullHistory: wantFullHistory,
      // One history acceptance per linked account. Reconnects decline so the phone
      // does not raise “syncing with WhatsApp Search” on every socket drop.
      shouldSyncHistoryMessage: (msg) => shouldSyncHistoryMessage(msg, {
        syncFullHistory: wantFullHistory,
        initialHistorySyncDone: !this._acceptPhoneHistorySync,
      }),
      /**
       * Linked-device label on your phone (Settings → Linked devices).
       * Do **not** use "Chrome" here — WhatsApp surfaces that in OS notifications as
       * "syncing with Google Chrome" even though this is the Node/Baileys client, not web.whatsapp.com.
       * Also keep "WhatsApp Search" (avoid 'Mac OS' which maps to DARWIN and causes WhatsApp servers to drop with 428).
       */
      browser: ['WhatsApp Search', 'Desktop', '1.0.0'],
    });

    this._sock.ev.on('creds.update', saveCreds);

    // ── Connection state ──────────────────────────────────────────────────
    this._sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 300 });
          this._latestQr = dataUrl;
          this._qrIssuedAt = Date.now();
          this._qrTtlMs = qrTtlMsForIndex(this._qrIndex);
          this._qrIndex += 1;
          this._setState('QR_READY', 'Scan with WhatsApp');
          this._onQr?.(dataUrl);
          console.log(`[WA] QR ready — open ${publicWebBaseUrl()} to scan`);
        } catch (e) { console.error('[WA] QR error:', e.message); }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const boomMsg = lastDisconnect?.error?.message || '';
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        const badSession = code === DisconnectReason.badSession || code === 500;
        const staleSessionClose = code === DisconnectReason.connectionLost
          || code === DisconnectReason.connectionClosed
          || code === DisconnectReason.timedOut;
        // Baileys ends the socket with `timedOut` once it runs out of QR refs, which is the
        // same code a dropped session reports. Only read it as "the QR expired, get
        // another" when this socket really was on the pairing screen: a close before any QR
        // means WhatsApp is unreachable and still deserves backoff, and `restartRequired`
        // after a successful scan must keep its existing path so freshly saved credentials
        // have time to reach disk.
        const qrExpired = staleSessionClose && !this.hasSavedCreds && this._qrIndex > 0;
        const immediate = isImmediateReconnectCode(code) || qrExpired;
        console.log(`[WA] Closed — code=${code}, loggedOut=${loggedOut}${boomMsg ? ` — ${boomMsg}` : ''}`);
        this._sock = null;
        // Whatever QR this socket showed died with it; serving it again just gives the
        // user a code their phone silently refuses.
        this._clearQr();
        // No socket means no history is arriving. Reopen the indexing gate for the whole
        // disconnect / reconnect-backoff window; `connection: 'open'` closes it again.
        this._historySyncStarted = false;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        if (this._suppressReconnectOnce) {
          this._suppressReconnectOnce = false;
          console.log('[WA] Close ignored for intentional history resync');
          return;
        }
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
        } else if (badSession) {
          // Corrupt local keys — only case besides logout where wiping auth is correct.
          console.log('[WA] Bad session — clearing auth and requesting fresh QR');
          await this._resetAuthAndRequestQr('Session invalid — generating a new QR…');
        } else if (staleSessionClose) {
          // Network blips / QR-ref expiry: keep credentials (WhatsApp Web behaviour).
          this._staleSessionCloseCount += 1;
          if (shouldResetAuthAfterStaleCloses({
            hasCreds: this.hasSavedCreds,
            staleCloseCount: this._staleSessionCloseCount,
          })) {
            // Defensive: policy currently never wipes; reconnect with saved auth instead.
            console.warn(`[WA] Stale disconnect #${this._staleSessionCloseCount} — keeping session and reconnecting`);
          }
          this._scheduleReconnect(immediate);
        } else {
          this._staleSessionCloseCount = 0;
          this._scheduleReconnect(immediate);
        }
      }

      if (connection === 'open') {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        this._reconnectAttempt = 0;
        this._staleSessionCloseCount = 0;
        this._clearQr();
        this._lastSyncingUiAt = 0;
        const user = this._sock.user;
        const name = user?.name || user?.verifiedName || user?.id?.split(':')[0] || 'unknown';
        this._ownerName = name || null;
        this._ownerJid = user?.id ? jidNormalizedUser(user.id) : null;
        console.log(`[WA] ✅ Connected as ${name}`);
        this._onReady?.({ name, phone: this._ownerJid?.split('@')[0] });
        this._setState('SYNCING', 'Loading chat history…');
        if (this._acceptPhoneHistorySync && this.hasSavedCreds) {
          const cfg = loadCfg(this._configFile);
          this._recordFullHistoryRequest(cfg);
        }
        // Titles first: publish a named chat list before messages stream in. Deliberately
        // not awaited — history ingestion must not wait on it.
        void this.hydrateGroupTitlesForUi();
        this._historyDone = false;
        this._avatarEpoch += 1;
        this._avatarQueue = [];
        this._avatarQueued = new Set();
        this._historySyncStarted = true;
        this._pendingHistoryRows = 0;
        this._finishSyncRequested = false;
        this._totalMsgs = 0;
        this._historyEventsSeen = 0;
        this._historyProgress = null;
        this._uiPromotedAfterFirstHistoryBatch = false;

        // While accepting phone history, wait longer — marking “done” too early permanently
        // skips later batches and leaves chats empty (seen after re-link).
        const fallbackMs = this._acceptPhoneHistorySync
          ? Math.max(config.waSyncDoneDelayMs, 90_000)
          : Math.max(config.waSyncDoneDelayMs, 25_000);
        this._armSyncDoneTimer(fallbackMs);
      }
    });

    // ── Real-time messages ────────────────────────────────────────────────
    // Baileys uses type `notify` for live traffic and `append` for offline/queued sync — both must be indexed
    // or the DB stops updating (e.g. everything stuck on the last day the socket saw only `append` events).
    this._sock.ev.on('messages.upsert', async ({ messages, type }) => {
      const rows = [];
      for (const msg of messages) {
        const jid = msg.key.remoteJid;
        if (!jid || !msg.message) continue;

        // Catch reactionMessage frames in upsert (fallback in case messages.reaction was not emitted)
        const inner = resolveInnerContent(msg.message);
        if (inner?.reactionMessage) {
          const rx = inner.reactionMessage;
          const target = rx.key;
          const emoji = rx.text != null ? String(rx.text) : '';
          const reactionMsgId = msg.key?.id ? String(msg.key.id) : '';
          if (target?.remoteJid && target?.id && reactionMsgId) {
            this._onReaction?.({
              chatJid: target.remoteJid,
              messageId: String(target.id),
              emoji,
              reactionMsgId,
              groupingKey: rx.groupingKey != null ? String(rx.groupingKey) : '',
              reactionKey: msg.key || null,
              senderTimestampMs: rx.senderTimestampMs || null,
            });
          }
        }

        const row = this._msgToRow(msg);
        if (!row) continue;
        // Save searchable text immediately. Media is intentionally queued behind the
        // initial history insert so network/file work cannot hold up live messages.
        rows.push(row);
        // Auto-download only live `notify` traffic (and recent `append` catch-up).
        // Bulk history keeps stubs in SQLite; opening a chat must not start a media storm —
        // user Retry / “Load messages & media” re-queues explicitly.
        if (this._shouldAutoDownloadMedia(type, row)) {
          this._queueMediaDownload(msg, row);
        }
      }
      if (rows.length) {
        this._enqueueBatch(rows);
        if (type !== 'append') {
          // Debounce rapid live message bursts (e.g. active group chat traffic) by 40ms to avoid single-row WAL lock thrash,
          // while flushing immediately if queue builds up (>= 25 items).
          if (this._pendingBatch.length >= 25) {
            this._flushPendingBatch();
          } else if (!this._liveFlushTimer) {
            this._liveFlushTimer = setTimeout(() => {
              this._liveFlushTimer = null;
              this._flushPendingBatch();
            }, 40);
          }
        } else if (rows.length <= 20) {
          this._flushPendingBatch();
        }
        this._promoteUiWhileHistoryContinues();
      }
      // Name cross-linking can touch the Signal store; it must not delay the DB-visible row.
      void this._backfillLidPnChatNamesFromMessages(messages || []);
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
          senderTimestampMs: reactionBody.senderTimestampMs || null,
        });
      }
    });

    /**
     * Revokes ("delete for everyone") and in-place edits arrive as messages.update
     * after Baileys unwraps protocolMessage frames.
     */
    this._sock.ev.on('message-receipt.update', (updates) => {
      for (const update of updates || []) {
        const receipt = receiptFromGroupReceipt(update);
        if (!receipt) continue;
        try {
          this._onMessageReceipt?.(receipt);
        } catch (e) {
          console.warn('[WA] onMessageReceipt:', e?.message || e);
        }
      }
    });

    this._sock.ev.on('messages.update', (updates) => {
      for (const u of updates || []) {
        const key = u?.key;
        const update = u?.update || {};
        if (!key?.remoteJid || !key?.id) continue;
        const chatJid = String(key.remoteJid);
        const messageId = String(key.id);

        if (update.status != null && key.fromMe) {
          const receiptStatus = normalizeReceiptStatus(update.status);
          if (receiptStatus != null) {
            try {
              this._onMessageReceipt?.({ chatJid, messageId, receiptStatus });
            } catch (e) {
              console.warn('[WA] onMessageReceipt:', e?.message || e);
            }
          }
        }

        const stub = update.messageStubType;
        const isRevoke = update.message === null
          || stub === 1
          || stub === 'REVOKE';
        if (isRevoke) {
          try {
            this._onMessageRevoked?.({ chatJid, messageId });
          } catch (e) {
            console.warn('[WA] onMessageRevoked:', e?.message || e);
          }
          continue;
        }

        const editedInner = update.message?.editedMessage?.message
          || update.message?.protocolMessage?.editedMessage
          || null;
        const contentInner = editedInner
          || (update.message ? resolveInnerContent(update.message) : null);
        if (contentInner) {
          const text = extractTextFromInner(contentInner);
          if (text) {
            try {
              this._onMessageEdited?.({ chatJid, messageId, text });
            } catch (e) {
              console.warn('[WA] onMessageEdited:', e?.message || e);
            }
          }
        }
      }
    });

    // ── History sync (fires in one or more batches) ───────────────────────
    this._sock.ev.on('messaging-history.set', async ({ chats, messages, contacts, progress, syncType }) => {
      const isOnDemand = Number(syncType) === HISTORY_SYNC_TYPE_ON_DEMAND;
      const reported = Number(progress);
      if (progress != null && Number.isFinite(reported)) {
        // Batches can arrive out of order; never let the bar move backwards.
        this._historyProgress = Math.max(this._historyProgress ?? 0, Math.min(100, Math.max(0, reported)));
        this._emitSyncProgress();
      }
      try {
        // Parallelize name hydrate — sequential awaits on large first syncs delayed every
        // history batch before rows could reach SQLite (live upserts already fire-and-forget LID work).
        const nameTasks = [];
        for (const c of (chats || [])) {
          const label = c.name;
          if (!label) continue;
          nameTasks.push(this._applyLabelToLinkedJids(label, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber));
        }
        for (const c of (contacts || [])) {
          const label = c.name || c.fullName || c.notify || c.verifiedName;
          if (!label) continue;
          nameTasks.push(this._applyLabelToLinkedJids(label, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber));
        }
        if (nameTasks.length) await Promise.all(nameTasks);
      } catch (e) {
        console.warn('[WA] history name hydrate:', e.message);
      }

      this._historyEventsSeen = (this._historyEventsSeen || 0) + 1;
      const onceCfg = loadCfg(this._configFile);
      if (onceCfg.acceptHistoryOnce) {
        const next = { ...onceCfg };
        delete next.acceptHistoryOnce;
        saveCfg(this._configFile, next);
      }
      this._captureUnreadCounts(chats);
      this._publishChatRoster(chats);
      console.log(`[WA] History event: ${chats?.length || 0} chats, ${messages?.length || 0} msgs${isOnDemand ? ' (on-demand)' : ''}`);

      // Match live `messages.upsert`: do not block history inserts on LID↔PN name backfill.
      void this._backfillLidPnChatNamesFromMessages(messages || []);

      const historyMsgs = [];
      for (const m of messages || []) historyMsgs.push(m);
      for (const c of chats || []) {
        for (const wrap of c.messages || []) {
          const inner = wrap?.message || wrap;
          if (inner?.key) historyMsgs.push(inner);
        }
      }

      for (const m of historyMsgs) {
        const jid = m.key?.remoteJid;
        if (!jid || !m.message) continue;
        this._syncByChat.set(jid, (this._syncByChat.get(jid) || 0) + 1);
      }

      const rows = [];
      const seenIds = new Set();
      for (const msg of historyMsgs) {
        if (!msg.message || !msg.key?.remoteJid) continue;
        const dedupe = `${msg.key.remoteJid}|${msg.key.id}`;
        if (seenIds.has(dedupe)) continue;
        seenIds.add(dedupe);
        const row = this._msgToRow(msg);
        if (!row) continue;
        rows.push(row);
        // History dump: persist download stubs only. Do not pull media until the user
        // opens Retry / Load messages & media for that chat (avoids open→download storms).
      }

      const finishOnDemand = () => {
        if (!isOnDemand) return;
        const targetChat = this._phoneHistory?.inflight?.chatJid || null;
        if (this._phoneHistory?.inflight) {
          this._phoneHistory.inflight = null;
        }
        clearTimeout(this._phoneInflightTimer);
        this._phoneInflightTimer = null;
        if (this._historyDone) {
          this._requeuePersistedPendingMedia(targetChat, null);
          void this._drainMediaQueue().catch(() => {});
        }
        this._notifySyncActivity();
      };

      if (rows.length) {
        // `waHistoryKeepDays` <= 0 (default) stores the entire archive the phone sends —
        // this dump is the only bulk source of months-old messages. A positive value
        // sheds rows older than N days instead (load-shedding for very large accounts).
        const { keep: kept, skipped } = filterRowsByRetention(rows, { keepDays: config.waHistoryKeepDays });
        if (kept.length) {
          this._ingestHistoryRowsChunked(kept, { onComplete: finishOnDemand });
          console.log(`[WA] History batch queued: ${kept.length} msgs`
            + (skipped ? ` (skipped ${skipped} older than ${config.waHistoryKeepDays}d)` : ''));
        } else {
          finishOnDemand();
          console.log(`[WA] History batch had ${rows.length} msgs, all outside the ${config.waHistoryKeepDays}d retention window`);
        }
      } else {
        finishOnDemand();
      }

      // Reset the "done" timer — no more batches for waSyncDoneDelayMs → mark ready
      this._armSyncDoneTimer(config.waSyncDoneDelayMs);
    });

    // Chat / contact name updates
    this._sock.ev.on('chats.set', async ({ chats }) => {
      this._captureUnreadCounts(chats);
      this._publishChatRoster(chats);
      this._ingestEmbeddedChatMessages(chats);
      await Promise.all(
        (chats || [])
          .filter((c) => c?.name)
          .map((c) => this._applyLabelToLinkedJids(c.name, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber)),
      );
    });
    this._sock.ev.on('chats.upsert', async (chats) => {
      this._captureUnreadCounts(chats);
      this._publishChatRoster(chats);
      this._ingestEmbeddedChatMessages(chats);
      await Promise.all(
        (chats || [])
          .filter((c) => c?.name)
          .map((c) => this._applyLabelToLinkedJids(c.name, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber)),
      );
    });
    this._sock.ev.on('chats.update', async (updates) => {
      this._captureUnreadCounts(updates);
      this._publishChatRoster(updates);
      this._ingestEmbeddedChatMessages(updates);
      await Promise.all(
        (updates || [])
          .filter((u) => u?.name)
          .map((u) => this._applyLabelToLinkedJids(u.name, u.id, u.lidJid, u.pnJid, u.lid, u.phoneNumber)),
      );
    });
    this._sock.ev.on('contacts.set', async ({ contacts }) => {
      await Promise.all((contacts || []).map((c) => this._ingestContact(c)));
    });
    this._sock.ev.on('contacts.upsert', async (contacts) => {
      await Promise.all((contacts || []).map((c) => this._ingestContact(c)));
    });
    this._sock.ev.on('contacts.update', async (contacts) => {
      await Promise.all((contacts || []).map((c) => this._ingestContact(c)));
    });
  }

  _setChatNameIfBetter(jid, label) {
    if (!jid || !label) return null;
    const s = String(label).trim();
    if (!s || looksLikeUrlOrSocialJunk(s) || looksLikeOpaqueNumericId(s)) return null;
    const existing = this._chatNames.get(jid);
    if (existing && isResolvedHumanChatTitle(existing, jid) && !isResolvedHumanChatTitle(s, jid)) {
      return existing;
    }
    if (this._resolvedContactTitles) this._resolvedContactTitles.delete(jid);
    this._chatNames.set(jid, s);
    return s;
  }

  async _applyDisplayName(jid, label) {
    const best = this._setChatNameIfBetter(jid, label);
    if (!best) return;
    await this._mirrorDisplayNameAcrossJids(jid, best);
    if (isResolvedHumanChatTitle(best, jid)) {
      try { this._onResolvedDisplayName?.(jid, best); } catch (_) { /* persist is best-effort */ }
    }
    if (!isUpgradeableSenderName(best) && best !== 'You') {
      try { this._onResolvedSenderName?.(jid, best); } catch (_) {}
    }
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
    const tasks = [];
    for (const jid of jids) {
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      tasks.push(this._applyDisplayName(jid, s));
    }
    if (tasks.length) await Promise.all(tasks);
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
   * Baileys auth directory contains lid-mapping-* files persisting the phone ↔ LID link.
   * Pre-load them synchronously on startup so sender resolution works immediately.
   */
  _preloadLidMappingsFromAuthDir() {
    try {
      if (!this._authDir || !existsSync(this._authDir)) return;
      const files = readdirSync(this._authDir);
      for (const f of files) {
        if (!f.startsWith('lid-mapping-') || !f.endsWith('.json')) continue;
        const full = join(this._authDir, f);
        const raw = readFileSync(full, 'utf8');
        const val = JSON.parse(raw);
        if (typeof val !== 'string' || !val) continue;
        if (f.endsWith('_reverse.json')) {
          const lidDigits = f.replace(/^lid-mapping-/, '').replace(/_reverse\.json$/, '');
          const lidJid = `${lidDigits}@lid`;
          const pnJid = `${val}@s.whatsapp.net`;
          this._lidToPn.set(lidJid, pnJid);
          this._pnToLid.set(pnJid, lidJid);
        } else {
          const pnDigits = f.replace(/^lid-mapping-/, '').replace(/\.json$/, '');
          const pnJid = `${pnDigits}@s.whatsapp.net`;
          const lidJid = `${val}@lid`;
          this._pnToLid.set(pnJid, lidJid);
          this._lidToPn.set(lidJid, pnJid);
        }
      }
    } catch (e) {
      console.warn('[WA] Preloading LID mappings:', e.message);
    }
  }

  _ingestAllGroupParticipants(allGroups, db = null) {
    if (!allGroups || typeof allGroups !== 'object') return;
    const values = Array.isArray(allGroups) ? allGroups : Object.values(allGroups);
    for (const group of values) {
      if (group && typeof group === 'object') {
        this._ingestGroupParticipants(group, db);
      }
    }
  }

  _ingestGroupParticipants(metadata, db = null) {
    if (!metadata?.participants || !Array.isArray(metadata.participants)) return;
    const sock = this._sock;
    const lm = sock?.signalRepository?.lidMapping;
    for (const p of metadata.participants) {
      const lid = p?.lid ? jidNormalizedUser(p.lid) : null;
      const id = p?.id ? jidNormalizedUser(p.id) : null;
      const rawPn = p?.phoneNumber ? String(p.phoneNumber).trim() : '';
      const pn = rawPn
        ? jidNormalizedUser(rawPn.includes('@') ? rawPn : `${rawPn}@s.whatsapp.net`)
        : (id && isPnUser(id) ? id : null);
      const actualLid = lid || (id && isLidUser(id) ? id : null);

      if (actualLid && pn) {
        this._lidToPn.set(actualLid, pn);
        this._pnToLid.set(pn, actualLid);
        if (lm?.storeLIDPNMapping) {
          try { lm.storeLIDPNMapping(actualLid, pn); } catch (_) {}
        }
      }

      const name = p?.name || p?.fullName || p?.verifiedName || p?.notify || p?.pushName || p?.username;
      if (name && !isPlaceholderSenderName(name)) {
        const savedLid = actualLid ? (this._setChatNameIfBetter(actualLid, name) || name) : null;
        const savedPn = pn ? (this._setChatNameIfBetter(pn, name) || name) : null;
        const bestName = [savedLid, savedPn, String(name).trim()]
          .find((cand) => cand && !isUpgradeableSenderName(cand))
          || String(name).trim();
        if (db && typeof db.backfillSenderName === 'function' && bestName && bestName !== 'You') {
          const targets = [actualLid, pn].filter(Boolean);
          try { db.backfillSenderName(targets, bestName); } catch (_) {}
        }
      }
    }
  }

  _collectKnownLinkedJids(norm) {
    if (!norm) return [];
    const set = new Set([norm]);
    if (isLidUser(norm)) {
      const pn = this._lidToPn.get(norm);
      if (pn) {
        set.add(pn);
        const rev = this._pnToLid.get(pn);
        if (rev) set.add(rev);
      }
    } else if (isPnUser(norm) || norm.endsWith('@hosted')) {
      const lid = this._pnToLid.get(norm);
      if (lid) {
        set.add(lid);
        const rev = this._lidToPn.get(lid);
        if (rev) set.add(rev);
      }
    }
    return [...set];
  }

  /** Fast synchronous lookup for sender display name (no async/disk overhead). */
  getSenderDisplayNameFast(senderJid) {
    if (!senderJid) return null;
    const norm = jidNormalizedUser(senderJid);
    const linked = this._collectKnownLinkedJids(norm);

    // 1. Prefer any non-upgradeable human contact/push name across linked LID <-> PN keys
    for (const j of linked) {
      const c = this._chatNames.get(j);
      if (c && !isUpgradeableSenderName(c) && !looksLikeUnusableChatTitle(c)) return c;
    }

    // 2. Fallback to any non-placeholder name (e.g. formatted phone) across linked keys
    for (const j of linked) {
      const c = this._chatNames.get(j);
      if (c && !isPlaceholderSenderName(c) && !looksLikeUnusableChatTitle(c)) return c;
    }

    // 3. Fallback to formatted PN if this is a LID with a known PN mapping
    for (const j of linked) {
      if (isPnUser(j) || j.endsWith('@hosted')) {
        const formatted = formatPhoneLocalPart(j.split('@')[0]);
        if (formatted) return formatted;
      }
    }
    return null;
  }

  /** Resolves human-readable sender name using Signal LID↔PN mapping, pushNames, and SQLite. */
  async resolveSenderDisplayName(senderJid, db = null) {
    if (!senderJid) return null;
    const norm = jidNormalizedUser(senderJid);

    // 1. Fast human hit in cache
    const fast = this.getSenderDisplayNameFast(norm);
    if (fast && !isUpgradeableSenderName(fast)) return fast;

    // 2. Query Baileys signalRepository in both directions (LID → PN and PN → LID)
    const lm = this._sock?.signalRepository?.lidMapping;
    let pn = isPnUser(norm) || norm.endsWith('@hosted') ? norm : this._lidToPn.get(norm) || null;
    let lid = isLidUser(norm) ? norm : this._pnToLid.get(norm) || null;
    if (lm) {
      try {
        if (!pn && lid) {
          const rawPn = await lm.getPNForLID(lid);
          if (rawPn) {
            pn = jidNormalizedUser(rawPn);
            this._lidToPn.set(lid, pn);
            this._pnToLid.set(pn, lid);
          }
        }
        if (!lid && pn) {
          let rawLid = null;
          if (typeof lm.getLIDForPN === 'function') {
            rawLid = await lm.getLIDForPN(pn).catch(() => null);
          }
          if (!rawLid && typeof lm.getLIDsForPNs === 'function') {
            const list = await lm.getLIDsForPNs([pn]).catch(() => null);
            rawLid = list?.[0]?.lid || null;
          }
          if (rawLid) {
            lid = jidNormalizedUser(rawLid);
            this._pnToLid.set(pn, lid);
            this._lidToPn.set(lid, pn);
          }
        }
      } catch (_) {}
    }

    // 3. Check cached names across linked JIDs for a human title
    const candidates = [...new Set([norm, pn, lid].filter(Boolean))];
    for (const cand of candidates) {
      const cached = this._chatNames.get(cand);
      if (cached && !isUpgradeableSenderName(cached) && !looksLikeUnusableChatTitle(cached)) {
        for (const t of candidates) this._setChatNameIfBetter(t, cached);
        return cached;
      }
    }

    // 4. Query SQLite + contact_directory for known human name
    if (db && typeof db.getResolvedSenderForJid === 'function') {
      const dbName = db.getResolvedSenderForJid(candidates);
      if (dbName && !isUpgradeableSenderName(dbName)) {
        for (const t of candidates) this._setChatNameIfBetter(t, dbName);
        return dbName;
      }
    }

    // 5. Fallback to cached phone label or formatted PN (still better than Contact (…))
    if (fast && !isPlaceholderSenderName(fast)) return fast;
    if (pn) {
      const formatted = formatPhoneLocalPart(pn.split('@')[0]);
      if (formatted) return formatted;
    }

    return null;
  }

  /** Batch resolves placeholder & phone-only sender names in a chat and backfills SQLite. */
  async resolveChatSenders(chatJid, db) {
    if (!db || typeof db.getDistinctPlaceholderSenderJids !== 'function') return [];
    const placeholderSenders = db.getDistinctPlaceholderSenderJids(chatJid, 150);
    if (!placeholderSenders.length) return [];

    // Harvest participant display names & LID↔PN links from live group metadata on demand
    if (isJidGroup(chatJid) && typeof this._sock?.groupMetadata === 'function') {
      const lastAt = this._groupMetaFetchedAt.get(chatJid) || 0;
      if (Date.now() - lastAt >= 120_000) {
        this._groupMetaFetchedAt.set(chatJid, Date.now());
        try {
          const meta = await this._sock.groupMetadata(chatJid);
          if (meta) this._ingestGroupParticipants(meta, db);
        } catch (_) {}
      }
    }

    const updates = [];
    const seenUpdate = new Set();
    for (const sJid of placeholderSenders) {
      try {
        const resolved = await this.resolveSenderDisplayName(sJid, db);
        if (resolved && !isPlaceholderSenderName(resolved)) {
          const norm = jidNormalizedUser(sJid);
          const targets = this._collectKnownLinkedJids(norm);
          const changed = db.backfillSenderName(targets, resolved);
          if (!isUpgradeableSenderName(resolved) || changed > 0) {
            for (const targetJid of targets) {
              const key = `${targetJid}\u0000${resolved}`;
              if (seenUpdate.has(key)) continue;
              seenUpdate.add(key);
              updates.push({ senderJid: targetJid, sender: resolved, changed });
            }
          }
        }
      } catch (_) {}
    }
    return updates;
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
        const name = await this._resolveContactTitleFromCache(jid);
        if (!isResolvedHumanChatTitle(name, jid)) continue;
        rowsUpdated += await this._propagateChatNameToDb(db, jid, name);
      } catch (_) { /* ignore per-chat */ }
    }
    // Also backfill placeholder & phone-only sender names across group & 1:1 messages
    if (typeof db.getDistinctPlaceholderSenderJids === 'function' && typeof db.backfillSenderName === 'function') {
      try {
        const distinctSenders = db.getDistinctPlaceholderSenderJids(null, 500);
        for (const sJid of distinctSenders) {
          try {
            const resolved = await this.resolveSenderDisplayName(sJid, db);
            if (resolved && !isPlaceholderSenderName(resolved)) {
              const targets = this._collectKnownLinkedJids(jidNormalizedUser(sJid));
              rowsUpdated += db.backfillSenderName(targets, resolved);
            }
          } catch (_) {}
        }
      } catch (e) {
        console.warn('[WA] backfill sender names error:', e.message);
      }
    }
    if (rowsUpdated > 0) {
      console.log(`[WA] Backfilled chat_name / sender on ${rowsUpdated} message row(s) from resolved contact titles`);
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
    const contactRows = await this.syncResolvedNamesToDb(db);
    const groupRows = await this.refreshGroupSubjectsInDb(db);
    return (contactRows || 0) + groupRows;
  }

  /**
   * Label groups with their WhatsApp subject instead of their numeric JID.
   *
   * Subjects are not part of the phone book, so the contact resync above never reaches
   * them. One `groupFetchAllParticipating()` call covers every joined group, so this
   * costs a single request rather than one per group. The in-memory title cache is
   * updated alongside the DB so `/api/chats` reflects the new names on its next read.
   */
  async refreshGroupSubjectsInDb(db) {
    if (typeof this._sock?.groupFetchAllParticipating !== 'function') return 0;
    let allGroups = null;
    try {
      allGroups = await this._sock.groupFetchAllParticipating();
    } catch (e) {
      console.warn('[WA] Group subject refresh failed:', e.message);
      return 0;
    }
    this._ingestAllGroupParticipants(allGroups, db);
    let rowsUpdated = 0;
    for (const { jid, subject } of groupSubjectUpdates(allGroups)) {
      this._chatNames.set(jid, subject);
      rowsUpdated += db?.propagateChatDisplayName?.(jid, subject) || 0;
    }
    if (rowsUpdated > 0) {
      console.log(`[WA] Refreshed group subjects on ${rowsUpdated} message row(s)`);
    }
    return rowsUpdated;
  }

  /**
   * Publish every joined group's real subject to the sidebar before message ingestion.
   *
   * The roster in `messaging-history.set` carries a name only for chats WhatsApp happens
   * to label, and groups usually arrive unnamed — so without this the sidebar shows
   * numeric JIDs until something fetches subjects. One `groupFetchAllParticipating()`
   * call covers every joined group, so running it at connect costs a single request and
   * lets the UI render a named chat list while messages are still streaming in behind it.
   *
   * Names go through `_applyDisplayName`, so they also reach SQLite via the resolved-name
   * hook rather than living only in memory.
   */
  async hydrateGroupTitlesForUi() {
    if (typeof this._sock?.groupFetchAllParticipating !== 'function') return 0;
    let allGroups = null;
    try {
      allGroups = await this._sock.groupFetchAllParticipating();
    } catch (e) {
      console.warn('[WA] Group title hydrate failed:', e.message);
      return 0;
    }
    this._ingestAllGroupParticipants(allGroups);
    const updates = groupSubjectUpdates(allGroups);
    if (!updates.length) return 0;
    for (const { jid, subject } of updates) {
      await this._applyDisplayName(jid, subject);
    }
    this._onChatsPreview?.(updates.map(({ jid, subject }) => ({
      chatJid: jid,
      chatName: subject,
      sidebarTab: sidebarTabForJid(jid),
      messageCount: 0,
      lastMessageTs: 0,
      summarizedCount: 0,
      participantCount: 2,
    })));
    console.log(`[WA] Hydrated ${updates.length} group title(s) for the sidebar`);
    return updates.length;
  }

  /** Server: when a new human-readable title is known for a chat, backfill SQLite for LID+PN pair. */
  propagateDisplayNameForChat(db, jid, name) {
    return this._propagateChatNameToDb(db, jid, name);
  }

  /** WhatsApp links the same person under @lid (chat id) and @s.whatsapp.net (contact id) — mirror the label. */
  async _mirrorDisplayNameAcrossJids(jid, label) {
    if (!label) return;
    const sock = this._sock;
    const lm = sock?.signalRepository?.lidMapping;
    try {
      if (isLidUser(jid)) {
        let pn = this._lidToPn.get(jid) || this._lidToPn.get(jidNormalizedUser(jid));
        if (!pn && lm) pn = await lm.getPNForLID(jid).catch(() => null);
        if (pn) {
          const pnNorm = jidNormalizedUser(pn);
          const lidNorm = jidNormalizedUser(jid);
          this._setChatNameIfBetter(pnNorm, label);
          this._lidToPn.set(lidNorm, pnNorm);
          this._pnToLid.set(pnNorm, lidNorm);
        }
      } else if (isPnUser(jid)) {
        let lid = this._pnToLid.get(jid) || this._pnToLid.get(jidNormalizedUser(jid));
        if (!lid && lm) lid = await lm.getLIDForPN(jid).catch(() => null);
        if (lid) {
          const lidNorm = jidNormalizedUser(lid);
          const pnNorm = jidNormalizedUser(jid);
          this._setChatNameIfBetter(lidNorm, label);
          this._pnToLid.set(pnNorm, lidNorm);
          this._lidToPn.set(lidNorm, pnNorm);
        }
      }
    } catch (_) { /* mapping may lag behind first messages */ }
  }

  async _ingestContact(c) {
    await this._noteContactPicture(c);
    // App-state contact mutations often put the phone-book title on `fullName`.
    const label = c?.name || c?.fullName || c?.notify || c?.verifiedName;
    if (!label) return;
    await this._applyLabelToLinkedJids(label, c.id, c.lidJid, c.pnJid, c.lid, c.phoneNumber);
  }

  /**
   * Picture notifications are the only contact events that carry `imgUrl`.
   * A normal name update must not clear or refetch photos.
   */
  async _noteContactPicture(c) {
    const action = avatarActionForContact(c);
    if (action === 'ignore' || !c?.id) return;
    let jids = [c.id];
    try {
      const linked = await this.getLinked1on1Jids(c.id);
      if (linked?.length) jids = linked;
    } catch (_) { /* mapping optional */ }
    if (action === 'clear') {
      const fetchedAt = Math.floor(Date.now() / 1000);
      for (const jid of jids) {
        this._onChatAvatar?.({ chatJid: jid, missing: true, relPath: null, fetchedAt });
      }
      return;
    }
    this.enqueueAvatarFetches(jids, { force: true });
  }

  /**
   * Queue profile-picture lookups. They wait until history sync finishes so they
   * don't compete with message ingestion. `force` is for a picture-changed event.
   */
  enqueueAvatarFetches(jids, { force = false } = {}) {
    for (const jid of jids || []) {
      if (!isAvatarEligibleJid(jid)) continue;
      if (force) {
        this._avatarQueued.delete(jid);
        this._avatarQueue = this._avatarQueue.filter((x) => x !== jid);
      }
      if (this._avatarQueued.has(jid)) continue;
      this._avatarQueued.add(jid);
      if (force) this._avatarQueue.unshift(jid);
      else this._avatarQueue.push(jid);
    }
    if (this._historyDone) void this._drainAvatarQueue();
  }

  async _profilePicturePreviewUrl(jid) {
    const sock = this._sock;
    if (!sock?.profilePictureUrl) return null;
    try {
      return await sock.profilePictureUrl(jid, 'preview');
    } catch (err) {
      if (profilePictureFailure(err) !== 'missing' || !isLidUser(jid)) throw err;
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid);
      const pnJid = pn ? jidNormalizedUser(pn) : '';
      if (!pnJid || pnJid === jid) throw err;
      return await sock.profilePictureUrl(pnJid, 'preview');
    }
  }

  async _fetchAndStoreAvatar(jid) {
    if (!this._sock?.profilePictureUrl) return;
    let url;
    try {
      url = await this._profilePicturePreviewUrl(jid);
    } catch (err) {
      if (profilePictureFailure(err) === 'missing') {
        await this._publishAvatarResult(jid, { missing: true, relPath: null });
        return;
      }
      throw err;
    }
    if (!url || !/^https:\/\//i.test(String(url))) {
      await this._publishAvatarResult(jid, { missing: true, relPath: null });
      return;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`avatar http ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = imageExtFromBytes(buf);
    if (!ext) throw new Error('avatar was not an image');
    const dir = join(config.dataDir, 'avatars');
    mkdirSync(dir, { recursive: true });
    const relPath = avatarFileName(jid, ext);
    await writeFile(join(dir, relPath), buf);
    await this._publishAvatarResult(jid, { missing: false, relPath });
  }

  /** Store the same file on the LID and phone-number jids that share one chat row. */
  async _publishAvatarResult(jid, { missing, relPath }) {
    const fetchedAt = Math.floor(Date.now() / 1000);
    let jids = [jid];
    try {
      const linked = await this.getLinked1on1Jids(jid);
      if (linked?.length) jids = linked;
    } catch (_) { /* mapping optional */ }
    for (const id of jids) {
      if (id !== jid) {
        this._avatarQueue = this._avatarQueue.filter((x) => x !== id);
        this._avatarQueued.add(id);
      }
      this._onChatAvatar?.({ chatJid: id, missing, relPath, fetchedAt });
    }
  }

  async _drainAvatarQueue() {
    if (this._avatarDraining || !this._historyDone || !this._sock) return;
    this._avatarDraining = true;
    const epoch = this._avatarEpoch;
    try {
      while (this._avatarQueue.length && !this._destroyed && epoch === this._avatarEpoch && this._sock) {
        const jid = this._avatarQueue.shift();
        try {
          await this._fetchAndStoreAvatar(jid);
        } catch (err) {
          this._avatarQueued.delete(jid);
          const msg = String(err?.message || err || '');
          console.warn('[WA] avatar', jid, msg.replace(/https?:\/\/\S+/g, '<url>'));
          if (!this._sock || epoch !== this._avatarEpoch || /connection closed|timed out/i.test(msg)) break;
        }
        if (epoch !== this._avatarEpoch) break;
        await new Promise((r) => setTimeout(r, WA_DRAIN_GAP_MS));
      }
    } finally {
      this._avatarDraining = false;
    }
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

  _ingestEmbeddedChatMessages(chats) {
    const rows = [];
    const seen = new Set();
    for (const c of chats || []) {
      for (const wrap of c.messages || []) {
        const msg = wrap?.message || wrap;
        if (!msg?.key?.id) continue;
        if (!msg.message && !msg.messageStubType) continue;
        const jid = msg.key.remoteJid || c.id;
        if (!jid) continue;
        const dedupe = `${jid}|${msg.key.id}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const normalized = msg.key.remoteJid ? msg : { ...msg, key: { ...msg.key, remoteJid: jid } };
        const row = this._msgToRow(normalized);
        if (!row) continue;
        rows.push(row);
        // Embedded history messages — stubs only; no auto media download.
      }
    }
    if (!rows.length) return;
    this._enqueueBatch(rows);
    this._flushPendingBatch();
    console.log(`[WA] Chat-list last messages ingested: ${rows.length}`);
  }

  _publishChatRoster(chats) {
    const preview = this._buildHistoryChatsPreview(chats);
    if (!preview.length) return;
    this._onChatsPreview?.(preview);
    this._promoteUiWhileHistoryContinues();
  }

  _buildHistoryChatsPreview(chats) {
    return (chats || [])
      .filter((c) => c?.id)
      .map((c) => {
        const raw = c.conversationTimestamp ?? c.lastMsgTimestamp ?? c.lastMessageRecvTimestamp ?? 0;
        const ts = raw != null ? Number(raw) : 0;
        return {
          chatJid: c.id,
          // Roster entries are usually unnamed for groups; fall back to a title already
          // hydrated into the cache so the preview carries a real name, not a bare JID.
          chatName: c.name || this._nameFromChatMap(c.id) || null,
          sidebarTab: sidebarTabForJid(c.id),
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
  _ingestHistoryRowsChunked(rows, { onComplete = null } = {}) {
    const chunkSize = config.waHistoryChunkSize;
    let offset = 0;
    let completed = false;
    const finishChunked = () => {
      if (completed) return;
      completed = true;
      try { onComplete?.(); } catch (_) {}
    };
    this._pendingHistoryRows += rows.length;
    const drain = () => {
      if (offset >= rows.length) {
        finishChunked();
        if (this._pendingHistoryRows === 0 && this._finishSyncRequested) {
          this._finishSyncRequested = false;
          this._finishSync();
        }
        return;
      }
      const chunk = rows.slice(offset, offset + chunkSize);
      offset += chunk.length;
      try {
        this._onMessages?.(chunk);
      } finally {
        this._pendingHistoryRows = Math.max(0, this._pendingHistoryRows - chunk.length);
      }
      this._totalMsgs += chunk.length;
      this._emitSyncProgress();
      const now = Date.now();
      if (now - this._lastSyncingUiAt >= 1200) {
        this._lastSyncingUiAt = now;
        if (!this._uiPromotedAfterFirstHistoryBatch) {
          this._setState('SYNCING', `Syncing… ${this._totalMsgs.toLocaleString()} messages received`);
        }
      }
      this._promoteUiWhileHistoryContinues();
      if (offset < rows.length) setImmediate(drain);
      else {
        finishChunked();
        if (this._pendingHistoryRows === 0 && this._finishSyncRequested) {
          this._finishSyncRequested = false;
          this._finishSync();
        }
      }
    };
    drain();
  }

  _emitSyncProgress({ done = false } = {}) {
    // Finish already ran. A late history batch must not flip the UI back to "loading".
    if (this._historyDone && !done) return;
    this._onProgress?.({
      completed: 0,
      total: 0,
      messages: this._totalMsgs,
      progress: done ? 100 : this._historyProgress,
      done,
      byChat: Object.fromEntries(this._syncByChat),
    });
  }

  _armSyncDoneTimer(ms) {
    clearTimeout(this._syncDoneTimer);
    this._syncDoneTimer = setTimeout(() => this._finishSync(), ms);
  }

  _finishSync() {
    if (this._historyDone) return;
    // `append` upserts share the short live batch timer and are not counted as history rows.
    // Flush them now so the indexing hook cannot observe an incomplete message database.
    this._flushPendingBatch();
    if (this._pendingHistoryRows > 0) {
      this._finishSyncRequested = true;
      console.log(`[WA] Waiting for ${this._pendingHistoryRows} queued message row(s) before indexing`);
      return;
    }

    const cfg = loadCfg(this._configFile);
    const emptyAccept = this._acceptPhoneHistorySync
      && this._totalMsgs === 0
      && !(this._historyEventsSeen > 0);
    if (emptyAccept && (this._historyResyncAttempts || 0) < 2) {
      this._historyResyncAttempts = (this._historyResyncAttempts || 0) + 1;
      console.warn(
        `[WA] No history batches yet (attempt ${this._historyResyncAttempts}/2) — soft-reconnect to request sync again`,
      );
      this._setState('SYNCING', 'Retrying chat history sync…');
      setTimeout(() => { void this.requestHistoryResync({ auto: true }); }, 1500);
      return;
    }

    this._historyDone = true;
    this._acceptPhoneHistorySync = false;
    if (!cfg.initialHistorySyncDone) {
      // Only lock out future phone history once we actually saw sync traffic or messages.
      if (this._totalMsgs > 0 || (this._historyEventsSeen || 0) > 0) {
        saveCfg(this._configFile, { ...cfg, initialHistorySyncDone: true });
        console.log('[WA] Initial history sync recorded — later reconnects will not notify the phone');
      } else {
        console.warn('[WA] Sync finished with no history — leaving flag clear so a later reconnect can retry');
      }
    }
    this._syncByChat.clear();
    this._emitSyncProgress({ done: true });
    console.log(`[WA] Sync complete — ${this._totalMsgs} messages`);
    this._setState('READY', `${this._totalMsgs.toLocaleString()} messages ready`);
    this._sortDeferredMediaQueue();
    // Re-queue pending media stubs from SQLite for background CDN drain.
    // Constrain to recent messages so history sync does not re-queue years of expired CDN links.
    // allowPhoneReupload remains false so this only fetches from CDN and never pings the phone.
    const recentSinceTs = Math.floor(Date.now() / 1000)
      - (config.liveRecentWindowDays * 24 * 60 * 60);
    this._requeuePersistedPendingMedia(null, null, { sinceTs: recentSinceTs });
    void this._drainMediaQueue();
    try { this._onHistorySyncComplete?.(); } catch (e) {
      console.warn('[WA] onHistorySyncComplete:', e.message);
    }
  }

  /**
   * Re-open the socket with the same credentials and accept one more phone history sync.
   * Does not wipe auth (unlike logout / badSession).
   * Manual calls (Settings button, server API) always run immediately; internal automatic
   * retries ({ auto: true }) respect the phone-notification pacing backoff.
   */
  async requestHistoryResync({ auto = false } = {}) {
    if (this._destroyed) return;
    this._clearInitialHistorySyncFlag();
    this._forceFullHistoryOnce = !auto;
    this._historyDone = false;
    this._acceptPhoneHistorySync = true;
    this._historyEventsSeen = 0;
    this._totalMsgs = 0;
    clearTimeout(this._syncDoneTimer);
    // An explicit resync supersedes any pending automatic retry.
    clearTimeout(this._historyRetryTimer);
    this._historyRetryTimer = null;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._suppressReconnectOnce = true;
    const sock = this._sock;
    this._sock = null;
    if (sock) {
      try { sock.end(new Error('history-resync')); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 500));
    this._suppressReconnectOnce = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (!this._destroyed && !this._sock) await this._connect();
  }

  // ── Batch flush ────────────────────────────────────────────────────────────
  _enqueueBatch(rows) {
    this._pendingBatch.push(...rows);
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this._flushPendingBatch();
      }, BATCH_MS);
    }
  }

  _flushPendingBatch() {
    if (!this._pendingBatch.length) return;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    clearTimeout(this._liveFlushTimer);
    this._liveFlushTimer = null;
    this._onMessages?.(this._pendingBatch.splice(0));
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
    if (!this._resolvedContactTitles) this._resolvedContactTitles = new Map();
    if (this._resolvedContactTitles.has(jid)) {
      return this._resolvedContactTitles.get(jid);
    }
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
    const resolved = cachedName && isResolvedHumanChatTitle(cachedName, jid) ? cachedName : null;
    this._resolvedContactTitles.set(jid, resolved);
    return resolved;
  }

  /**
   * Live metadata (groups + contacts) when the socket is up. Falls back to minimal info on error.
   */
  async getChatDetails(jid) {
    if (!jid) return null;
    // File/Gmail imports are not WhatsApp contacts — never invent a phone/displayName
    // from the synthetic JID (that produced the flickering "import" title).
    if (isImportedChatJid(jid)) {
      return {
        chatJid: jid,
        displayName: null,
        chatName: null,
        isGroup: false,
        isImported: true,
        waConnected: Boolean(this._sock),
      };
    }
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
        this._ingestGroupParticipants(meta);
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
  async overlayResolvedChatNames(stats, { lidLookup = true } = {}) {
    if (!Array.isArray(stats) || !stats.length) return stats;
    const uniqueJids = [...new Set(stats.map((row) => row.chatJid).filter(Boolean))];
    const resolvedMap = new Map();
    if (lidLookup) {
      await Promise.all(
        uniqueJids.map(async (jid) => {
          try {
            resolvedMap.set(jid, await this._resolveContactTitleFromCache(jid));
          } catch {
            resolvedMap.set(jid, null);
          }
        }),
      );
    } else {
      for (const jid of uniqueJids) {
        const cached = this._nameFromChatMap(jid);
        resolvedMap.set(jid, isResolvedHumanChatTitle(cached, jid) ? cached : null);
      }
    }
    return stats.map((row) => {
      const jid = row.chatJid;
      if (!jid) return row;
      const resolved = resolvedMap.get(jid);
      if (resolved && isResolvedHumanChatTitle(resolved, jid)) return { ...row, chatName: resolved };
      const cleaned = replaceLidPlaceholderWithPn(jid, row.chatName);
      if (cleaned !== row.chatName) return { ...row, chatName: cleaned };
      return row;
    });
  }

  /**
   * Resolve LID ↔ phone-number JID for one 1:1 contact so APIs can query merged history.
   */
  async getLinked1on1Jids(jid) {
    if (!jid || isJidGroup(jid) || shouldPreserveRawChatJid(jid)) return [jid];
    const lm = this._sock?.signalRepository?.lidMapping;
    if (!lm) return [jidNormalizedUser(jid) || jid];
    const out = new Set();
    try {
      const n = jidNormalizedUser(jid) || jid;
      out.add(n);
      if (isLidUser(jid)) {
        const pn = await lm.getPNForLID(jid);
        if (pn) {
          const normPn = jidNormalizedUser(pn);
          out.add(normPn);
          this._db?.saveLidPnMapping?.(jid, normPn);
        }
      } else if (isPnUser(jid) || jid?.endsWith?.('@hosted')) {
        const lids = await lm.getLIDsForPNs([jid]);
        const lid = lids?.[0]?.lid;
        if (lid) {
          const normLid = jidNormalizedUser(lid);
          out.add(normLid);
          this._db?.saveLidPnMapping?.(normLid, jid);
        }
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
      if (!jid || isJidGroup(jid) || shouldPreserveRawChatJid(jid)) return jid;
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
        sidebarTab: sidebarTabForJid(canon),
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

  /**
   * @param {object} msg Baileys message
   * @param {object} row DB-shaped media row
   * @param {{ allowPhoneReupload?: boolean }} [opts]
   *   Phone re-upload (`updateMediaMessage`) notifies the primary device. Only enable
   *   for an explicit user Refresh / Retry on that chat — never for bulk history drain.
   */
  async _enrichRowWithMedia(msg, row, { allowPhoneReupload = false, isDeferredLargeVideo = false } = {}) {
    if (!row?.mediaType || !MEDIA_FOR_INDEX.has(row.mediaType) || !this._sock) return row;
    const inner = resolveInnerContent(msg.message) || msg.message;
    const mime =
      inner.imageMessage?.mimetype ||
      inner.videoMessage?.mimetype ||
      inner.ptvMessage?.mimetype ||
      inner.audioMessage?.mimetype ||
      inner.stickerMessage?.mimetype ||
      inner.documentMessage?.mimetype ||
      'application/octet-stream';
    const documentExt = extname(String(inner.documentMessage?.fileName || '')).slice(1).toLowerCase();
    const ext = ['xlsx', 'csv'].includes(documentExt) ? documentExt : extFromMime(mime);
    const dir = join(config.mediaDir, safeJidDir(row.chatJid));
    mkdirSync(dir, { recursive: true });
    const filename = `${row.messageId}.${ext}`;
    const fullPath = join(dir, filename);
    const isPriority = Boolean(allowPhoneReupload || isDeferredLargeVideo || this._priorityMediaChatJids.includes(row.chatJid));
    const videoCap = isPriority ? MAX_VIDEO_BYTES_EXPLICIT : MAX_VIDEO_BYTES_BACKGROUND;

    // Stream decrypt → temp file → rename. Directly streams to disk to keep RAM minimal.
    const downloadToFile = async (message) => {
      const stream = await downloadMediaMessageSafe(message, 'stream', {}, {
        logger: this._mediaLogger,
        ...(allowPhoneReupload
          ? { reuploadRequest: (x) => this._sock.updateMediaMessage(x) }
          : {}),
      });
      const tempPath = `${fullPath}.part-${process.pid}-${Date.now()}`;
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (row.mediaType === 'video' && bytes > videoCap) {
            const error = new Error(`video exceeds ${videoCap} byte limit`);
            error.code = 'WA_MEDIA_TOO_LARGE';
            callback(error);
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        await pipeline(stream, limit, createWriteStream(tempPath, { flags: 'w' }));
        await rmAsync(fullPath, { force: true });
        await rename(tempPath, fullPath);
        return bytes;
      } catch (error) {
        await rmAsync(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    };

    try {
      try {
        await downloadToFile(msg);
      } catch (e1) {
        const message = String(e1?.message || '');
        if (
          e1?.code !== 'WA_MEDIA_TOO_LARGE'
          && allowPhoneReupload
          && (message.includes('Failed to fetch stream') || message.includes('Status code: 403') || message.includes('Status code: 401'))
        ) {
          const refreshed = await this._sock.updateMediaMessage(msg);
          await downloadToFile(refreshed || msg);
        } else {
          throw e1;
        }
      }
      if (row.messageId) this._failedMediaDownloads.delete(String(row.messageId));
      return { ...row, mediaPath: fullPath };
    } catch (e) {
      if (e?.code === 'WA_MEDIA_TOO_LARGE') {
        console.warn(`[WA] defer large video (${row.messageId}, ${Math.round(videoCap / (1024 * 1024))}MB+ limit) — can load on demand`);
        return { ...row, mediaPath: MEDIA_TOO_LARGE_PATH };
      }
      const msgText = String(e?.message || 'media download failed');
      const sanitized = msgText.replace(/https?:\/\/\S+/g, '<url>');
      const isPermanent = isPermanentMediaFailure(e);

      if (row.messageId) {
        this._failedMediaDownloads.set(String(row.messageId), {
          chatJid: row.chatJid,
          failedAt: Date.now(),
          error: sanitized,
          statusCode: e?.statusCode ?? e?.status ?? null,
        });
        if (this._failedMediaDownloads.size > 5000) {
          const first = this._failedMediaDownloads.keys().next().value;
          if (first) this._failedMediaDownloads.delete(first);
        }
      }

      // Soft open / bulk drain skip phone reupload. Expired CDN URLs often 404 even
      // though the image still exists on WhatsApp — never mark those permanent.
      if (allowPhoneReupload && isPermanent) {
        console.warn(`[WA] media download ${row.messageId}:`, sanitized);
        return { ...row, mediaPath: MEDIA_UNAVAILABLE_PATH };
      }

      if (allowPhoneReupload || (!sanitized.includes('Failed to fetch stream') && !isPermanent)) {
        console.warn(`[WA] media download ${row.messageId}:`, sanitized);
      } else {
        this._mediaLogger?.debug?.(
          { messageId: row.messageId, err: sanitized },
          'background media download skipped (CDN stream unavailable)',
        );
      }
      return row;
    }
  }

  /** True while this message's media is waiting in (or being pulled by) the download queue. */
  isMediaQueued(messageId) {
    return !!messageId && this._queuedMediaIds.has(String(messageId));
  }

  /**
   * Live `notify` always; recent `append` catch-up only. Never treat bulk history as auto-download.
   * @param {string} upsertType Baileys messages.upsert `type`
   * @param {{ timestamp?: number }} row
   */
  _shouldAutoDownloadMedia(upsertType, row) {
    if (upsertType === 'notify') return true;
    if (upsertType !== 'append') return false;
    const ts = Number(row?.timestamp) || 0;
    if (!ts) return false;
    const cutoff = Math.floor(Date.now() / 1000) - (config.liveRecentWindowDays * 24 * 60 * 60);
    return ts >= cutoff;
  }

  _queueMediaDownload(msg, row) {
    if (!row?.mediaType || !MEDIA_FOR_INDEX.has(row.mediaType) || !this._sock) return;
    if (isTerminalMediaPath(row.mediaPath)) return;
    if (row.mediaPath && existsSync(row.mediaPath)) return;
    if (row.messageId && this._recentOutboundMediaPaths.has(String(row.messageId))) return;
    const queue = this._mediaQueues.get(row.mediaType);
    if (!queue) return;
    if (row.messageId && this._queuedMediaIds.has(row.messageId)) return;
    if (row.messageId) this._queuedMediaIds.add(row.messageId);
    // Retain only the fields Baileys needs for media download rather than the full history
    // event object; large first syncs can otherwise keep substantial protocol metadata alive.
    const slim = { msg: { key: msg.key, message: msg.message }, row };
    queue.push(slim);
    const priorityMatch = this._priorityMediaChatJids.includes(row.chatJid);
    if (this._historyDone || priorityMatch) this._drainMediaQueue().catch(() => {});
  }

  _mediaQueueLength(chatJid = null) {
    let count = 0;
    for (const queue of this._mediaQueues.values()) {
      count += chatJid
        ? queue.filter((item) => item?.row?.chatJid === chatJid).length
        : queue.length;
    }
    return count;
  }

  /** Public length for expense / UI waiters. */
  mediaQueueLength(chatJid = null) {
    return this._mediaQueueLength(chatJid);
  }

  /**
   * Resolve when this chat has nothing left in the media queues and a drain wave is not running.
   * Used by expense reconciliation so date-span media is downloaded before extract.
   * @param {string} chatJid
   * @param {{ pollMs?: number }} [opts] pollMs defaults to WA_MEDIA_DRAIN_GAP_MS
   */
  async awaitChatMediaQueueIdle(chatJid, { pollMs = WA_DRAIN_GAP_MS } = {}) {
    const jid = String(chatJid || '').trim();
    const gap = Number(pollMs);
    if (!jid || !Number.isFinite(gap) || gap <= 0) return;
    let idleRounds = 0;
    while (!this._destroyed && idleRounds < 2) {
      const queued = this._mediaQueueLength(jid);
      if (queued > 0 && !this._mediaDraining) {
        this._drainMediaQueue().catch(() => {});
      }
      if (queued === 0 && !this._mediaDraining) idleRounds += 1;
      else idleRounds = 0;
      if (idleRounds >= 2) return;
      await new Promise((r) => setTimeout(r, gap));
    }
  }

  /**
   * Push a chat to the front of the media-priority stack without dropping earlier opens.
   * Cap = `liveRecentWindowDays` (same window used for “recent” media age).
   */
  _pushPriorityMediaChat(chatJid) {
    const jid = String(chatJid || '').trim();
    if (!jid) return;
    this._priorityMediaChatJids = this._priorityMediaChatJids.filter((x) => x !== jid);
    this._priorityMediaChatJids.unshift(jid);
    const cap = Math.max(1, config.liveRecentWindowDays || 1);
    if (this._priorityMediaChatJids.length > cap) {
      this._priorityMediaChatJids.length = cap;
    }
  }

  /**
   * Prefer media downloads for this chat.
   * - Open chat: `{ recentOnly: true }` → last `liveRecentWindowDays` only; no phone reupload.
   * - Retry / Load messages & media: full chat (or one messageId); may reupload from phone.
   * Fast chat switches push onto a stack — earlier opens keep downloading.
   * @param {string} chatJid
   * @param {{ messageId?: string|null, recentOnly?: boolean, allowPhoneReupload?: boolean }} [opts]
   * @returns {{ ok: boolean, queuedForChat: number }}
   */
  prioritizeChatMedia(chatJid, {
    messageId = null,
    recentOnly = false,
    allowPhoneReupload = !recentOnly,
  } = {}) {
    const jid = String(chatJid || '').trim();
    const mid = messageId != null ? String(messageId).trim() : '';
    if (jid) this._pushPriorityMediaChat(jid);
    if (jid && allowPhoneReupload) this._phoneReuploadChatJids.add(jid);
    if (mid && allowPhoneReupload) this._retryMediaIds.add(mid);
    if (mid) this._failedMediaDownloads.delete(mid);
    if (jid && allowPhoneReupload) {
      for (const [failedMid, meta] of this._failedMediaDownloads.entries()) {
        if (meta?.chatJid === jid) this._failedMediaDownloads.delete(failedMid);
      }
    }
    const sinceTs = recentOnly && !mid
      ? Math.floor(Date.now() / 1000) - (config.liveRecentWindowDays * 24 * 60 * 60)
      : null;
    if (jid) this._requeuePersistedPendingMedia(jid, mid || null, { sinceTs });
    this._sortDeferredMediaQueue();
    this._drainMediaQueue().catch(() => {});
    return { ok: true, queuedForChat: jid ? this._mediaQueueLength(jid) : 0 };
  }

  /**
   * Load Baileys media stubs persisted in SQLite and put them back on the download queue.
   * @param {string | null} chatJid null = every chat (post-sync)
   * @param {string | null} [messageId] when set, only that message
   * @param {{ sinceTs?: number|null }} [opts] when set, only media at/after this unix second
   */
  _requeuePersistedPendingMedia(chatJid, messageId = null, { sinceTs = null } = {}) {
    if (typeof this._onLoadPendingMediaStubs !== 'function') return 0;
    let items = [];
    try {
      items = this._onLoadPendingMediaStubs(chatJid || null) || [];
    } catch (e) {
      console.warn('[WA] load pending media stubs:', e?.message || e);
      return 0;
    }
    const wantMid = messageId != null ? String(messageId).trim() : '';
    const minTs = sinceTs != null ? Number(sinceTs) || 0 : null;
    let n = 0;
    for (const item of items) {
      if (!item?.msg?.key || !item?.row?.messageId) continue;
      const mid = String(item.row.messageId);
      if (wantMid && mid !== wantMid) continue;
      if (minTs != null && (Number(item.row.timestamp) || 0) < minTs) continue;
      const isExplicitRetry = Boolean(wantMid || this._retryMediaIds.has(mid) || (chatJid && this._phoneReuploadChatJids.has(chatJid)));
      if (!isExplicitRetry && this._failedMediaDownloads.has(mid)) {
        continue;
      }
      this._queueMediaDownload(item.msg, item.row);
      n += 1;
    }
    if (n) {
      console.log(
        `[WA] Re-queued ${n} pending media download(s)`
        + (chatJid ? ` for ${chatJid}` : '')
        + (wantMid ? ` (message ${wantMid})` : '')
        + (minTs != null ? ` (since ${minTs})` : ''),
      );
    }
    return n;
  }

  _sortDeferredMediaQueue() {
    const cutoff = Math.floor(Date.now() / 1000)
      - (config.liveRecentWindowDays * 24 * 60 * 60);
    for (const queue of this._mediaQueues.values()) {
      sortDeferredMediaByChatActivity(queue, cutoff, this._priorityMediaChatJids);
    }
  }

  /**
   * Round-robin across type queues, but skip video on the first pass so light media
   * is not stuck behind large downloads when both are pending.
   */
  _takeNextMediaQueueItem() {
    const types = MEDIA_QUEUE_TYPES;
    for (let pass = 0; pass < 2; pass += 1) {
      for (let offset = 0; offset < types.length; offset += 1) {
        const index = (this._mediaQueueCursor + offset) % types.length;
        const type = types[index];
        if (pass === 0 && type === 'video') continue;
        const item = takeNextDeferredMediaItem(this._mediaQueues.get(type), {
          historyDone: this._historyDone,
          priorityChatJids: this._priorityMediaChatJids,
        });
        if (item) {
          this._mediaQueueCursor = (index + 1) % types.length;
          return item;
        }
      }
    }
    // Normal queues are empty. Check if there are deferred large videos to drain eventually!
    if (this._historyDone && typeof this._onLoadDeferredLargeVideos === 'function') {
      const deferred = this._pullNextDeferredLargeVideoItem();
      if (deferred) return deferred;
    }
    return null;
  }

  /**
   * Progressively pull deferred large videos once all lighter media has drained.
   * Drains at explicit cap (up to 100MB) without blocking other chats or light items.
   */
  _pullNextDeferredLargeVideoItem() {
    if (!this._deferredLargeVideosQueue) this._deferredLargeVideosQueue = [];
    if (!this._deferredLargeVideosQueue.length) {
      try {
        const rows = this._onLoadDeferredLargeVideos(null, 15) || [];
        for (const item of rows) {
          if (!item?.msg?.key || !item?.row?.messageId) continue;
          if (this._queuedMediaIds.has(item.row.messageId)) continue;
          this._deferredLargeVideosQueue.push(item);
        }
      } catch (e) {
        console.warn('[WA] load deferred large videos:', e?.message || e);
      }
    }
    while (this._deferredLargeVideosQueue.length) {
      const item = this._deferredLargeVideosQueue.shift();
      if (item?.row?.messageId) {
        this._queuedMediaIds.add(item.row.messageId);
        // Clear terminal sentinel in DB so mediaNeedsDownload passes, and set explicit flag
        this._onClearDeferredVideoPath?.(item.row.chatJid, item.row.messageId);
        item.row.mediaPath = null;
        item.isDeferredLargeVideo = true;
        return item;
      }
    }
    return null;
  }

  async _mediaDrainWorker() {
    while (!this._destroyed) {
      const item = this._takeNextMediaQueueItem();
      if (!item) return;
      const { msg, row, isDeferredLargeVideo } = item;
      let settledPath = null;
      let claimed = false;
      let reportOutcome = false;
      try {
        claimed = typeof this._onClaimMediaDownload === 'function'
          ? Boolean(this._onClaimMediaDownload(row.messageId))
          : true;
        if (!claimed) continue;
        // On-demand history re-delivers messages whose file we may already have.
        if (this._onMediaNeedsDownload?.(row.messageId) === false) continue;
        reportOutcome = true;
        const allowPhoneReupload = this._phoneReuploadChatJids.has(row.chatJid)
          || Boolean(row.messageId && this._retryMediaIds.has(row.messageId));
        const enriched = await this._enrichRowWithMedia(msg, row, {
          allowPhoneReupload,
          isDeferredLargeVideo: Boolean(isDeferredLargeVideo),
        });
        settledPath = enriched.mediaPath || null;
        // Same object may still sit in the unflushed insert batch — carry the path into it.
        if (settledPath) row.mediaPath = settledPath;
        if (settledPath && !isTerminalMediaPath(settledPath) && row.messageId) {
          this._failedMediaDownloads.delete(String(row.messageId));
        }
      } finally {
        if (row.messageId) {
          this._queuedMediaIds.delete(row.messageId);
          this._retryMediaIds.delete(row.messageId);
        }
        // Persist path/settled before releasing the lease so another worker cannot race.
        if (claimed) {
          try {
            if (reportOutcome) {
              if (settledPath) this._onMediaPath?.(row.messageId, settledPath);
              else this._onMediaSettled?.(row.messageId);
            }
          } finally {
            this._onReleaseMediaDownloadClaim?.(row.messageId);
          }
        }
      }
      await new Promise((r) => setTimeout(r, WA_DRAIN_GAP_MS));
    }
  }

  async _drainMediaQueue() {
    if (this._mediaDraining) return;
    // Full archive waits until history finishes; prioritized open chats may drain during sync.
    if (!this._historyDone && !this._priorityMediaChatJids.length) return;
    this._mediaDraining = true;
    this._notifySyncActivity();
    const workers = Math.max(1, config.waMediaDrainConcurrency || 1);
    let restarted = false;
    try {
      await Promise.all(Array.from({ length: workers }, () => this._mediaDrainWorker()));
    } finally {
      this._mediaDraining = false;
      if (this._historyDone && this._mediaQueueLength() && !this._destroyed) {
        restarted = true;
        this._drainMediaQueue().catch(() => {});
      }
      if (!restarted) this._notifySyncActivity();
    }
  }

  // ── Message → DB row ───────────────────────────────────────────────────────
  _msgToRow(msg) {
    try {
      const jid = msg.key.remoteJid;
      if (!jid || !msg.message) return null;

      const inner = resolveInnerContent(msg.message);
      if (!inner) return null;
      // Protocol/key-exchange frames have no readable body — storing them showed "[protocol]".
      const contentType = getContentType(inner);
      if (isControlOnlyContentType(contentType)) return null;
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
              senderTimestampMs: r.senderTimestampMs,
            })),
        };
      }
      let text = extractTextFromInner(inner);
      const contactBundle = buildContactPayloadFromInner(inner);
      if (contactBundle?.summaryText) {
        text = contactBundle.summaryText;
      }
      const contactPayload = contactBundle ? JSON.stringify(contactBundle.payload) : null;

      const hasMedia = !!(
        inner.imageMessage ||
        inner.videoMessage ||
        inner.ptvMessage ||
        inner.audioMessage ||
        inner.documentMessage ||
        inner.stickerMessage
      );
      if (!text && !hasMedia && !contactPayload) {
        // Bare `{ call: … }` has no *Message key; still a real missed-call event.
        if (inner.call) text = '[Call]';
        else {
          text = placeholderForContentType(contentType);
          // Unknown empty frames used to become the junk bubble "[Message]" — drop them.
          if (!text) return null;
        }
      }

      const mediaType = hasMedia
        ? (inner.imageMessage ? 'image'
          : (inner.videoMessage || inner.ptvMessage) ? 'video'
            : inner.audioMessage ? 'audio'
              : inner.documentMessage ? 'document'
                : 'sticker')
        : null;

      const senderJid = msg.key.participant || (msg.key.fromMe ? this._ownerJid : jid);
      const isGroup = isJidGroup(jid);
      const pAlt = msg.key?.participantAlt || null;
      const rAlt = !isGroup ? (msg.key?.remoteJidAlt || null) : null;

      // Record LID <-> PN pair whenever the wire frame provides an alternate JID
      const altForSender = pAlt || rAlt;
      if (senderJid && altForSender) {
        try {
          const sNorm = jidNormalizedUser(senderJid);
          const aNorm = jidNormalizedUser(altForSender);
          if (sNorm && aNorm && sNorm !== aNorm) {
            if (isLidUser(sNorm) && (isPnUser(aNorm) || aNorm.endsWith('@hosted'))) {
              this._lidToPn.set(sNorm, aNorm);
              this._pnToLid.set(aNorm, sNorm);
              this._db?.saveLidPnMapping?.(sNorm, aNorm);
            } else if ((isPnUser(sNorm) || sNorm.endsWith('@hosted')) && isLidUser(aNorm)) {
              this._pnToLid.set(sNorm, aNorm);
              this._lidToPn.set(aNorm, sNorm);
              this._db?.saveLidPnMapping?.(aNorm, sNorm);
            }
          }
        } catch (_) {}
      }

      const rawPush = msg.pushName && !msg.key.fromMe && !isProbablyOwnName(msg.pushName, this._ownerName)
        ? String(msg.pushName).trim()
        : null;
      const candidates = [
        this._nameFromChatMap(senderJid),
        pAlt ? this._nameFromChatMap(pAlt) : null,
        rAlt ? this._nameFromChatMap(rAlt) : null,
        rawPush,
      ];
      let senderName = null;
      for (const cand of candidates) {
        if (!cand || isUpgradeableSenderName(cand)) continue;
        const cleaned = sanitizePeerSenderName(cand, jid);
        if (cleaned && !isUpgradeableSenderName(cleaned)) {
          senderName = cleaned;
          break;
        }
      }
      if (!senderName) {
        const fast = this.getSenderDisplayNameFast(senderJid)
          || (pAlt ? this.getSenderDisplayNameFast(pAlt) : null)
          || (rAlt ? this.getSenderDisplayNameFast(rAlt) : null);
        if (fast) {
          const cleaned = sanitizePeerSenderName(fast, jid);
          if (cleaned) senderName = cleaned;
        }
      }
      if (!senderName && rawPush) {
        senderName = sanitizePeerSenderName(rawPush, jid);
      }
      if (!senderName) {
        if (senderJid?.endsWith?.('@s.whatsapp.net') || senderJid?.endsWith?.('@hosted')) {
          senderName = formatPhoneLocalPart(senderJid.split('@')[0]);
        } else if (senderJid?.endsWith?.('@lid')) {
          const pn = this._lidToPn.get(senderJid) || this._lidToPn.get(jidNormalizedUser(senderJid));
          if (pn) senderName = formatPhoneLocalPart(pn.split('@')[0]);
          else senderName = fallbackTitleForOneOnOneJid(senderJid) || 'Contact';
        } else {
          senderName = senderJid?.split('@')[0] || 'Unknown';
        }
      }
      if (senderName && !msg.key.fromMe && !isUpgradeableSenderName(senderName) && senderJid) {
        try {
          const sNorm = jidNormalizedUser(senderJid);
          if (sNorm && !isJidGroup(sNorm)) this._setChatNameIfBetter(sNorm, senderName);
        } catch (_) {}
      }
      let chatName = this._resolveChatDisplayName(jid, msg);
      // For 1:1 chats, WhatsApp often only gives a good name via pushName on an incoming message.
      // If the resolved chat title is just a number/placeholder but we have a human sender name, use that.
      if (
        !isGroup
        && senderName
        && senderName !== 'You'
        && isResolvedHumanChatTitle(senderName, jid)
        && (
          looksLikePhoneDigitsOnly(chatName)
          || looksLikeLidFallbackContactLabel(chatName)
          || looksLikeOpaqueNumericId(chatName)
          || looksLikeMaskedPhoneLabel(chatName)
        )
      ) {
        chatName = senderName;
      }

      const messageId = msg.key.id ? String(msg.key.id) : `${msg.messageTimestamp}_${Math.random()}`;
      const recentOutboundPath = this._recentOutboundMediaPaths.get(messageId);
      const existingOutboundPath = recentOutboundPath && existsSync(recentOutboundPath) ? recentOutboundPath : null;
      const quotedPayload = this._buildQuotedPayloadFromInner(inner, jid, msg);

      return {
        messageId,
        chatJid:      jid,
        chatName,
        sender:       msg.key.fromMe ? 'You' : senderName,
        senderJid:    senderJid || null,
        text:         text || null,
        mediaType,
        mediaPath:    existingOutboundPath,
        mediaDownloadJson: mediaType && !existingOutboundPath ? buildMediaDownloadStub(msg) : null,
        mediaCaption:
          inner.imageMessage?.caption ||
          inner.videoMessage?.caption ||
          inner.ptvMessage?.caption ||
          inner.documentMessage?.caption ||
          (inner.documentMessage?.fileName ? String(inner.documentMessage.fileName).trim() : null) ||
          null,
        timestamp:    Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
        receiptStatus: msg.key.fromMe ? normalizeReceiptStatus(msg.status) : null,
        contactPayload,
        quotedPayload: quotedPayload ? JSON.stringify(quotedPayload) : null,
        ...(rxPayload || {}),
      };
    } catch { return null; }
  }

  /**
   * Explicit user action only (Load older / opt-in refresh). Each call is a phone-side
   * history sync and can surface “syncing with WhatsApp Search” — quota keeps that rare.
   */
  async fetchOlderHistoryFromPhone(anchor, count = PHONE_HISTORY_DEFAULT_COUNT) {
    if (!this._sock?.fetchMessageHistory) throw new Error('WhatsApp not connected');
    const { chatJid, messageId, timestamp, fromMe } = anchor || {};
    if (!chatJid || !messageId) throw new Error('Missing chat anchor');
    let ts = Number(timestamp);
    if (!Number.isFinite(ts) || ts <= 0) throw new Error('Invalid anchor timestamp');
    if (ts < 1e12) ts *= 1000;
    const guard = this.canFetchPhoneHistory(chatJid);
    if (!guard.ok) {
      const err = new Error(guard.message);
      err.code = guard.code;
      err.status = guard.http;
      err.retryAfterMs = guard.retryAfterMs;
      throw err;
    }
    const state = this._ensurePhoneHistoryState();
    const now = Date.now();
    state.inflight = { chatJid, until: now + PHONE_HISTORY_INFLIGHT_MS };
    state.lastSyncAt.set(chatJid, now);
    state.lastGlobalAt = now;
    state.pullsLastHour = [...(state.pullsLastHour || []).filter((t) => t > now - 60 * 60 * 1000), now];
    clearTimeout(this._phoneInflightTimer);
    this._phoneInflightTimer = setTimeout(() => {
      if (this._phoneHistory?.inflight && Date.now() >= this._phoneHistory.inflight.until) {
        this._phoneHistory.inflight = null;
        this._notifySyncActivity();
      }
    }, PHONE_HISTORY_INFLIGHT_MS + 100);
    this._phoneInflightTimer.unref?.();
    this._notifySyncActivity();
    const key = {
      remoteJid: chatJid,
      id: String(messageId),
      fromMe: Boolean(fromMe),
    };
    const n = Math.min(1000, Math.max(1, Math.floor(Number(count) || PHONE_HISTORY_DEFAULT_COUNT)));
    try {
      return await this._sock.fetchMessageHistory(n, key, ts);
    } catch (err) {
      if (state.inflight?.chatJid === chatJid) state.inflight = null;
      clearTimeout(this._phoneInflightTimer);
      this._phoneInflightTimer = null;
      this._notifySyncActivity();
      throw err;
    }
  }

  _ensurePhoneHistoryState() {
    if (!this._phoneHistory) {
      this._phoneHistory = {
        paused: false,
        inflight: null,
        lastSyncAt: new Map(),
        lastGlobalAt: 0,
        pullsLastHour: [],
      };
    }
    return this._phoneHistory;
  }

  /** Guard + bookkeeping for phone-side history pulls (shared across builds). */
  canFetchPhoneHistory(chatJid) {
    const state = this._ensurePhoneHistoryState();
    const now = Date.now();
    if (state.inflight && now >= state.inflight.until) state.inflight = null;
    state.pullsLastHour = (state.pullsLastHour || []).filter((t) => t > now - 60 * 60 * 1000);
    return evaluatePhoneHistoryQuota({
      chatJid,
      nowMs: now,
      paused: state.paused,
      waReady: !this._state || this._state === 'READY',
      inflightUntil: state.inflight?.until || 0,
      lastChatAtMs: state.lastSyncAt.get(chatJid) || 0,
      lastGlobalAtMs: state.lastGlobalAt || 0,
      pullsLastHourMs: state.pullsLastHour,
    });
  }

  /** Called by the desktop shell (Electron powerMonitor) around system sleep/lock. */
  setPhoneHistoryPaused(paused) {
    const state = this._ensurePhoneHistoryState();
    const p = Boolean(paused);
    if (state.paused === p) return;
    state.paused = p;
    console.log(`[WA] phone history sync ${p ? 'PAUSED (device sleeping/locked — syncs aborted here would spam phone notifications)' : 'RESUMED'}`);
  }
}
