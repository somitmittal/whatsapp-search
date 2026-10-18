const LINKED_BLURB = 'Your phone is linked as a companion device. Live chats appear in the WhatsApp tab.';
const SCAN_BLURB = 'Scan the QR code in the WhatsApp Connection section above to finish linking.';
const DROPPED_BLURB = 'Your phone is linked, but the connection dropped. Reconnecting automatically — already-synced chats stay available.';

/**
 * What the Advanced card in Settings → Linked Devices should report about live sync.
 *
 * Reads the live socket state only. `isWaUiReady()` stays true across a dropped connection
 * on purpose — so the UI does not flip back to the QR screen on every blip — and driving
 * this pill from it had the card claiming "WhatsApp connected" while the panel directly
 * above it said "Not connected".
 */
export function liveSyncPillStatus({ waState, needsRelogin = false, loggedOut = false } = {}) {
  if (waState === 'SYNCING') {
    return { connected: true, text: 'QR sync enabled \u00b7 syncing chats\u2026', blurb: LINKED_BLURB };
  }
  if (waState === 'READY') {
    return { connected: true, text: 'QR sync enabled \u00b7 WhatsApp connected', blurb: LINKED_BLURB };
  }
  if (needsRelogin || loggedOut) {
    return { connected: false, text: 'QR sync enabled \u00b7 waiting for QR scan', blurb: SCAN_BLURB };
  }
  return { connected: false, text: 'QR sync enabled \u00b7 reconnecting\u2026', blurb: DROPPED_BLURB };
}
