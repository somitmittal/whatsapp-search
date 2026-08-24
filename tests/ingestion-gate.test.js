import { describe, expect, test } from '@jest/globals';
import { isHistorySyncInFlight, isWaIngestionActive } from '../src/whatsapp/ingestion-gate.js';

describe('isHistorySyncInFlight', () => {
  test('a client that never connected is not syncing', () => {
    // `historyDone` is false from construction, so it must not be read on its own.
    expect(isHistorySyncInFlight({ historySyncStarted: false, historyDone: false })).toBe(false);
    expect(isHistorySyncInFlight({})).toBe(false);
  });

  test('history is in flight between connection open and sync completion', () => {
    expect(isHistorySyncInFlight({ historySyncStarted: true, historyDone: false })).toBe(true);
  });

  test('a finished sync is no longer in flight', () => {
    expect(isHistorySyncInFlight({ historySyncStarted: true, historyDone: true })).toBe(false);
  });
});

describe('isWaIngestionActive', () => {
  test('history streaming outranks indexing', () => {
    expect(isWaIngestionActive({ waState: 'SYNCING' })).toBe(true);
  });

  test('stays active while batches continue after the UI is promoted to READY', () => {
    expect(isWaIngestionActive({ waState: 'READY', isInitialHistorySync: true })).toBe(true);
  });

  test.each([
    ['waiting for a QR scan', 'QR_READY'],
    ['connecting or in reconnect backoff', 'LOADING'],
    ['logged out', 'DISCONNECTED'],
  ])('does not block indexing while %s', (_label, waState) => {
    expect(isWaIngestionActive({ waState, isInitialHistorySync: false })).toBe(false);
  });

  test('an import-only install with no WhatsApp state never blocks indexing', () => {
    expect(isWaIngestionActive({})).toBe(false);
  });
});
