/**
 * WhatsApp Cloud API (WABA) — webhook ingestion and message normalization.
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'fs';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import config from '../config.js';
import {
  WABA_LAST_ERROR,
  WABA_LAST_WEBHOOK_AT,
  WABA_MESSAGES_RECEIVED,
  getWabaConfig,
} from './waba-settings.js';

const GRAPH_VERSION = (process.env.WABA_GRAPH_API_VERSION || 'v21.0').trim();

/** @param {string} waId E.164 without + */
export function wabaChatJid(waId) {
  const digits = String(waId || '').replace(/\D/g, '');
  return `waba:+${digits}`;
}

export function wabaMessageId(wamid) {
  return `waba:${String(wamid || '').trim()}`;
}

/**
 * @param {object} msg Cloud API message object
 * @returns {{ text: string | null, mediaType: string | null, mediaId: string | null, caption: string | null }}
 */
export function extractWabaMessageContent(msg) {
  if (!msg || typeof msg !== 'object') {
    return { text: null, mediaType: null, mediaId: null, caption: null };
  }
  const type = msg.type;
  if (type === 'text') {
    return { text: msg.text?.body || null, mediaType: null, mediaId: null, caption: null };
  }
  if (type === 'image') {
    return {
      text: msg.image?.caption || null,
      mediaType: 'image',
      mediaId: msg.image?.id || null,
      caption: msg.image?.caption || null,
    };
  }
  if (type === 'video') {
    return {
      text: msg.video?.caption || null,
      mediaType: 'video',
      mediaId: msg.video?.id || null,
      caption: msg.video?.caption || null,
    };
  }
  if (type === 'audio' || type === 'voice') {
    const block = msg.audio || msg.voice;
    return { text: null, mediaType: 'audio', mediaId: block?.id || null, caption: null };
  }
  if (type === 'document') {
    return {
      text: msg.document?.caption || msg.document?.filename || null,
      mediaType: 'document',
      mediaId: msg.document?.id || null,
      caption: msg.document?.caption || null,
    };
  }
  if (type === 'sticker') {
    return { text: null, mediaType: 'sticker', mediaId: msg.sticker?.id || null, caption: null };
  }
  if (type === 'location') {
    const loc = msg.location || {};
    const label = [loc.name, loc.address].filter(Boolean).join(' — ');
    const coords = loc.latitude != null && loc.longitude != null
      ? `${loc.latitude}, ${loc.longitude}`
      : '';
    return { text: label || coords || '[location]', mediaType: null, mediaId: null, caption: null };
  }
  if (type === 'contacts') {
    const names = (msg.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean);
    return { text: names.length ? `Contact: ${names.join(', ')}` : '[contacts]', mediaType: null, mediaId: null, caption: null };
  }
  if (type === 'button' || type === 'interactive') {
    const t = msg.button?.text || msg.interactive?.button_reply?.title
      || msg.interactive?.list_reply?.title || msg.interactive?.list_reply?.description;
    return { text: t || `[${type}]`, mediaType: null, mediaId: null, caption: null };
  }
  return { text: type ? `[${type}]` : null, mediaType: null, mediaId: null, caption: null };
}

/**
 * @param {object} params
 * @returns {object | null} row for insertMessage
 */
export function normalizeInboundWabaMessage({
  msg,
  contactName,
  timestamp,
  businessDisplayName = 'You',
}) {
  if (!msg?.id || !msg.from) return null;
  const { text, mediaType, mediaId, caption } = extractWabaMessageContent(msg);
  const ts = Number(timestamp) || Number(msg.timestamp) || Math.floor(Date.now() / 1000);
  const from = String(msg.from);
  const chatJid = wabaChatJid(from);
  const name = contactName || from;
  const isEcho = msg.from === msg.to; // rare in inbound webhook

  return {
    messageId: wabaMessageId(msg.id),
    chatJid,
    chatName: name,
    sender: isEcho ? businessDisplayName : name,
    senderJid: isEcho ? 'waba:business' : wabaChatJid(from),
    text,
    mediaType,
    mediaPath: null,
    mediaCaption: caption,
    timestamp: ts,
    _wabaMediaId: mediaId,
  };
}

/**
 * @param {string} appSecret
 * @param {string} rawBody
 * @param {string | undefined} signatureHeader x-hub-signature-256
 */
export function verifyWabaSignature(appSecret, rawBody, signatureHeader) {
  if (!appSecret || !signatureHeader || !rawBody) return !appSecret;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signatureHeader));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * @param {string} accessToken
 * @param {string} mediaId
 * @param {string} destPath
 */
export async function downloadWabaMedia(accessToken, mediaId, destPath) {
  const metaRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!metaRes.ok) {
    throw new Error(`WABA media meta ${metaRes.status}`);
  }
  const meta = await metaRes.json();
  const url = meta.url;
  if (!url) throw new Error('WABA media URL missing');

  const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!fileRes.ok) throw new Error(`WABA media download ${fileRes.status}`);
  mkdirSync(join(destPath, '..'), { recursive: true });
  await pipeline(fileRes.body, createWriteStream(destPath));
  return destPath;
}

export default class WabaIngestService {
  /**
   * @param {object} opts
   * @param {import('../storage/database.js').default} opts.db
   * @param {(payload: object, tenantId: string) => void} [opts.onBroadcast]
   * @param {{ enqueueByMessageIds?: (ids: string[]) => void }} [opts.actionItemService]
   * @param {{ scheduleProcess?: () => void }} [opts.mediaIndexService]
   */
  constructor({ db, onBroadcast, actionItemService, mediaIndexService }) {
    this.db = db;
    this.onBroadcast = onBroadcast;
    this.actionItemService = actionItemService;
    this.mediaIndexService = mediaIndexService;
  }

  /**
   * @param {import('../storage/database.js').default} db
   * @param {string} phoneNumberId
   */
  static findTenantForPhoneNumberId(db, phoneNumberId) {
    if (!phoneNumberId) return null;
    return db.findTenantIdBySetting('waba_phone_number_id', String(phoneNumberId));
  }

  handleVerification(query, db) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const cfg = getWabaConfig(db);
    if (mode === 'subscribe' && token && token === cfg.verifyToken) {
      return { ok: true, challenge: String(challenge || '') };
    }
    return { ok: false };
  }

  /**
   * @param {object} body parsed JSON webhook body
   * @param {string} tenantId
   */
  async ingestWebhookBody(body, tenantId) {
    if (!body || body.object !== 'whatsapp_business_account') {
      return { processed: 0, skipped: true };
    }
    const cfg = getWabaConfig(this.db);
    let processed = 0;
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (cfg.phoneNumberId && phoneNumberId && phoneNumberId !== cfg.phoneNumberId) {
          continue;
        }
        const contactsByWaId = new Map();
        for (const c of value.contacts || []) {
          if (c.wa_id) {
            contactsByWaId.set(String(c.wa_id), c.profile?.name || null);
          }
        }
        for (const msg of value.messages || []) {
          try {
            const row = normalizeInboundWabaMessage({
              msg,
              contactName: contactsByWaId.get(String(msg.from)),
              timestamp: msg.timestamp,
            });
            if (!row) continue;
            if (this.db.getMessageRowByMessageId(row.messageId)) continue;

            const mediaId = row._wabaMediaId;
            delete row._wabaMediaId;

            const rowId = this.db.insertMessage(row);
            if (rowId && mediaId && cfg.accessToken) {
              const safeDir = join(config.mediaDir, 'waba', String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '_'));
              mkdirSync(safeDir, { recursive: true });
              const ext = row.mediaType === 'image' ? 'jpg' : row.mediaType === 'video' ? 'mp4' : 'bin';
              const dest = join(safeDir, `${String(msg.id).replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`);
              try {
                await downloadWabaMedia(cfg.accessToken, mediaId, dest);
                this.db.updateMessageMediaPath(row.messageId, dest);
                this.mediaIndexService?.scheduleProcess?.();
              } catch (e) {
                console.warn('[WABA] media:', e.message);
              }
            }

            if (rowId) {
              processed += 1;
              this.actionItemService?.enqueueByMessageIds?.([row.messageId]);
              this.onBroadcast?.({
                type: 'new-messages',
                data: { count: 1, chatTouches: [{ chatJid: row.chatJid, count: 1, lastMessageTs: row.timestamp }] },
              }, tenantId);
            }
          } catch (e) {
            console.warn('[WABA] message:', e.message);
            this.db.setSetting(WABA_LAST_ERROR, e.message);
          }
        }
      }
    }

    if (processed > 0) {
      const prev = Number(this.db.getSetting(WABA_MESSAGES_RECEIVED) || 0) || 0;
      this.db.setSetting(WABA_MESSAGES_RECEIVED, String(prev + processed));
    }
    this.db.setSetting(WABA_LAST_WEBHOOK_AT, String(Math.floor(Date.now() / 1000)));
    this.db.setSetting(WABA_LAST_ERROR, '');
    return { processed, skipped: false };
  }
}
