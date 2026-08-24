import { isWhatsAppLowPriorityFeed } from './jid-filters.js';

/**
 * Sort deferred WhatsApp media in place: real conversations before Status / broadcast /
 * newsletter feeds, then chats active in the recent window, then latest chat activity,
 * then latest media inside each chat.
 *
 * @param {Array<{row?: {chatJid?: string, timestamp?: number}}>} queue
 * @param {number} recentCutoffTs unix seconds
 */
export function sortDeferredMediaByChatActivity(queue, recentCutoffTs) {
  const latestByChat = new Map();
  for (const { row } of queue || []) {
    const jid = row?.chatJid;
    const ts = Number(row?.timestamp) || 0;
    if (jid && ts > (latestByChat.get(jid) || 0)) latestByChat.set(jid, ts);
  }
  queue.sort((a, b) => {
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
