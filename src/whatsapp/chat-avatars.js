/**
 * Profile / group picture policy for the sidebar.
 *
 * Pictures come from a WhatsApp server query (`w:profile:picture`), not a phone
 * history sync, so fetching them does not raise the "syncing" notification.
 * The bytes are stored locally; the browser never talks to WhatsApp's CDN.
 */

import { isImportedChatJid, isWhatsAppLowPriorityFeed } from './jid-filters.js';

const SAFE_AVATAR_FILE = /^[A-Za-z0-9._-]{1,180}$/;

/** Chats that have a WhatsApp profile or group photo. Imports and feeds do not. */
export function isAvatarEligibleJid(jid) {
  if (!jid || typeof jid !== 'string') return false;
  if (isImportedChatJid(jid) || isWhatsAppLowPriorityFeed(jid)) return false;
  return jid.endsWith('@g.us')
    || jid.endsWith('@s.whatsapp.net')
    || jid.endsWith('@lid')
    || jid.endsWith('@hosted')
    || jid.endsWith('@hosted.lid');
}

/**
 * Newest-first jids that still need a picture lookup.
 * `known` holds jids already saved (including "no photo") so a reconnect does not refetch them.
 *
 * @param {string[]} orderedJids
 * @param {Set<string>} known
 */
export function jidsNeedingAvatars(orderedJids, known) {
  const seen = new Set();
  const out = [];
  const have = known instanceof Set ? known : new Set();
  for (const jid of orderedJids || []) {
    if (!isAvatarEligibleJid(jid) || have.has(jid) || seen.has(jid)) continue;
    seen.add(jid);
    out.push(jid);
  }
  return out;
}

/**
 * Baileys only sets `imgUrl` on a picture notification: `changed`, `removed`, or a URL.
 * Ordinary contact rows omit it and must not be treated as "no photo".
 *
 * @returns {'ignore'|'clear'|'refresh'|'download'}
 */
export function avatarActionForContact(contact) {
  if (!contact || typeof contact !== 'object') return 'ignore';
  if (!Object.prototype.hasOwnProperty.call(contact, 'imgUrl')) return 'ignore';
  const imgUrl = contact.imgUrl;
  if (imgUrl === 'removed') return 'clear';
  if (imgUrl === 'changed') return 'refresh';
  if (typeof imgUrl === 'string' && /^https:\/\//i.test(imgUrl)) return 'download';
  return 'ignore';
}

/**
 * @returns {'missing'|'retry'}
 * `missing` means this chat has no picture we can show (or it is hidden).
 * Anything else should be tried again on a later connection, not stored as "no photo".
 */
export function profilePictureFailure(err) {
  const code = Number(err?.output?.statusCode ?? err?.data?.statusCode ?? 0);
  const msg = `${err?.message || ''} ${err?.output?.payload?.message || ''}`;
  if (code === 404 || /item-not-found/i.test(msg)) return 'missing';
  if (/not-authorized/i.test(msg)) return 'missing';
  return 'retry';
}

/** @returns {'jpg'|'png'|'webp'|null} */
export function imageExtFromBytes(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function avatarFileName(jid, ext) {
  const stem = String(jid || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const safeExt = ext === 'png' || ext === 'webp' ? ext : 'jpg';
  return `${stem}.${safeExt}`;
}

export function isSafeAvatarFileName(name) {
  return typeof name === 'string' && SAFE_AVATAR_FILE.test(name) && !name.includes('..');
}
