/**
 * Baileys `makeWASocket` replaces `shouldSyncHistoryMessage` with
 * `() => !!syncFullHistory` when the caller leaves it undefined.
 *
 * `syncFullHistory: false` is meant to skip the heavy FULL dump (phone “syncing”
 * alerts). WhatsApp still sends RECENT history on reconnect — that is how a
 * linked device catches up on messages that arrived while it was offline.
 * If we skip RECENT too, the archive freezes on the last day the socket was up.
 *
 * A gap after the app was down is repaired with **one** FULL_HISTORY_SYNC_ON_DEMAND
 * for the last few days (groups included). Never fan out per-chat PDO requests —
 * that is what floods “syncing with WhatsApp Search stopped” on the phone.
 */

/** proto.HistorySync.HistorySyncType.FULL */
export const HISTORY_SYNC_TYPE_FULL = 2;

export const RECENT_DAYS_CATCHUP_DAYS = 7;
export const RECENT_DAYS_CATCHUP_COOLDOWN_SEC = 6 * 3600;
export const STALE_CHAT_MAX_AGE_SEC = 36 * 3600;
export const MIN_STALE_CHATS_FOR_CATCHUP = 5;

export function shouldSyncHistoryMessage(historyMsg, { syncFullHistory = false } = {}) {
  const t = historyMsg?.syncType;
  if (t === HISTORY_SYNC_TYPE_FULL || t === 'FULL') return !!syncFullHistory;
  return true;
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
