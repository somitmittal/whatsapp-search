/**
 * WhatsApp-style sidebar chat filter: title/phone matches first, then chats
 * that matched the query in message text (keyword hits from FTS).
 */

/**
 * @param {object} chat
 * @param {string} queryLower already trimmed + lowercased
 * @param {{ titleFor?: (chat: object) => string, phoneLabelFor?: (jid: string) => string }} [helpers]
 * @returns {boolean}
 */
export function chatTitleMatchesQuery(chat, queryLower, helpers = {}) {
  const q = String(queryLower || '').trim().toLowerCase();
  if (!q) return true;
  const jid = String(chat?.chatJid || '');
  const titleFn = typeof helpers.titleFor === 'function'
    ? helpers.titleFor
    : (c) => String(c?.chatName || c?.chatJid || '');
  const phoneFn = typeof helpers.phoneLabelFor === 'function'
    ? helpers.phoneLabelFor
    : () => '';
  const hay = String(titleFn(chat) || '').toLowerCase();
  if (hay.includes(q)) return true;
  if (jid.toLowerCase().includes(q)) return true;
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@hosted')) {
    const disp = String(phoneFn(jid) || '').toLowerCase();
    if (disp && disp.includes(q)) return true;
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3 && jid.split('@')[0].includes(digits)) return true;
  }
  return false;
}

/**
 * Rank chats for the sidebar search box.
 * Title matches stay above message-keyword matches; each group keeps recency order.
 *
 * @param {{
 *   chats: object[],
 *   query: string,
 *   keywordHits?: Array<{ chatJid: string, snippet?: string, messageTs?: number }>,
 *   helpers?: { titleFor?: Function, phoneLabelFor?: Function },
 * }} opts
 * @returns {object[]} shallow copies; keyword-only rows may include `searchSnippet`
 */
export function filterAndRankChats({
  chats,
  query,
  keywordHits = [],
  helpers = {},
} = {}) {
  const q = String(query || '').trim().toLowerCase();
  const list = Array.isArray(chats) ? chats : [];
  if (!q) return list.slice();

  const byJid = new Map();
  for (const c of list) {
    if (c?.chatJid) byJid.set(String(c.chatJid), c);
  }

  const titleHits = [];
  const titleJids = new Set();
  for (const c of list) {
    if (!c?.chatJid) continue;
    if (!chatTitleMatchesQuery(c, q, helpers)) continue;
    titleHits.push(c);
    titleJids.add(String(c.chatJid));
  }
  titleHits.sort((a, b) => (b.lastMessageTs || 0) - (a.lastMessageTs || 0));

  const keywordOnly = [];
  const seenKeyword = new Set();
  for (const hit of keywordHits || []) {
    const jid = hit?.chatJid != null ? String(hit.chatJid) : '';
    if (!jid || titleJids.has(jid) || seenKeyword.has(jid)) continue;
    const base = byJid.get(jid);
    if (!base) continue;
    seenKeyword.add(jid);
    const snippet = String(hit.snippet || '').trim();
    keywordOnly.push({
      ...base,
      searchSnippet: snippet || undefined,
      lastMessagePreview: snippet || base.lastMessagePreview,
      lastMessageTs: Number(hit.messageTs) || base.lastMessageTs,
    });
  }
  keywordOnly.sort((a, b) => (b.lastMessageTs || 0) - (a.lastMessageTs || 0));

  return [...titleHits, ...keywordOnly];
}
