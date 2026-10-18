import { describe, expect, test } from '@jest/globals';
import { liveSyncPillStatus } from '../public/js/live-sync-status.js';

describe('live sync pill', () => {
  test('reports a connected phone while the socket is open', () => {
    const status = liveSyncPillStatus({ waState: 'READY' });
    expect(status.connected).toBe(true);
    expect(status.text).toContain('WhatsApp connected');
  });

  test('reports syncing separately from idle-connected', () => {
    const status = liveSyncPillStatus({ waState: 'SYNCING' });
    expect(status.connected).toBe(true);
    expect(status.text).toContain('syncing chats');
  });

  test('asks for a scan when the session needs relinking', () => {
    const status = liveSyncPillStatus({ waState: 'DISCONNECTED', needsRelogin: true });
    expect(status.connected).toBe(false);
    expect(status.text).toContain('waiting for QR scan');
    expect(status.blurb).toContain('Scan the QR code');
  });

  test('asks for a scan after an explicit logout, with no relogin flag set', () => {
    const status = liveSyncPillStatus({ waState: 'DISCONNECTED', loggedOut: true });
    expect(status.connected).toBe(false);
    expect(status.text).toContain('waiting for QR scan');
  });

  // The reported bug: the server says DISCONNECTED / "Not connected" (credentials still on
  // disk, socket down), and the pill kept claiming "WhatsApp connected" because it read the
  // deliberately sticky readiness flag instead of the live state.
  test('a linked session whose socket dropped reports reconnecting, never connected', () => {
    const status = liveSyncPillStatus({ waState: 'DISCONNECTED' });
    expect(status.connected).toBe(false);
    expect(status.text).toContain('reconnecting');
    expect(status.text).not.toContain('WhatsApp connected');
  });

  test('reports reconnecting while the client is backing off', () => {
    expect(liveSyncPillStatus({ waState: 'LOADING' }).text).toContain('reconnecting');
  });

  test('a live socket outranks a stale relogin flag', () => {
    expect(liveSyncPillStatus({ waState: 'READY', needsRelogin: true, loggedOut: true }).connected).toBe(true);
  });

  test('says nothing about being connected unless the socket is open', () => {
    for (const waState of ['DISCONNECTED', 'LOADING', 'QR_READY', undefined]) {
      expect(liveSyncPillStatus({ waState }).connected).toBe(false);
    }
  });
});
