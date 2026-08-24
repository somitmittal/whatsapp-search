/**
 * QR pairing lifecycle rules (no Baileys dependency).
 *
 * Baileys hands out a finite list of QR refs: the first lives 60s and every later one 20s
 * (`genPairQR` in Socket/socket.js). When the refs run out it ends the socket with
 * `DisconnectReason.timedOut` — the same status code a logged-in session produces when it
 * drops. Treating both the same way is what strands the UI on "Reconnecting…" with no QR
 * while the backoff grows on every retry.
 */

/** Baileys' own QR lifetimes: the first ref, then each subsequent one. */
export const QR_FIRST_TTL_MS = 60_000;
export const QR_NEXT_TTL_MS = 20_000;

/** Matches the existing post-auth-reset reconnect delay in wa-client. */
export const QR_PAIRING_RECONNECT_MS = 300;

/** TTL WhatsApp gives the nth QR of a socket (0-based). */
export function qrTtlMsForIndex(index) {
  return index <= 0 ? QR_FIRST_TTL_MS : QR_NEXT_TTL_MS;
}

/**
 * Is this QR still worth showing? An expired code renders fine but WhatsApp rejects the
 * scan, which looks identical to a broken QR from the user's side.
 */
export function isQrUsable(issuedAtMs, nowMs, ttlMs = QR_NEXT_TTL_MS) {
  if (!issuedAtMs || !ttlMs) return false;
  return nowMs - issuedAtMs < ttlMs;
}

/**
 * How long to wait before reopening the socket after a close.
 *
 * While pairing there is no session to protect and a new QR can only come from a new
 * socket, so reconnect promptly. Backoff exists to avoid hammering WhatsApp on behalf of
 * a *logged-in* session, and applying it during pairing just hides the QR for longer each
 * time the previous one expired.
 *
 * @param {{ hasCreds: boolean, attempt?: number, baseMs?: number, maxMs?: number, pairingDelayMs?: number }} opts
 */
export function reconnectDelayMs({
  hasCreds,
  attempt = 0,
  baseMs = 5000,
  maxMs = 120_000,
  pairingDelayMs = QR_PAIRING_RECONNECT_MS,
} = {}) {
  if (!hasCreds) return pairingDelayMs;
  return Math.min(baseMs * Math.pow(1.6, Math.max(0, attempt)), maxMs);
}

/**
 * Should repeated stale closes wipe the auth dir to force a fresh QR?
 *
 * Only meaningful once credentials exist — during pairing there is nothing to reset, so
 * wiping only adds another reconnect round-trip before the next QR appears.
 */
export function shouldResetAuthAfterStaleCloses({ hasCreds, staleCloseCount, threshold = 3 }) {
  return Boolean(hasCreds) && staleCloseCount >= threshold;
}
