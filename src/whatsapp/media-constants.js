/** Sentinel stored in `messages.media_path` when WhatsApp can no longer re-upload the file. */
export const MEDIA_UNAVAILABLE_PATH = '__unavailable__';
/** Sentinel for videos above the download size cap — the file exists, we chose not to fetch it. */
export const MEDIA_TOO_LARGE_PATH = '__too_large__';
/** Gap between concurrent media downloads; also the poll cadence when waiting for a chat queue. */
export const WA_MEDIA_DRAIN_GAP_MS = 120;

export function isMediaUnavailablePath(path) {
  return String(path || '').trim() === MEDIA_UNAVAILABLE_PATH;
}

export function isMediaTooLargePath(path) {
  return String(path || '').trim() === MEDIA_TOO_LARGE_PATH;
}

/** Sentinels are final outcomes; never queue those rows again. */
export function isTerminalMediaPath(path) {
  return isMediaUnavailablePath(path) || isMediaTooLargePath(path);
}

/**
 * WhatsApp answers that *look* like the blob is gone.
 * CDN 404 / NOT_FOUND are also returned for expired media URLs that the phone
 * can still re-upload — only treat as permanent after a phone-reupload attempt
 * (see `_enrichRowWithMedia`). GENERAL_ERROR / stream failures stay retryable.
 */
export function isPermanentMediaFailure(err) {
  const m = String(err?.message || err || '');
  if (/Status code: 404|no media present/i.test(m)) return true;
  if (/NOT_FOUND/i.test(m)) return true;
  return false;
}
