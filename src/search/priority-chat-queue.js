/**
 * Move preferredChatJid to the front of the AI indexing queue if present.
 * Mutates `queue` in place.
 *
 * @param {{ chatJid: string }[]} queue
 * @param {string|null|undefined} preferredChatJid
 * @returns {boolean} true if the queue was reordered
 */
export function prioritizeChatFirst(queue, preferredChatJid) {
  if (!preferredChatJid || !Array.isArray(queue) || queue.length < 2) return false;
  const idx = queue.findIndex((w) => w.chatJid === preferredChatJid);
  if (idx <= 0) return false;
  const [item] = queue.splice(idx, 1);
  queue.unshift(item);
  return true;
}
