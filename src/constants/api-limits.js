/**
 * API / DB caps for message pagination (large windows for long histories).
 * Override with env `MAX_MESSAGES_PAGE` (clamped 500–50000).
 */
const raw = parseInt(process.env.MAX_MESSAGES_PAGE || '10000', 10);
const n = Number.isFinite(raw) ? raw : 10000;

export const MAX_MESSAGES_PAGE = Math.min(50_000, Math.max(500, n));
