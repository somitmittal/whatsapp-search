export function captureUnreadCounts(unreadByChat, chats) {
  for (const chat of chats || []) {
    if (!chat?.id || !Number.isFinite(chat.unreadCount)) continue;
    unreadByChat.set(String(chat.id), Math.max(0, Number(chat.unreadCount)));
  }
}

export function unreadCountForChat(unreadByChat, chatJid) {
  const count = unreadByChat.get(String(chatJid || ''));
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

/**
 * Combine WhatsApp's unread counter with what we have indexed locally.
 *
 * Prefer WhatsApp's count when present (capped by how many incoming messages exist
 * in the DB — history sync may lag). Fall back to locally-unseen-since-last-open
 * when WhatsApp has not reported an unread count (common right after restart).
 */
export function effectiveUnreadCount(whatsappUnread, locallyUnseen, availableIncoming = null) {
  const wa = Math.max(0, Number(whatsappUnread) || 0);
  const local = Math.max(0, Number(locallyUnseen) || 0);
  const available = availableIncoming == null
    ? local
    : Math.max(0, Number(availableIncoming) || 0);
  if (wa > 0) {
    if (available > 0) return Math.min(wa, available);
    return wa;
  }
  return local;
}

/** Product rule: catch-up appears only for more than ten unseen messages. */
export function shouldShowGroupCatchup({ isGroup, waConnected, unreadCount }) {
  // isGroup kept for callers; 1:1 catch-up is allowed when the flag is true OR omitted.
  return Boolean(waConnected && Number(unreadCount) > 10 && (isGroup !== false));
}

/**
 * How many messages count as "unseen" for the catch-up card.
 * Prefer live/persisted WhatsApp unread; otherwise count incoming since the
 * catch-up cursor (dismiss point) — not merely last_seen, which advances on open
 * and was wiping eligibility before the panel could render.
 */
export function resolveCatchupUnseen({
  whatsappUnread = 0,
  locallySinceCatchup = 0,
  availableIncoming = 0,
} = {}) {
  return effectiveUnreadCount(whatsappUnread, locallySinceCatchup, availableIncoming);
}
