import { isWhatsAppLowPriorityFeed } from '../whatsapp/jid-filters.js';
import config from '../config.js';

export function indexMinMessageCount() {
  return Number(config.indexMinMessageCount) || 0;
}

export function indexRecentWindowDays() {
  return Number(config.indexRecentWindowDays) || 0;
}

export function indexRecentCutoffTs(nowTs = Math.floor(Date.now() / 1000)) {
  return Number(nowTs) - (indexRecentWindowDays() * 24 * 60 * 60);
}

export function indexAutoEnabled() {
  return Boolean(config.indexAutoEnabled);
}

/**
 * Legacy size/recency auto-index rule. Only applied when `WA_AUTO_INDEX=1`.
 * Status/feeds stay out unless the user opts that chat in.
 */
export function isChatEligibleForAutoIndex({
  chatJid,
  messageCount,
  lastMessageTs,
  nowTs = Math.floor(Date.now() / 1000),
} = {}) {
  if (isWhatsAppLowPriorityFeed(chatJid)) return false;
  if (!(Number(messageCount) > indexMinMessageCount())) return false;
  return Number(lastMessageTs) >= indexRecentCutoffTs(nowTs);
}

/**
 * A chat is indexed only when the user toggles it on, unless auto-index is enabled.
 */
export function isChatEligibleForIndex(chat, { optedIn = false } = {}) {
  if (optedIn) return true;
  if (!indexAutoEnabled()) return false;
  return isChatEligibleForAutoIndex(chat);
}
