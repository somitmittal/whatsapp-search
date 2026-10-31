import { isWhatsAppLowPriorityFeed } from './jid-filters.js';

/**
 * Normalize one or many priority chat JIDs (newest-first ordered list).
 * @param {string | string[] | null | undefined} priorityChatJids
 * @returns {string[]}
 */
export function normalizePriorityChatJids(priorityChatJids) {
  if (Array.isArray(priorityChatJids)) {
    const seen = new Set();
    const out = [];
    for (const raw of priorityChatJids) {
      const jid = String(raw || '').trim();
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      out.push(jid);
    }
    return out;
  }
  const one = String(priorityChatJids || '').trim();
  return one ? [one] : [];
}

/**
 * Sort deferred WhatsApp media in place: optional explicit chat bump first (newest-open
 * first), then real conversations before Status / broadcast / newsletter feeds, then
 * chats active in the recent window, then latest chat activity, then latest media.
 *
 * @param {Array<{row?: {chatJid?: string, timestamp?: number}}>} queue
 * @param {number} recentCutoffTs unix seconds
 * @param {string | string[] | null} [priorityChatJids] when set, those chats drain first
 */
export function sortDeferredMediaByChatActivity(queue, recentCutoffTs, priorityChatJids = null) {
  const priority = normalizePriorityChatJids(priorityChatJids);
  const priorityRank = new Map(priority.map((jid, i) => [jid, i]));
  const latestByChat = new Map();
  for (const { row } of queue || []) {
    const jid = row?.chatJid;
    const ts = Number(row?.timestamp) || 0;
    if (jid && ts > (latestByChat.get(jid) || 0)) latestByChat.set(jid, ts);
  }
  queue.sort((a, b) => {
    if (priority.length) {
      const ap = priorityRank.has(a.row?.chatJid) ? priorityRank.get(a.row.chatJid) : priority.length;
      const bp = priorityRank.has(b.row?.chatJid) ? priorityRank.get(b.row.chatJid) : priority.length;
      if (ap !== bp) return ap - bp;
    }
    const af = isWhatsAppLowPriorityFeed(a.row?.chatJid) ? 1 : 0;
    const bf = isWhatsAppLowPriorityFeed(b.row?.chatJid) ? 1 : 0;
    if (af !== bf) return af - bf;
    const ac = latestByChat.get(a.row?.chatJid) || 0;
    const bc = latestByChat.get(b.row?.chatJid) || 0;
    const ar = ac >= recentCutoffTs ? 0 : 1;
    const br = bc >= recentCutoffTs ? 0 : 1;
    if (ar !== br) return ar - br;
    if (ac !== bc) return bc - ac;
    return (Number(b.row?.timestamp) || 0) - (Number(a.row?.timestamp) || 0);
  });
  return queue;
}

/**
 * Pop the next deferred media item. After history completes, drain FIFO (already sorted).
 * While history is still running, only yield items for priority chats (newest-open first).
 *
 * @param {Array<{row?: {chatJid?: string}}>} queue
 * @param {{ historyDone?: boolean, priorityChatJid?: string | null, priorityChatJids?: string | string[] | null }} opts
 * @returns {{row?: object, msg?: object} | null}
 */
export function takeNextDeferredMediaItem(queue, {
  historyDone = false,
  priorityChatJid = null,
  priorityChatJids = null,
} = {}) {
  if (!Array.isArray(queue) || !queue.length) return null;
  if (historyDone) return queue.shift() || null;
  const priority = normalizePriorityChatJids(
    priorityChatJids != null ? priorityChatJids : priorityChatJid,
  );
  if (!priority.length) return null;
  for (const jid of priority) {
    const idx = queue.findIndex((item) => item?.row?.chatJid === jid);
    if (idx >= 0) return queue.splice(idx, 1)[0];
  }
  return null;
}
