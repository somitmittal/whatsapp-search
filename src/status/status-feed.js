/**
 * Group indexed `status@broadcast` rows into per-contact story stacks (WhatsApp Web–style).
 */
import { STATUS_BROADCAST_JID } from '../whatsapp/jid-filters.js';

function itemFromRow(r) {
  const mediaPath = r.mediaPath != null ? String(r.mediaPath).trim() : '';
  return {
    messageId: r.messageId,
    timestamp: r.timestamp,
    mediaType: r.mediaType ?? null,
    text: r.text ?? null,
    mediaCaption: r.mediaCaption ?? null,
    hasMediaFile: Boolean(mediaPath),
    sender: r.sender ?? null,
  };
}

/**
 * @param {Array<{ messageId: string, sender?: string|null, senderJid?: string|null, text?: string|null, mediaType?: string|null, mediaPath?: string|null, mediaCaption?: string|null, timestamp: number }>} rows
 * @param {number} limitPeers
 */
export function groupStatusBroadcastRows(rows, limitPeers = 80) {
  const groups = new Map();
  for (const r of rows || []) {
    const isMe = r.sender === 'You';
    const peerKey = isMe ? '__me__' : String(r.senderJid || r.sender || 'unknown').trim();
    if (!groups.has(peerKey)) {
      groups.set(peerKey, {
        peerKey,
        senderJid: isMe ? null : r.senderJid || null,
        displayName: isMe ? 'My status' : (r.sender || 'Contact'),
        messages: [],
      });
    }
    const g = groups.get(peerKey);
    g.messages.push({
      messageId: r.messageId,
      sender: r.sender,
      senderJid: r.senderJid,
      text: r.text,
      mediaType: r.mediaType,
      mediaPath: r.mediaPath,
      mediaCaption: r.mediaCaption,
      timestamp: r.timestamp,
    });
    if (!isMe && r.sender && (g.displayName === 'Contact' || !g.displayName)) {
      g.displayName = r.sender;
    }
  }

  let peers = [...groups.values()].map((g) => {
    g.messages.sort((a, b) => a.timestamp - b.timestamp);
    const latestTs = g.messages.length ? g.messages[g.messages.length - 1].timestamp : 0;
    const preview = g.messages[g.messages.length - 1];
    const items = g.messages.map(itemFromRow);
    return {
      peerKey: g.peerKey,
      senderJid: g.senderJid,
      displayName: g.displayName,
      latestTs,
      items,
      previewMessageId: preview?.messageId ?? null,
      previewMediaType: preview?.mediaType ?? null,
      hasMediaFile: preview ? Boolean(preview.mediaPath && String(preview.mediaPath).trim()) : false,
    };
  });

  peers.sort((a, b) => b.latestTs - a.latestTs);
  const me = peers.find((p) => p.peerKey === '__me__');
  const rest = peers.filter((p) => p.peerKey !== '__me__');
  peers = me ? [me, ...rest] : peers;

  return {
    statusJid: STATUS_BROADCAST_JID,
    peers: peers.slice(0, Math.max(1, Math.min(Number(limitPeers) || 80, 200))),
  };
}
