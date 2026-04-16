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
} = require('@whiskeysockets/baileys');
const QRCode   = require('qrcode');
const P        = require('pino');

const AUTH_DIR         = join(config.dataDir, '.baileys_auth');
const CONFIG_FILE      = join(config.dataDir, 'wa-config.json');
const SEARCH_GROUP     = '🔍 WhatsApp Search';
const BATCH_MS         = 2000;
const SYNC_DONE_DELAY  = 8_000; // ms of silence after last history batch → mark READY

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
  constructor({ onQr, onReady, onMessages, onStatus, onProgress, onSearchQuery, onDisconnected }) {
    this._onQr          = onQr;
    this._onReady       = onReady;
    this._onMessages    = onMessages;
    this._onStatus      = onStatus;
    this._onProgress    = onProgress;
    this._onSearchQuery = onSearchQuery;
    this._onDisconnected = onDisconnected;

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
    this._sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
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
        if (row) rows.push(row);
      }
      if (rows.length) this._enqueueBatch(rows);
    });

    // ── History sync (fires in one or more batches) ───────────────────────
    this._sock.ev.on('messaging-history.set', async ({ chats, messages, contacts }) => {
      try {
        for (const c of (chats || [])) {
          if (c.id && c.name) await this._applyDisplayName(c.id, c.name);
        }
        for (const c of (contacts || [])) {
          const label = c.name || c.notify || c.verifiedName;
          if (c.id && label) await this._applyDisplayName(c.id, label);
        }
      } catch (e) {
        console.warn('[WA] history name hydrate:', e.message);
      }

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
        if (c.id && c.name) await this._applyDisplayName(c.id, c.name);
      }
    });
    this._sock.ev.on('chats.upsert', async (chats) => {
      for (const c of chats || []) {
        if (c.id && c.name) await this._applyDisplayName(c.id, c.name);
      }
    });
    this._sock.ev.on('chats.update', async (updates) => {
      for (const u of updates || []) {
        if (u.id && u.name) await this._applyDisplayName(u.id, u.name);
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
    if (!c?.id) return;
    const label = c.name || c.notify || c.verifiedName;
    if (label) await this._applyDisplayName(c.id, label);
  }

  /**
   * Group titles come from chat/group metadata; 1:1 chats often only get a name via contact events
   * or incoming `pushName` (peer display name) — use that so the sidebar matches WhatsApp.
   */
  _resolveChatDisplayName(jid, msg) {
    if (isJidGroup(jid)) {
      return this._chatNames.get(jid) || jid.split('@')[0];
    }
    const bare = jid.split('@')[0];
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
    const cached = this._chatNames.get(jid);
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
    const cachedName = this._chatNames.get(jid);
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
      const senderName = msg.pushName || this._chatNames.get(senderJid) || senderJid?.split('@')[0] || 'Unknown';
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
