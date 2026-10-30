/** Sentinel stored in `messages.media_path` when WhatsApp can no longer re-upload the file. */
export const MEDIA_UNAVAILABLE_PATH = '__unavailable__';
/** Sentinel for videos above the download size cap — the file exists, we chose not to fetch it. */
export const MEDIA_TOO_LARGE_PATH = '__too_large__';

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
 * Only treat WhatsApp responses that mean the blob is gone as permanent.
 * GENERAL_ERROR / stream failures are often transient and must stay retryable.
 */
export function isPermanentMediaFailure(err) {
  const m = String(err?.message || err || '');
  if (/Status code: 404|no media present/i.test(m)) return true;
  if (/NOT_FOUND/i.test(m)) return true;
  return false;
}
