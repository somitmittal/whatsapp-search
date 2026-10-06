/**
 * Baileys `makeWASocket` replaces `shouldSyncHistoryMessage` with
 * `() => !!syncFullHistory` when the caller leaves it undefined.
 *
 * `syncFullHistory: false` is meant to skip the heavy FULL dump (phone “syncing”
 * alerts). WhatsApp still sends RECENT history on reconnect — that is how a
 * linked device catches up on messages that arrived while it was offline.
 * If we skip RECENT too, the archive freezes on the last day the socket was up.
 */

/** proto.HistorySync.HistorySyncType.FULL */
export const HISTORY_SYNC_TYPE_FULL = 2;

export function shouldSyncHistoryMessage(historyMsg, { syncFullHistory = false } = {}) {
  const t = historyMsg?.syncType;
  if (t === HISTORY_SYNC_TYPE_FULL || t === 'FULL') return !!syncFullHistory;
  return true;
}
