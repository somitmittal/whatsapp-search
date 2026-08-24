import {
  isWhatsAppLowPriorityFeed,
  isChatVisibleInSidebar,
  isImportedChatJid,
} from '../whatsapp/jid-filters.js';

/**
 * Order the AI indexing queue, most valuable work first. Mutates `queue` in place.
 *
 * Tiers, in order:
 *  1. live and imported sources are separate tiers (live first while WhatsApp is linked,
 *     imported first while it is offline)
 *  2. real conversations before Status / broadcast / newsletter feeds
 *  3. live chats active inside the recent window before older live chats
 *  4. recency weighted by message volume
 *
 * @param {{ chatJid: string }[]} queue
 * @param {{
 *   waLive: boolean,
 *   indexScore: (chatJid: string) => number,
 *   lastMessageTs?: (chatJid: string) => number,
 *   recentCutoffTs?: number
 * }} opts
 */
export function sortChatsForIndexing(
  queue,
  { waLive, indexScore, lastMessageTs = () => 0, recentCutoffTs = 0 },
) {
  queue.sort((a, b) => {
    const va = isChatVisibleInSidebar(a.chatJid, waLive) ? 0 : 1;
    const vb = isChatVisibleInSidebar(b.chatJid, waLive) ? 0 : 1;
    if (va !== vb) return va - vb;
    const ia = isImportedChatJid(a.chatJid) ? 1 : 0;
    const ib = isImportedChatJid(b.chatJid) ? 1 : 0;
    if (ia !== ib) return waLive ? ia - ib : ib - ia;
    const fa = isWhatsAppLowPriorityFeed(a.chatJid) ? 1 : 0;
    const fb = isWhatsAppLowPriorityFeed(b.chatJid) ? 1 : 0;
    if (fa !== fb) return fa - fb;
    if (!ia && recentCutoffTs > 0) {
      const ra = lastMessageTs(a.chatJid) >= recentCutoffTs ? 0 : 1;
      const rb = lastMessageTs(b.chatJid) >= recentCutoffTs ? 0 : 1;
      if (ra !== rb) return ra - rb;
    }
    return indexScore(b.chatJid) - indexScore(a.chatJid);
  });
  return queue;
}

/**
 * Return one source queue at a time so a processing batch never mixes live and imported work.
 * The secondary queue is handled by the next pass after the primary source has drained.
 */
export function splitChatsBySource(queue, waLive) {
  const live = queue.filter((row) => !isImportedChatJid(row.chatJid));
  const imported = queue.filter((row) => isImportedChatJid(row.chatJid));
  return waLive
    ? { primary: live, secondary: imported, primarySource: 'live' }
    : { primary: imported, secondary: live, primarySource: 'imported' };
}

/**
 * Move preferredChatJid to the front of the AI indexing queue if present.
 * Mutates `queue` in place.
 *
 * @param {{ chatJid: string }[]} queue
 * @param {string|null|undefined} preferredChatJid
 * @returns {boolean} true if the queue was reordered
 */
export function prioritizeChatFirst(queue, preferredChatJid) {
  if (!preferredChatJid || !Array.isArray(queue) || queue.length < 2) return false;
  const idx = queue.findIndex((w) => w.chatJid === preferredChatJid);
  if (idx <= 0) return false;
  const [item] = queue.splice(idx, 1);
  queue.unshift(item);
  return true;
}
