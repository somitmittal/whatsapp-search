/**
 * wa-client.js — WhatsApp integration via @whiskeysockets/baileys
 *
 * Baileys implements the WhatsApp multi-device WS protocol directly.
 * No Puppeteer / headless browser → no bot-detection / "Can't link" errors.
 */
import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import config from '../config.js';

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
} = require('@whiskeysockets/baileys');
const QRCode   = require('qrcode');
const P        = require('pino');

const AUTH_DIR         = join(config.dataDir, '.baileys_auth');
const CONFIG_FILE      = join(config.dataDir, 'wa-config.json');
const SEARCH_GROUP     = '🔍 WhatsApp Search';
const BATCH_MS         = 2000;
const SYNC_DONE_DELAY  = 8_000; // ms of silence after last history batch → mark READY

const MEDIA_FOR_INDEX = new Set(['image', 'audio', 'video', 'sticker']);
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
function loadCfg() {
  try { if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return {};
}
function saveCfg(d) {
  try { writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2)); } catch {}
}

function extractText(msg) {
  if (!msg?.message) return '';
  const m = msg.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ''
  ) || '';
}

function formatResult(result) {
  if (!result || result.error) return `❌ Search failed: ${result?.error || 'unknown error'}`;
  if (!result.answer && !result.sources?.length) return '🔍 No relevant messages found.';
  const lines = [];
  if (result.answer) lines.push(result.answer);
  if (result.sources?.length) {
    lines.push('\n─── Sources ───');
    for (const s of result.sources.slice(0, 5)) {
      const ts = s.timestamp
        ? new Date(s.timestamp * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
        : '';
      lines.push(`• *${s.sender}*${ts ? ` (${ts})` : ''}: ${(s.text || '').slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
export default class WaClient {
  constructor({ onQr, onReady, onMessages, onStatus, onProgress, onSearchQuery, onDisconnected, onMediaPath }) {
    this._onQr          = onQr;
    this._onReady       = onReady;
    this._onMessages    = onMessages;
    this._onStatus      = onStatus;
    this._onProgress    = onProgress;
    this._onSearchQuery = onSearchQuery;
    this._onDisconnected = onDisconnected;
    this._onMediaPath   = onMediaPath;

    this._sock          = null;
    this._state         = 'DISCONNECTED';
    this._latestQr      = null;
    this._ownerJid      = null;
    this._searchGroupJid = null;
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
  }

  get state()    { return this._state; }
  get latestQr() { return this._latestQr; }

  async start() {
    if (this._sock || this._destroyed) return;
    mkdirSync(AUTH_DIR, { recursive: true });
    await this._connect();
  }

  async logout() {
    this._destroyed = true;
    try { await this._sock?.logout(); } catch {}
    this._sock = null;
    this._setState('DISCONNECTED', 'Logged out');
    this._onDisconnected?.();
  }

  async destroy() {
    this._destroyed = true;
    clearTimeout(this._flushTimer);
    clearTimeout(this._syncDoneTimer);
    this._mediaQueue.length = 0;
    try { this._sock?.end?.(new Error('destroy')); } catch {}
    this._sock = null;
    this._setState('DISCONNECTED', 'Stopped');
  }

  // ── Core connection ────────────────────────────────────────────────────────
  async _connect() {
    if (this._destroyed) return;

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

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
      syncFullHistory: true,
      // Present as an ordinary browser to WhatsApp's servers
      browser: ['WhatsApp Search', 'Chrome', '124.0.0'],
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
          console.log('[WA] QR ready — open http://localhost:3000 to scan');
        } catch (e) { console.error('[WA] QR error:', e.message); }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        console.log(`[WA] Closed — code=${code}, loggedOut=${loggedOut}`);
        this._sock = null;
        if (loggedOut || this._destroyed) {
          this._setState('DISCONNECTED', 'Logged out — rescan QR to reconnect');
          this._onDisconnected?.();
        } else {
          this._setState('LOADING', 'Reconnecting…');
          setTimeout(() => this._connect(), 5000);
        }
      }

      if (connection === 'open') {
        const user = this._sock.user;
        const name = user?.name || user?.verifiedName || user?.id?.split(':')[0] || 'unknown';
        this._ownerJid = user?.id ? jidNormalizedUser(user.id) : null;
        console.log(`[WA] ✅ Connected as ${name}`);
        this._onReady?.({ name, phone: this._ownerJid?.split('@')[0] });
        this._setState('SYNCING', 'Loading chat history…');
        this._historyDone = false;
        this._totalMsgs = 0;

        // Set a fallback timer — mark READY after 15s even if sync events don't fire
        this._armSyncDoneTimer(15_000);

        await this._ensureSearchGroup().catch(e => console.warn('[WA] Group error:', e.message));

        if (this._ownerJid) {
          this._sock?.sendMessage(this._ownerJid, {
            text: `✅ *WhatsApp Search connected!*\n\nHi ${name}! Your chat history is syncing.\n\nSearch via:\n• *Web*: http://localhost:3000\n• *WhatsApp*: message the _${SEARCH_GROUP}_ group`,
          }).catch(() => {});
        }
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

        // Search group query
        if (this._searchGroupJid && jid === this._searchGroupJid && !msg.key.fromMe) {
          const query = extractText(msg).trim();
          if (!query) continue;
          console.log(`[WA] Search query: "${query}"`);
          try {
            const result = await this._onSearchQuery?.(query);
            await this._sock.sendMessage(jid, { text: formatResult(result) });
          } catch (e) {
            this._sock?.sendMessage(jid, { text: `❌ Error: ${e.message}` }).catch(() => {});
          }
          continue;
        }
        // Don't index bot's own replies to the search group
        if (jid === this._searchGroupJid && msg.key.fromMe) continue;

        const row = this._msgToRow(msg);
        if (!row) continue;
        const enriched = await this._enrichRowWithMedia(msg, row);
        rows.push(enriched);
      }
      if (rows.length) this._enqueueBatch(rows);
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

      await this._backfillLidPnChatNamesFromMessages(messages || []);

      for (const m of messages || []) {
        const jid = m.key?.remoteJid;
        if (!jid || jid === this._searchGroupJid || !m.message) continue;
        this._syncByChat.set(jid, (this._syncByChat.get(jid) || 0) + 1);
      }

      const rows = messages
        .filter(m => m.message && m.key.remoteJid !== this._searchGroupJid)
        .map(m => this._msgToRow(m))
        .filter(Boolean);

      if (rows.length) {
        this._onMessages?.(rows);
        for (const m of messages || []) {
          const jid = m.key?.remoteJid;
          if (!jid || jid === this._searchGroupJid || !m.message) continue;
          const row = this._msgToRow(m);
          if (row?.mediaType && MEDIA_FOR_INDEX.has(row.mediaType)) {
            this._queueMediaDownload(m, row);
          }
        }
        this._totalMsgs += rows.length;
        this._onProgress?.({
          completed: 0,
          total: 0,
          messages: this._totalMsgs,
          byChat: Object.fromEntries(this._syncByChat),
        });
        this._setState('SYNCING', `Syncing… ${this._totalMsgs.toLocaleString()} messages received`);
        console.log(`[WA] History batch: +${rows.length} msgs (total ${this._totalMsgs})`);
      }

      // Reset the "done" timer — no more batches for SYNC_DONE_DELAY → mark ready
      this._armSyncDoneTimer(SYNC_DONE_DELAY);
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
    this._chatNames.set(jid, label);
    await this._mirrorDisplayNameAcrossJids(jid, label);
  }

  /**
   * History + live events often carry the same display name on multiple keys (LID chat id, PN contact id, etc.).
   * Baileys `processHistoryMessage` uses id / lidJid / pnJid (chats) and id / lid / phoneNumber (contacts).
   */
  async _applyLabelToLinkedJids(label, ...jids) {
    if (!label || typeof label !== 'string') return;
    const s = label.trim();
    if (!s) return;
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
      return this._nameFromChatMap(jid) || jid.split('@')[0];
    }
    const bare = jid.split('@')[0];
    // PN ⇄ LID: paired JID on the key (see Baileys decodeMessageNode / messages-recv mapping)
    const alts = [msg.key?.remoteJidAlt, msg.key?.participantAlt].filter(Boolean);
    for (const alt of alts) {
      const label = this._nameFromChatMap(alt);
      if (label) {
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
    if (biz) {
      this._chatNames.set(jid, biz);
      void this._mirrorDisplayNameAcrossJids(jid, biz).catch(() => {});
      return biz;
    }
    if (!msg.key.fromMe && msg.pushName) {
      this._chatNames.set(jid, msg.pushName);
      void this._mirrorDisplayNameAcrossJids(jid, msg.pushName).catch(() => {});
      return msg.pushName;
    }
    const cached = this._nameFromChatMap(jid);
    if (cached) return cached;
    return bare;
  }

  // ── Sync-done gate ─────────────────────────────────────────────────────────
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
    if (this._ownerJid && this._totalMsgs > 0) {
      const groupHint = this._searchGroupJid ? `\n• *WhatsApp*: message the _${SEARCH_GROUP}_ group` : '';
      this._sock?.sendMessage(this._ownerJid, {
        text: `🎉 *Sync complete!*\n\n📨 ${this._totalMsgs.toLocaleString()} messages indexed.\n\nSearch:\n• *Web*: http://localhost:3000${groupHint}`,
      }).catch(() => {});
    }
  }

  // ── Search group ───────────────────────────────────────────────────────────
  async _ensureSearchGroup() {
    const cfg = loadCfg();

    if (cfg.searchGroupJid) {
      try {
        await this._sock.groupMetadata(cfg.searchGroupJid);
        this._searchGroupJid = cfg.searchGroupJid;
        console.log(`[WA] Existing search group: ${cfg.searchGroupJid}`);
        this._sock.sendMessage(this._searchGroupJid, {
          text: `👋 *WhatsApp Search is active!*\n\nType any question here to search your chats.\nExample: _what was the most heated argument?_`,
        }).catch(() => {});
        return;
      } catch {}
    }

    let groupJid = null;

    // Strategy 1: empty participants (some WA versions allow it)
    try {
      const r = await this._sock.groupCreate(SEARCH_GROUP, []);
      groupJid = r.id;
    } catch {}

    // Strategy 2: one contact, remove immediately
    if (!groupJid) {
      try {
        const candidates = [...this._chatNames.keys()]
          .filter(j => j.endsWith('@s.whatsapp.net') && j !== this._ownerJid);
        if (candidates.length) {
          const r = await this._sock.groupCreate(SEARCH_GROUP, [candidates[0]]);
          groupJid = r.id;
          if (groupJid) {
            await new Promise(res => setTimeout(res, 1500));
            await this._sock.groupParticipantsUpdate(groupJid, [candidates[0]], 'remove');
          }
        }
      } catch (e) { console.warn('[WA] Group fallback failed:', e.message); }
    }

    if (groupJid) {
      this._searchGroupJid = groupJid;
      saveCfg({ ...cfg, searchGroupJid: groupJid });
      console.log(`[WA] Search group created: ${groupJid}`);
      this._sock.sendMessage(groupJid, {
        text: `🎉 *WhatsApp Search group created!*\n\nThis is your private AI search assistant.\n\n*How to use:* Type any question here.\n\n_Examples:_\n• most heated argument\n• trip plans with Rahul\n• payment discussions last month`,
      }).catch(() => {});
    } else {
      console.warn('[WA] Could not create search group');
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
   * Live metadata (groups + contacts) when the socket is up. Falls back to minimal info on error.
   */
  async getChatDetails(jid) {
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
    const base = {
      chatJid: jid,
      displayName: cachedName || jid.split('@')[0],
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
          subject: meta.subject || base.displayName,
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
        chatName: cachedName || base.displayName,
      };
    } catch (e) {
      return { ...base, waConnected: true, error: e.message };
    }
  }

  async _enrichRowWithMedia(msg, row) {
    if (!row?.mediaType || !MEDIA_FOR_INDEX.has(row.mediaType) || !this._sock) return row;
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: this._mediaLogger,
        reuploadRequest: (m) => this._sock.updateMediaMessage(m),
      });
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
        'application/octet-stream';
      const ext = extFromMime(mime);
      const dir = join(config.mediaDir, safeJidDir(row.chatJid));
      mkdirSync(dir, { recursive: true });
      const filename = `${row.messageId}.${ext}`;
      const fullPath = join(dir, filename);
      writeFileSync(fullPath, buffer);
      return { ...row, mediaPath: fullPath };
    } catch (e) {
      console.warn(`[WA] media download ${row.messageId}:`, e.message);
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

      const text = extractText(msg);
      const m    = msg.message;
      const hasMedia = !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage);
      if (!text && !hasMedia) return null;

      const mediaType = hasMedia
        ? (m.imageMessage ? 'image' : m.videoMessage ? 'video' : m.audioMessage ? 'audio' : m.documentMessage ? 'document' : 'sticker')
        : null;

      const senderJid  = msg.key.participant || (msg.key.fromMe ? this._ownerJid : jid);
      let senderName =
        msg.pushName ||
        this._nameFromChatMap(senderJid) ||
        this._nameFromChatMap(msg.key?.participantAlt) ||
        this._nameFromChatMap(msg.key?.remoteJidAlt) ||
        senderJid?.split('@')[0] ||
        'Unknown';
      const chatName   = this._resolveChatDisplayName(jid, msg);

      return {
        messageId:    msg.key.id || `${msg.messageTimestamp}_${Math.random()}`,
        chatJid:      jid,
        chatName,
        sender:       msg.key.fromMe ? 'You' : senderName,
        senderJid:    senderJid || null,
        text:         text || null,
        mediaType,
        mediaPath:    null,
        mediaCaption: m.imageMessage?.caption || m.videoMessage?.caption || null,
        timestamp:    Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      };
    } catch { return null; }
  }
}
