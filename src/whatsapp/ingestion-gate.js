/**
 * When AI indexing must stand aside for WhatsApp ingestion (no Baileys dependency).
 *
 * Ingestion only outranks indexing while history is genuinely streaming. Every other
 * WhatsApp state — waiting on a QR scan, connecting, reconnect backoff, logged out —
 * delivers no data, so indexing (including of imported archives, which have nothing to
 * do with the live link) must keep running.
 */

/**
 * Is an initial history sync genuinely in flight?
 *
 * `historyDone` starts false on a freshly constructed client, so it cannot be read alone:
 * a client showing a QR nobody scans would otherwise look busy forever.
 *
 * @param {{ historySyncStarted?: boolean, historyDone?: boolean }} client
 */
export function isHistorySyncInFlight({ historySyncStarted, historyDone } = {}) {
  return Boolean(historySyncStarted) && !historyDone;
}

/**
 * Should AI indexing yield to ingestion for this tenant right now?
 *
 * `LOADING` is deliberately absent: it covers connecting and reconnect backoff, which
 * retries indefinitely at up to two minutes per attempt with no data arriving.
 *
 * @param {{ waState?: string, isInitialHistorySync?: boolean }} tenant
 */
export function isWaIngestionActive({ waState, isInitialHistorySync } = {}) {
  if (waState === 'SYNCING') return true;
  return Boolean(isInitialHistorySync);
}
