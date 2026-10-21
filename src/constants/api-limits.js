/**
 * API / DB caps for message pagination (large windows for long histories).
 * Override with env `MAX_MESSAGES_PAGE` (clamped 500–50000).
 */
const raw = parseInt(process.env.MAX_MESSAGES_PAGE || '10000', 10);
const n = Number.isFinite(raw) ? raw : 10000;

export const MAX_MESSAGES_PAGE = Math.min(50_000, Math.max(500, n));

/**
 * WhatsApp chat-export ZIP uploads (multer). Default matches
 * `extractMediaFromZip`'s MAX_TOTAL_BYTES — media-heavy exports (e.g. Phonpay ~150MB)
 * previously hit the old 50MB multer cap and returned an HTML error page.
 * Override with env `IMPORT_MAX_UPLOAD_BYTES`.
 */
const uploadRaw = Number(process.env.IMPORT_MAX_UPLOAD_BYTES);
const uploadDefault = 200 * 1024 * 1024;
export const IMPORT_MAX_UPLOAD_BYTES = Number.isFinite(uploadRaw) && uploadRaw > 0
  ? uploadRaw
  : uploadDefault;
