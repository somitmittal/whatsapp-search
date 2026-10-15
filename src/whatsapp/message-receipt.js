/**
 * WhatsApp delivery ticks. Baileys reports `WebMessageInfo.Status`:
 * 0 error, 1 pending, 2 sent (one tick), 3 delivered (two gray), 4 read, 5 played (two blue).
 * A later, lower status must not wipe a higher one — history replays often resend SERVER_ACK.
 */

const BY_NAME = {
  ERROR: 0,
  PENDING: 1,
  SERVER_ACK: 2,
  DELIVERY_ACK: 3,
  READ: 4,
  PLAYED: 5,
};

/** @returns {number|null} */
export function normalizeReceiptStatus(status) {
  if (status == null || status === '') return null;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 0 && status <= 5) return status;
  if (typeof status === 'string') {
    if (Object.prototype.hasOwnProperty.call(BY_NAME, status)) return BY_NAME[status];
    const n = Number(status);
    if (Number.isInteger(n) && n >= 0 && n <= 5) return n;
  }
  return null;
}

/** @returns {'pending'|'sent'|'delivered'|'read'|''} */
export function receiptKind(status) {
  const n = normalizeReceiptStatus(status);
  if (n == null) return '';
  if (n <= 1) return 'pending';
  if (n === 2) return 'sent';
  if (n === 3) return 'delivered';
  return 'read';
}

/**
 * `sendMessage` resolves only after the server accepts the relay, but the proto it
 * returns (and then upserts) is still PENDING. That is a sent message, not a clock.
 */
export function receiptAfterSuccessfulRelay(status) {
  const current = normalizeReceiptStatus(status);
  if (current == null || current < BY_NAME.SERVER_ACK) return BY_NAME.SERVER_ACK;
  return current;
}

/**
 * Group delivery/read arrives as `message-receipt.update`, not `messages.update`.
 * @returns {{ chatJid: string, messageId: string, receiptStatus: number } | null}
 */
export function receiptFromGroupReceipt(update) {
  const key = update?.key;
  if (!key?.fromMe || !key.remoteJid || !key.id) return null;
  const receipt = update.receipt || {};
  let receiptStatus = null;
  if (receipt.readTimestamp) receiptStatus = BY_NAME.READ;
  else if (receipt.receiptTimestamp) receiptStatus = BY_NAME.DELIVERY_ACK;
  if (receiptStatus == null) return null;
  return {
    chatJid: String(key.remoteJid),
    messageId: String(key.id),
    receiptStatus,
  };
}

/** Keep the further-along tick. */
export function higherReceipt(current, incoming) {
  const next = normalizeReceiptStatus(incoming);
  if (next == null) return normalizeReceiptStatus(current);
  const prev = normalizeReceiptStatus(current);
  if (prev == null) return next;
  return Math.max(prev, next);
}

const MEDIA_LABEL = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  sticker: 'Sticker',
};

/**
 * One-line sidebar preview, the way WhatsApp writes it under the chat name.
 * Ticks for your own messages are drawn separately from `receiptKind`.
 */
export function chatListPreview({ text, mediaType, sender, isGroup } = {}) {
  let body = String(text || '').replace(/\s+/g, ' ').trim();
  if (/^\[[^\]]+\]$/.test(body)) body = '';
  if (!body && mediaType) body = MEDIA_LABEL[mediaType] || 'Media';
  if (!body) return '';
  if (body.length > 90) body = `${body.slice(0, 89)}…`;
  const fromMe = sender === 'You';
  if (!fromMe && isGroup && sender) return `${sender}: ${body}`;
  return body;
}
