import {
  QR_FIRST_TTL_MS,
  QR_NEXT_TTL_MS,
  QR_PAIRING_RECONNECT_MS,
  isQrUsable,
  qrTtlMsForIndex,
  reconnectDelayMs,
  shouldResetAuthAfterStaleCloses,
} from '../src/whatsapp/qr-lifecycle.js';

describe('qrTtlMsForIndex', () => {
  test('gives the first QR of a socket the longer lifetime', () => {
    expect(qrTtlMsForIndex(0)).toBe(QR_FIRST_TTL_MS);
  });

  test('gives every later QR the shorter lifetime', () => {
    expect(qrTtlMsForIndex(1)).toBe(QR_NEXT_TTL_MS);
    expect(qrTtlMsForIndex(7)).toBe(QR_NEXT_TTL_MS);
  });
});

describe('isQrUsable', () => {
  const issuedAt = 1_000_000;

  test('is usable within its lifetime', () => {
    expect(isQrUsable(issuedAt, issuedAt + 5_000, QR_NEXT_TTL_MS)).toBe(true);
  });

  test('is unusable once the lifetime elapses', () => {
    expect(isQrUsable(issuedAt, issuedAt + QR_NEXT_TTL_MS, QR_NEXT_TTL_MS)).toBe(false);
    expect(isQrUsable(issuedAt, issuedAt + QR_NEXT_TTL_MS + 1, QR_NEXT_TTL_MS)).toBe(false);
  });

  test('the longer first-QR lifetime is honoured', () => {
    expect(isQrUsable(issuedAt, issuedAt + 45_000, QR_FIRST_TTL_MS)).toBe(true);
    expect(isQrUsable(issuedAt, issuedAt + 45_000, QR_NEXT_TTL_MS)).toBe(false);
  });

  test('a QR that was never issued is never usable', () => {
    expect(isQrUsable(0, Date.now(), QR_NEXT_TTL_MS)).toBe(false);
    expect(isQrUsable(issuedAt, issuedAt + 1, 0)).toBe(false);
  });
});

describe('reconnectDelayMs', () => {
  test('retries promptly while pairing so a fresh QR appears immediately', () => {
    expect(reconnectDelayMs({ hasCreds: false, attempt: 0 })).toBe(QR_PAIRING_RECONNECT_MS);
  });

  test('pairing retries never grow, however many QRs have expired', () => {
    expect(reconnectDelayMs({ hasCreds: false, attempt: 9 })).toBe(QR_PAIRING_RECONNECT_MS);
  });

  test('backs off for a logged-in session', () => {
    expect(reconnectDelayMs({ hasCreds: true, attempt: 0 })).toBe(5000);
    expect(reconnectDelayMs({ hasCreds: true, attempt: 1 })).toBe(8000);
  });

  test('caps the backoff', () => {
    expect(reconnectDelayMs({ hasCreds: true, attempt: 50 })).toBe(120_000);
  });
});

describe('shouldResetAuthAfterStaleCloses', () => {
  test('wipes auth after repeated stale closes on a saved session', () => {
    expect(shouldResetAuthAfterStaleCloses({ hasCreds: true, staleCloseCount: 3 })).toBe(true);
  });

  test('leaves a saved session alone below the threshold', () => {
    expect(shouldResetAuthAfterStaleCloses({ hasCreds: true, staleCloseCount: 2 })).toBe(false);
  });

  test('never resets while pairing — there is nothing to wipe and it only delays the QR', () => {
    expect(shouldResetAuthAfterStaleCloses({ hasCreds: false, staleCloseCount: 9 })).toBe(false);
  });
});
