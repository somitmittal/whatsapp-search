/**
 * Shared rules for chat titles and sender labels — rejects URLs, opaque WA ids, and junk pushNames.
 */

export function looksLikeUrlOrSocialJunk(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/\b(instagram|facebook|tiktok|youtube|twitter|x)\.com\//i.test(t)) return true;
  if (/\s[\w.-]+\.(com|net|org|io)\//i.test(t) && t.length > 24) return true;
  return false;
}

/** Long all-digit strings are often internal LID fragments — not a display name. */
export function looksLikeOpaqueNumericId(s) {
  const t = String(s || '').replace(/\s/g, '');
  if (!/^\d+$/.test(t)) return false;
  return t.length >= 12;
}

/**
 * WhatsApp placeholder when a 1:1 chat is keyed by @lid and no phone title is known yet.
 * Must not beat a real formatted phone number in pickBetterChatTitle / sidebar.
 */
export function looksLikeLidFallbackContactLabel(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  return /^contact\s*\(\s*[\d\s]{1,14}\s*\)\s*$/i.test(t);
}

export function looksLikePhoneDigitsOnly(str) {
  if (!str || typeof str !== 'string') return false;
  const d = str.replace(/\s/g, '').replace(/^\+/, '');
  return /^\d{8,20}$/.test(d);
}

export function formatPhoneLocalPart(bare) {
  const raw = String(bare || '').trim();
  const d = raw.replace(/\D/g, '');
  if (d.length < 8 || d.length > 15) return raw || '';
  if (d.length > 10) {
    const cc = d.slice(0, d.length - 10);
    const national = d.slice(-10);
    return `+${cc} ${national}`;
  }
  return `+${d}`;
}

export function fallbackTitleForOneOnOneJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const bare = jid.split('@')[0] || '';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted')) {
    return formatPhoneLocalPart(bare);
  }
  if (jid.endsWith('@lid')) {
    const tail = (bare.replace(/\D/g, '').slice(-6) || bare.slice(-6) || '').slice(-8);
    return tail ? `Contact (${tail})` : 'Contact';
  }
  return bare || jid;
}

/**
 * True if this string is worth showing as a human chat title (sidebar / header), vs bare JID / phone / junk.
 */
export function isPlausibleHumanChatTitle(name, chatJid) {
  if (!name || typeof name !== 'string') return false;
  const t = name.trim();
  if (t.length < 2) return false;
  if (looksLikeLidFallbackContactLabel(t)) return false;
  if (looksLikeUrlOrSocialJunk(t)) return false;
  if (looksLikeOpaqueNumericId(t)) return false;
  const local = String(chatJid || '').split('@')[0];
  if (t === local) return false;
  const digitsOnly = t.replace(/\s/g, '').replace(/^\+/, '');
  const localDigits = local.replace(/^\+/, '');
  if (/^\d{8,16}$/.test(digitsOnly) && digitsOnly === localDigits) return false;
  return true;
}

function titlePreferenceRank(s, chatJid) {
  if (!s || !String(s).trim()) return 0;
  const t = String(s).trim();
  if (looksLikeUrlOrSocialJunk(t) || looksLikeOpaqueNumericId(t)) return 0;
  if (looksLikeLidFallbackContactLabel(t)) return 0;
  if (looksLikePhoneDigitsOnly(t)) return 1;
  if (isPlausibleHumanChatTitle(t, chatJid)) return 3;
  return 2;
}

export function pickBetterChatTitle(a, b, chatJid = '') {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  const rx = titlePreferenceRank(x, chatJid);
  const ry = titlePreferenceRank(y, chatJid);
  if (rx !== ry) return rx > ry ? x : y;
  return x.length >= y.length ? x : y;
}

/** Drop junk pushNames; keep plausible names or phone-shaped labels. */
export function sanitizePeerSenderName(name, chatJid) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (!t || t === 'You') return t || null;
  if (looksLikeUrlOrSocialJunk(t) || looksLikeOpaqueNumericId(t)) return null;
  if (looksLikePhoneDigitsOnly(t)) return t;
  if (isPlausibleHumanChatTitle(t, chatJid)) return t;
  return null;
}
