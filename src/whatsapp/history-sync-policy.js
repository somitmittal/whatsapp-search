/**
 * Baileys `makeWASocket` replaces `shouldSyncHistoryMessage` with
 * `() => !!syncFullHistory` when the caller leaves it undefined.
 *
 * Accepting history also makes Baileys run a full app-state resync. WhatsApp
 * shows that on the phone as “syncing with WhatsApp Search”. Do it once per
 * linked account. Later reconnects must decline, or every dropped socket
 * raises another notification. Messages that arrive while the app is offline
 * still come through `messages.upsert`.
 */

/** proto.HistorySync.HistorySyncType.FULL */
export const HISTORY_SYNC_TYPE_FULL = 2;

export const RECENT_DAYS_CATCHUP_DAYS = 7;
export const RECENT_DAYS_CATCHUP_COOLDOWN_SEC = 6 * 3600;
export const STALE_CHAT_MAX_AGE_SEC = 36 * 3600;
export const MIN_STALE_CHATS_FOR_CATCHUP = 5;

export function shouldSyncHistoryMessage(_historyMsg, {
  syncFullHistory = false,
  initialHistorySyncDone = false,
} = {}) {
  if (syncFullHistory) return true;
  return !initialHistorySyncDone;
}

/**
 * One phone-side history session is enough. Skip if we recently asked, or if
 * almost every chat already has a recent local message.
 */
export function shouldRequestRecentDaysCatchUp({
  staleChatCount = 0,
  lastSyncAtSec = 0,
  nowSec = Math.floor(Date.now() / 1000),
  cooldownSec = RECENT_DAYS_CATCHUP_COOLDOWN_SEC,
  minStaleChats = MIN_STALE_CHATS_FOR_CATCHUP,
} = {}) {
  if (staleChatCount < minStaleChats) return false;
  const last = Number(lastSyncAtSec) || 0;
  if (last > 0 && nowSec - last < cooldownSec) return false;
  return true;
}
