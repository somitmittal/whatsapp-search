/**
 * Classify WhatsApp JIDs for sidebar tabs and summary indexing priority (no Baileys dependency).
 */

export const SIDEBAR_TAB_CHAT = 'chat';
export const SIDEBAR_TAB_FEED = 'feed';

/** WhatsApp Status / Stories pipeline (`messages` indexed under this chat JID). */
export const STATUS_BROADCAST_JID = 'status@broadcast';

/**
 * Status / Stories, broadcast lists, newsletters, Meta bots — separate sidebar tab + summarize after real chats.
 */
export function isWhatsAppLowPriorityFeed(jid) {
  if (!jid || typeof jid !== 'string') return false;
  if (jid === 'status@broadcast') return true;
  if (jid.endsWith('@broadcast')) return true;
  if (jid.endsWith('@newsletter')) return true;
  if (jid.endsWith('@bot')) return true;
  return false;
}

/**
 * @returns {'chat' | 'feed'}
 */
export function sidebarTabForJid(jid) {
  return isWhatsAppLowPriorityFeed(jid) ? SIDEBAR_TAB_FEED : SIDEBAR_TAB_CHAT;
}
