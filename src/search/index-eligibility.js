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

/**
 * Auto-index only sizable, recently-active conversations. Status/feeds stay out unless
 * the user opts that chat in — they are noisy and were already deprioritized.
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

export function isChatEligibleForIndex(chat, { optedIn = false } = {}) {
  return Boolean(optedIn) || isChatEligibleForAutoIndex(chat);
}
