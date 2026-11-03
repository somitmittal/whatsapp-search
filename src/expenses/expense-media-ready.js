/**
 * Before expense reconciliation, ensure chat media for the sheet's date span is on disk.
 */
import { existsSync } from 'node:fs';
import { isTerminalMediaPath } from '../whatsapp/media-constants.js';

/** Media types that should be present locally for the date span. */
export const EXPENSE_MEDIA_TYPES = new Set(['image', 'document', 'sticker']);

/**
 * @param {object} row
 * @returns {boolean}
 */
export function isExpenseRelevantMediaRow(row) {
  const type = String(row?.mediaType || '').trim();
  return EXPENSE_MEDIA_TYPES.has(type);
}

/**
 * Still waiting for a local file (empty path). Terminal sentinels are finished outcomes.
 * @param {object} row
 */
export function needsMediaDownload(row) {
  if (!isExpenseRelevantMediaRow(row)) return false;
  const path = String(row?.mediaPath || '').trim();
  if (isTerminalMediaPath(path)) return false;
  return !path || !existsSync(path);
}

/**
 * Kick downloads for the chat and wait until the WA media queue for that chat is idle.
 *
 * @param {{
 *   db: object,
 *   chatJid: string,
 *   startTs: number,
 *   endTs: number,
 *   waClient?: object|null,
 *   setPriorityChat?: (chatJid: string) => void,
 *   onStatus?: (message: string) => void,
 *   pollMs: number,
 * }} opts
 *   `pollMs` must come from the caller's known drain gap (WA_DRAIN_GAP_MS) — not invented here.
 * @returns {Promise<{ downloadedPending: number }>}
 */
export async function ensureExpenseRangeMediaReady({
  db,
  chatJid,
  startTs,
  endTs,
  waClient = null,
  setPriorityChat = null,
  onStatus = null,
  pollMs,
}) {
  const jid = String(chatJid || '').trim();
  const start = Number(startTs);
  const end = Number(endTs);
  const gap = Number(pollMs);
  if (!jid || !Number.isFinite(start) || !Number.isFinite(end)) {
    return { downloadedPending: 0 };
  }
  if (!Number.isFinite(gap) || gap <= 0) {
    throw new Error('ensureExpenseRangeMediaReady requires pollMs from the media drain gap');
  }

  if (typeof db.clearUnavailableMediaPaths === 'function') {
    db.clearUnavailableMediaPaths(jid);
  }

  const listPendingDownloads = () => {
    const rows = typeof db.listExpenseMediaInRange === 'function'
      ? (db.listExpenseMediaInRange(jid, start, end) || [])
      : [];
    return rows.filter(needsMediaDownload);
  };

  let pendingDl = listPendingDownloads();
  if (pendingDl.length && waClient && typeof waClient.prioritizeChatMedia === 'function') {
    onStatus?.(`Downloading ${pendingDl.length} media file(s) for that date…`);
    setPriorityChat?.(jid);
    waClient.prioritizeChatMedia(jid, {
      recentOnly: false,
      allowPhoneReupload: true,
    });
    if (typeof waClient.awaitChatMediaQueueIdle === 'function') {
      await waClient.awaitChatMediaQueueIdle(jid, { pollMs: gap });
    } else {
      let idleRounds = 0;
      while (idleRounds < 2) {
        const queued = typeof waClient.mediaQueueLength === 'function'
          ? waClient.mediaQueueLength(jid)
          : 0;
        if (queued === 0) idleRounds += 1;
        else {
          idleRounds = 0;
          waClient.prioritizeChatMedia(jid, { recentOnly: false, allowPhoneReupload: true });
        }
        await new Promise((r) => setTimeout(r, gap));
      }
    }
  }

  pendingDl = listPendingDownloads();
  if (pendingDl.length) {
    throw new Error(
      `${pendingDl.length} media file(s) for that date are still missing locally. `
      + 'Open the site chat, tap Retry on pending media (keep WhatsApp online), then run reconciliation again.',
    );
  }

  return { downloadedPending: 0 };
}
