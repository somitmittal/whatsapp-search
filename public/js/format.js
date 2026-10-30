import { store } from './store.js';

/** Message `timestamp` from API is unix seconds; tolerate accidental ms */
export function messageTimestampToDate(ts) {
  if (ts == null || ts === '') return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  const sec = n > 1e12 ? Math.round(n / 1000) : Math.round(n);
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function dateFmt(key) {
  if (!store._dateFormatters) {
    store._dateFormatters = {
      usShortDateYear: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      usShortDate: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }),
      usTime12: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
      usWeekday: new Intl.DateTimeFormat('en-US', { weekday: 'short' }),
      separator: new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
      bubbleTime: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
      full: new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      }),
    };
  }
  return store._dateFormatters[key];
}

/** Sticky date headings between message groups */
export function formatChatDateSeparator(d) {
  const start = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((start(new Date()) - start(d)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return dateFmt('separator').format(d);
}

/** Clock inside a bubble. The full date lives on the date separator above the group. */
export function formatChatBubbleDateTime(d) {
  return dateFmt('bubbleTime').format(d);
}

function receiptKindFromStatus(status) {
  const n = Number(status);
  if (!Number.isInteger(n)) return '';
  if (n <= 1) return 'pending';
  if (n === 2) return 'sent';
  if (n === 3) return 'delivered';
  if (n >= 4) return 'read';
  return '';
}

export function receiptTicksHtml(status) {
  const kind = receiptKindFromStatus(status);
  if (!kind) return '';
  const check = '<svg viewBox="0 0 16 11" width="16" height="11" aria-hidden="true"><path fill="currentColor" d="M11.3 1.1 5.4 7 2.6 4.2 1.2 5.6 5.4 9.8 12.7 2.5z"/></svg>';
  const clock = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.2V6l2 1.2" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  const label = { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read' }[kind];
  if (kind === 'pending') return `<span class="msg-ticks pending" title="${label}">${clock}</span>`;
  if (kind === 'sent') return `<span class="msg-ticks sent" title="${label}">${check}</span>`;
  return `<span class="msg-ticks double ${kind}" title="${label}">${check}${check}</span>`;
}

export function formatDate(ts) {
  const d = messageTimestampToDate(ts);
  if (!d) return '';
  const now = new Date();
  const diff = (now - d) / 86400000;
  if (diff < 0) {
    return dateFmt('usShortDateYear').format(d);
  }
  if (diff < 1 && d.getDate() === now.getDate()) return dateFmt('usTime12').format(d);
  if (diff < 2) return 'Yesterday';
  if (diff < 7) return dateFmt('usWeekday').format(d);
  return dateFmt(d.getFullYear() !== now.getFullYear() ? 'usShortDateYear' : 'usShortDate').format(d);
}

export function formatCount(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }

export function formatPhoneLikeName(nameOrJid) {
  const raw = String(nameOrJid || '').trim();
  if (!raw) return '';
  // Extract digits from either a chat name or a JID local-part.
  const digits = raw.split('@')[0].replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) return raw;
  // If we can infer a country code, format as +CC NNNNNNNNNN (last 10 digits as national number).
  if (digits.length > 10) {
    const cc = digits.slice(0, digits.length - 10);
    const national = digits.slice(-10);
    return `+${cc} ${national}`;
  }
  // Otherwise just add a plus for readability.
  return `+${digits}`;
}

function looksLikeLidFallbackContactLabel(s) {
  return /^contact\s*\(\s*[\d\s]{1,14}\s*\)\s*$/i.test(String(s || '').trim());
}

function looksLikeOpaqueNumericId(s) {
  const t = String(s || '').replace(/\s/g, '');
  return /^\d+$/.test(t) && t.length >= 12;
}

function looksLikeMaskedPhoneLabel(s) {
  const t = String(s || '').trim();
  if (!t || !/[∙•·⋅⬤*]/.test(t)) return false;
  const digits = t.replace(/[^\d]/g, '');
  return digits.length >= 2 && digits.length <= 15 && /^[+\d\s()∙•·⋅⬤*-]+$/.test(t);
}

function prettyImportedChatTitle(name) {
  let t = String(name || '').trim();
  if (!t) return '';
  t = t
    .replace(/^WhatsApp Chat with\s+/i, '')
    .replace(/^WhatsApp Chat\s*[-–—:]\s*/i, '')
    .replace(/^WhatsApp Chat\s+/i, '')
    .trim();
  return t || String(name || '').trim();
}

export function displayChatTitle(chatJid, chatName) {
  const jid = String(chatJid || '').trim();
  const raw = String(chatName || '').trim();
  const isGroup = jid.endsWith('@g.us');
  const isImported = jid.endsWith('@imported');

  if (isImported) {
    // Never fall back to the synthetic slug (`import_…@imported`) — that is what made
    // titles flicker between the export name and "import" / "Sovrenn".
    const pretty = prettyImportedChatTitle(raw);
    if (pretty && pretty !== jid && pretty !== (jid.split('@')[0] || '')) return pretty;
    return pretty || 'Imported chat';
  }

  if (isGroup) {
    return raw || jid;
  }

  const pnUser = jid.endsWith('@s.whatsapp.net');
  const hostedUser = jid.endsWith('@hosted');
  const lidUser = jid.endsWith('@lid');
  // LID leftovers after PN merge: "Contact (…)", long digit LIDs, privacy-masked phones.
  if (
    (pnUser || hostedUser)
    && (
      looksLikeLidFallbackContactLabel(raw)
      || looksLikeOpaqueNumericId(raw)
      || looksLikeMaskedPhoneLabel(raw)
    )
  ) {
    return formatPhoneLikeName(jid);
  }
  if (lidUser && (looksLikeOpaqueNumericId(raw) || !raw)) {
    const tail = (jid.split('@')[0] || '').replace(/\D/g, '').slice(-6);
    return tail ? `Contact (${tail})` : 'Contact';
  }
  const localPart = jid.split('@')[0] || '';
  const localDigits = localPart.replace(/[^\d]/g, '');

  const isJidLikeName =
    raw === jid ||
    (raw.endsWith('@s.whatsapp.net') && raw.split('@')[0] === localPart) ||
    (pnUser && localDigits.length >= 8 && raw === localPart);

  if (pnUser && isJidLikeName) {
    return formatPhoneLikeName(jid);
  }

  if (raw.includes('@s.whatsapp.net')) {
    return formatPhoneLikeName(raw);
  }

  if (raw && /^[+\d\s()-]{8,24}$/.test(raw) && raw.replace(/[^\d]/g, '').length >= 8) {
    const digits = raw.replace(/[^\d]/g, '');
    if (/^\d{8,20}$/.test(digits)) return formatPhoneLikeName(digits);
  }

  if (!raw) {
    if (pnUser) return formatPhoneLikeName(jid);
    return jid;
  }

  return raw;
}

/**
 * Does `chatName` actually identify the chat, or is it just the JID/phone restated?
 *
 * Defined against displayChatTitle so the two can never disagree: if supplying the name
 * renders the same title as supplying nothing, the name carried no information.
 */
export function isResolvedChatName(chatJid, chatName) {
  const jid = String(chatJid || '').trim();
  const raw = String(chatName || '').trim();
  if (!raw) return false;
  // Groups fall back to the full JID, so a bare local part would otherwise look resolved.
  if (raw === jid || raw === (jid.split('@')[0] || '')) return false;
  if (jid.endsWith('@imported')) {
    // Synthetic slug leftovers ("import", "import_family…") are never a real title.
    if (/^import(_|$)/i.test(raw)) return false;
    const pretty = prettyImportedChatTitle(raw);
    if (!pretty || pretty === 'Imported chat') return false;
  }
  return displayChatTitle(jid, raw) !== displayChatTitle(jid, '');
}
