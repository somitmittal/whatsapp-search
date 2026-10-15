import { escAttr } from './util.js';

export function mediaUrlForMessage(messageId) {
  if (!messageId) return '';
  return `/api/message-media?messageId=${encodeURIComponent(String(messageId))}`;
}

/** Same file as inline preview; `download=1` forces Content-Disposition attachment on the server. */
export function mediaDownloadUrl(messageId) {
  if (!messageId) return '';
  return `${mediaUrlForMessage(messageId)}&download=1`;
}

export function messageMediaDownloadAnchor(messageId) {
  if (!messageId) return '';
  const h = mediaDownloadUrl(messageId);
  return `<span class="msg-media-actions"><a class="msg-media-dl" href="${escAttr(h)}" download>Download</a></span>`;
}
