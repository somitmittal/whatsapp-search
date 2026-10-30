/** Sentinel stored in `messages.media_path` when WhatsApp can no longer re-upload the file. */
export const MEDIA_UNAVAILABLE_PATH = '__unavailable__';

export function isMediaUnavailablePath(path) {
  return String(path || '').trim() === MEDIA_UNAVAILABLE_PATH;
}

export function isPermanentMediaFailure(err) {
  const m = String(err?.message || err || '');
  return /NOT_FOUND|Media re-upload failed|no media present|Status code: 404|ENOTFOUND/i.test(m);
}
