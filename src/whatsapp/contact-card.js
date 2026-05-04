/**
 * Parse WhatsApp contactMessage / contactsArrayMessage (+ embedded vCards) for storage and UI.
 */

const MAX_RAW_VCARD_CHARS = 14000;

/** @param {string} s */
function unescapeVCardValue(s) {
  return String(s || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** Unfold RFC 6350 folded lines (continuation starts with space or tab). */
function unfoldVCardLines(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/**
 * @param {string} vcardRaw
 * @returns {{ fn: string, n: string, org: string, phones: string[], emails: string[] }}
 */
export function parseVCardFields(vcardRaw) {
  const out = { fn: '', n: '', org: '', phones: [], emails: [] };
  const raw = String(vcardRaw || '');
  if (!raw.trim()) return out;
  const lines = unfoldVCardLines(raw);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const head = line.slice(0, idx).trim().toUpperCase();
    const val = unescapeVCardValue(line.slice(idx + 1));
    if (!val) continue;
    const prop = head.split(';')[0];
    if (prop === 'FN') out.fn = val;
    else if (prop === 'N') out.n = val;
    else if (prop === 'ORG') out.org = val;
    else if (prop === 'TEL' || prop.endsWith('.TEL')) out.phones.push(val);
    else if (prop === 'EMAIL' || prop.endsWith('.EMAIL')) out.emails.push(val);
  }
  return out;
}

/** N:Doe;John;;; → readable name */
export function formatVCardNField(nField) {
  const parts = String(nField || '').split(';');
  const family = (parts[0] || '').trim();
  const given = (parts[1] || '').trim();
  const extra = (parts[2] || '').trim();
  const combined = [given, extra, family].filter(Boolean).join(' ').trim();
  return combined || family || given || '';
}

/**
 * @param {{ displayName?: string|null, vcard?: string|null }} cm — proto IContactMessage
 */
export function normalizeContactEntry(cm) {
  if (!cm || typeof cm !== 'object') return null;
  const displayName = cm.displayName != null ? String(cm.displayName).trim() : '';
  const rawVcard = cm.vcard != null ? String(cm.vcard) : '';
  const p = parseVCardFields(rawVcard);
  const name =
    displayName ||
    p.fn ||
    formatVCardNField(p.n) ||
    'Contact';
  const phones = [...new Set(p.phones.filter(Boolean))];
  const emails = [...new Set(p.emails.filter(Boolean))];
  const organization = (p.org || '').trim();
  const raw =
    rawVcard.length > MAX_RAW_VCARD_CHARS ? `${rawVcard.slice(0, MAX_RAW_VCARD_CHARS)}\n…` : rawVcard;
  return {
    displayName: name,
    phones,
    emails,
    organization,
    rawVcard: raw,
  };
}

function summaryLinesForContact(c) {
  const lines = [];
  lines.push(`📇 ${c.displayName}`);
  if (c.organization) lines.push(`Organization: ${c.organization}`);
  for (const ph of c.phones) lines.push(`Phone: ${ph}`);
  for (const em of c.emails) lines.push(`Email: ${em}`);
  return lines;
}

function summaryTextSingle(c) {
  return summaryLinesForContact(c).join('\n');
}

function summaryTextArray(title, contacts) {
  const lines = [];
  lines.push(title ? `📇 ${title}` : `📇 ${contacts.length} contacts`);
  for (const c of contacts) {
    lines.push('');
    lines.push(...summaryLinesForContact(c).map((x, i) => (i === 0 ? x : `   ${x.replace(/^📇 /, '')}`)));
  }
  return lines.join('\n').trim();
}

/**
 * @param {object} inner — proto Message after extractMessageContent
 * @returns {{ summaryText: string, payload: object } | null}
 */
export function buildContactPayloadFromInner(inner) {
  if (!inner || typeof inner !== 'object') return null;

  if (inner.contactMessage) {
    const c = normalizeContactEntry(inner.contactMessage);
    if (!c) return null;
    return {
      summaryText: summaryTextSingle(c),
      payload: { kind: 'single', contacts: [c] },
    };
  }

  if (inner.contactsArrayMessage) {
    const rawList = inner.contactsArrayMessage.contacts;
    const arr = Array.isArray(rawList) ? rawList : [];
    const contacts = arr.map(normalizeContactEntry).filter(Boolean);
    if (!contacts.length) return null;
    const title =
      inner.contactsArrayMessage.displayName != null
        ? String(inner.contactsArrayMessage.displayName).trim()
        : '';
    return {
      summaryText: summaryTextArray(title, contacts),
      payload: {
        kind: 'array',
        title: title || null,
        contacts,
      },
    };
  }

  return null;
}
