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
/** proto.HistorySync.HistorySyncType.ON_DEMAND — reply to our own `fetchMessageHistory`. */
export const HISTORY_SYNC_TYPE_ON_DEMAND = 6;

export const RECENT_DAYS_CATCHUP_DAYS = 7;
export const RECENT_DAYS_CATCHUP_COOLDOWN_SEC = 6 * 3600;
export const STALE_CHAT_MAX_AGE_SEC = 36 * 3600;
export const MIN_STALE_CHATS_FOR_CATCHUP = 5;

/**
 * On-demand `fetchMessageHistory` surfaces “syncing with …” on the phone.
 * Balance: pull larger batches when the user asks, but space requests so a
 * Refresh / media-retry / scroll loop cannot spam alerts.
 */
/** Per-chat gap between phone history pulls. */
export const PHONE_HISTORY_CHAT_COOLDOWN_MS = 20 * 60 * 1000;
/** Minimum gap between any two phone history pulls (all chats). */
export const PHONE_HISTORY_GLOBAL_MIN_GAP_MS = 8 * 60 * 1000;
/** Hard cap across the whole account in a rolling hour. */
export const PHONE_HISTORY_MAX_PER_HOUR = 4;
/** How long a single in-flight pull blocks the next. */
export const PHONE_HISTORY_INFLIGHT_MS = 90 * 1000;
/** Prefer max Baileys page size so each approved pull buys more archive. */
export const PHONE_HISTORY_DEFAULT_COUNT = 100;

/**
 * Decide whether another phone history pull is allowed right now.
 * Returns `{ ok: true }` or `{ ok: false, code, http, message, retryAfterMs }`.
 */
export function evaluatePhoneHistoryQuota({
  chatJid,
  nowMs = Date.now(),
  paused = false,
  waReady = true,
  inflightUntil = 0,
  lastChatAtMs = 0,
  lastGlobalAtMs = 0,
  pullsLastHourMs = [],
  chatCooldownMs = PHONE_HISTORY_CHAT_COOLDOWN_MS,
  globalMinGapMs = PHONE_HISTORY_GLOBAL_MIN_GAP_MS,
  maxPerHour = PHONE_HISTORY_MAX_PER_HOUR,
} = {}) {
  if (!waReady) {
    return {
      ok: false,
      code: 'WA_NOT_READY',
      http: 409,
      message: 'WhatsApp connection is not ready — try again once it is READY.',
      retryAfterMs: 0,
    };
  }
  if (paused) {
    return {
      ok: false,
      code: 'SYNC_PAUSED',
      http: 423,
      message: 'Sync paused while the device sleeps or is locked — it resumes automatically when you unlock.',
      retryAfterMs: 0,
    };
  }
  const inflightLeft = Math.max(0, Number(inflightUntil) || 0) - nowMs;
  if (inflightLeft > 0) {
    return {
      ok: false,
      code: 'SYNC_IN_FLIGHT',
      http: 429,
      message: 'A phone history sync is already running. Wait a few seconds for it to finish before asking again.',
      retryAfterMs: inflightLeft,
    };
  }
  const hourAgo = nowMs - 60 * 60 * 1000;
  const recent = (Array.isArray(pullsLastHourMs) ? pullsLastHourMs : [])
    .map((t) => Number(t) || 0)
    .filter((t) => t > hourAgo);
  if (recent.length >= maxPerHour) {
    const oldest = Math.min(...recent);
    const retryAfterMs = Math.max(0, oldest + 60 * 60 * 1000 - nowMs);
    return {
      ok: false,
      code: 'HOURLY_CAP',
      http: 429,
      message: `Phone history is limited to ${maxPerHour} pulls/hour so WhatsApp does not keep notifying your phone. Try again later, or import a chat export for bulk history.`,
      retryAfterMs,
    };
  }
  const globalLeft = (Number(lastGlobalAtMs) || 0) + globalMinGapMs - nowMs;
  if (globalLeft > 0) {
    const wait = globalLeft > 60_000 ? `~${Math.ceil(globalLeft / 60_000)} min` : `~${Math.ceil(globalLeft / 1000)}s`;
    return {
      ok: false,
      code: 'GLOBAL_COOLDOWN',
      http: 429,
      message: `Another chat just asked the phone for history. Spacing requests (${wait}) keeps notifications down while still backfilling over time.`,
      retryAfterMs: globalLeft,
    };
  }
  if (chatJid) {
    const chatLeft = (Number(lastChatAtMs) || 0) + chatCooldownMs - nowMs;
    if (chatLeft > 0) {
      const wait = chatLeft > 60_000 ? `~${Math.ceil(chatLeft / 60_000)} min` : `~${Math.ceil(chatLeft / 1000)}s`;
      return {
        ok: false,
        code: 'CHAT_COOLDOWN',
        http: 429,
        message: `Older history for this chat was just requested. Retrying too fast repeats the phone notification — try again in ${wait}.`,
        retryAfterMs: chatLeft,
      };
    }
  }
  return { ok: true, retryAfterMs: 0 };
}

/**
 * An aborted/empty full-history sync keeps `acceptHistoryOnce` true (on purpose, so the
 * archive is not skipped) — but every reconnect then re-requests a phone-side sync and
 * WhatsApp re-alerts "syncing stopped" on the phone.
 *
 * This is a backoff, NOT a budget: a retry is never refused, only delayed. The first two
 * attempts are immediate (preserves the original quick double-retry behaviour), then the
 * spacing grows. The pull itself always completes as fast as WhatsApp permits.
 */
export const FULL_HISTORY_RETRY_GAPS_SEC = [0, 0, 30, 30, 300, 300, 1800, 1800, 7200, 7200];
/** After enough consecutive failures, at most one retry every 6h — ~5 alerts/day worst case. */
export const FULL_HISTORY_RETRY_MAX_GAP_SEC = 6 * 3600;

/** Wait before the next zero-touch full-history attempt, given how many ran in the last 24h. */
export function fullHistoryBackoffSec(attempts) {
  const n = Math.max(0, Math.floor(Number(attempts) || 0));
  if (n < FULL_HISTORY_RETRY_GAPS_SEC.length) return FULL_HISTORY_RETRY_GAPS_SEC[n];
  return FULL_HISTORY_RETRY_MAX_GAP_SEC;
}

export function shouldSyncHistoryMessage(historyMsg, {
  syncFullHistory = false,
  initialHistorySyncDone = false,
} = {}) {
  if (syncFullHistory) return true;
  // On-demand batches only arrive because the user asked (load older / media retry);
  // dropping them made those requests silently do nothing after the first sync.
  if (Number(historyMsg?.syncType) === HISTORY_SYNC_TYPE_ON_DEMAND) return true;
  return !initialHistorySyncDone;
}

/**
 * Retention filter for `messaging-history.set` rows. The phone's history dump is the
 * only bulk source of older messages, so `keepDays <= 0` (default) keeps every row;
 * a positive value sheds rows older than N days (load-shedding for huge accounts).
 * Rows carry a Unix-seconds `timestamp`.
 */
export function filterRowsByRetention(rows, {
  keepDays = 0,
  nowSec = Math.floor(Date.now() / 1000),
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const keep = Math.max(0, Math.floor(Number(keepDays) || 0));
  if (!keep) return { keep: list, skipped: 0 };
  const cutoffSec = nowSec - keep * 24 * 60 * 60;
  const kept = [];
  let skipped = 0;
  for (const row of list) {
    const ts = Number(row?.timestamp) || 0;
    if (ts >= cutoffSec) kept.push(row);
    else skipped += 1;
  }
  return { keep: kept, skipped };
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
