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

export function effectiveUnreadCount(whatsappUnread, locallyUnseen) {
  const wa = Math.max(0, Number(whatsappUnread) || 0);
  const local = Math.max(0, Number(locallyUnseen) || 0);
  return Math.min(wa, local);
}

/** Product rule: group catch-up appears only for more than ten unread messages. */
export function shouldShowGroupCatchup({ isGroup, waConnected, unreadCount }) {
  return Boolean(isGroup && waConnected && Number(unreadCount) > 10);
}
