/**
 * Classify WhatsApp JIDs for sidebar tabs and summary indexing priority (no Baileys dependency).
 */

export const SIDEBAR_TAB_CHAT = 'chat';
export const SIDEBAR_TAB_FEED = 'feed';
export const SIDEBAR_TAB_IMPORTED = 'imported';

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

/** Archives created by file / Gmail import (`import_<slug>@imported`). */
export function isImportedChatJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@imported');
}

/**
 * @returns {'chat' | 'feed' | 'imported'}
 */
export function sidebarTabForJid(jid) {
  if (isImportedChatJid(jid)) return SIDEBAR_TAB_IMPORTED;
  return isWhatsAppLowPriorityFeed(jid) ? SIDEBAR_TAB_FEED : SIDEBAR_TAB_CHAT;
}

/**
 * Mirrors the sidebar filter in `renderChatsFromState()` (public/index.html): while
 * WhatsApp is offline the live-chat tabs render empty, so imported archives are the only
 * thing the user can see. Indexers use this to queue chats the user cannot currently see
 * behind the ones they can — it affects ordering only, so hidden chats are still indexed
 * once the visible queue drains.
 */
export function isChatVisibleInSidebar(jid, waLive) {
  return Boolean(waLive) || isImportedChatJid(jid);
}
