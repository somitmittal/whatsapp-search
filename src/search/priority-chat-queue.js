import { isWhatsAppLowPriorityFeed, isChatVisibleInSidebar } from '../whatsapp/jid-filters.js';

/**
 * Order the AI indexing queue, most valuable work first. Mutates `queue` in place.
 *
 * Tiers, in order:
 *  1. chats the sidebar can currently show (WA-synced chats are hidden while WhatsApp
 *     is offline, so indexing them ahead of visible ones is wasted spend)
 *  2. real conversations before Status / broadcast / newsletter feeds
 *  3. recency weighted by message volume
 *
 * @param {{ chatJid: string }[]} queue
 * @param {{ waLive: boolean, indexScore: (chatJid: string) => number }} opts
 */
export function sortChatsForIndexing(queue, { waLive, indexScore }) {
  queue.sort((a, b) => {
    const va = isChatVisibleInSidebar(a.chatJid, waLive) ? 0 : 1;
    const vb = isChatVisibleInSidebar(b.chatJid, waLive) ? 0 : 1;
    if (va !== vb) return va - vb;
    const fa = isWhatsAppLowPriorityFeed(a.chatJid) ? 1 : 0;
    const fb = isWhatsAppLowPriorityFeed(b.chatJid) ? 1 : 0;
    if (fa !== fb) return fa - fb;
    return indexScore(b.chatJid) - indexScore(a.chatJid);
  });
  return queue;
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
