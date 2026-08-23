import { describe, expect, test } from '@jest/globals';
import { dateFromUnix, normalizeUnixSeconds } from '../src/utils/timestamp.js';

describe('timestamp boundaries', () => {
  test('normalizes Unix seconds and milliseconds to seconds', () => {
    expect(normalizeUnixSeconds(1760000)).toBe(1760000);
    expect(normalizeUnixSeconds(1760000000000)).toBe(1760000000);
  });

  test('does not move a valid December 2025 date into 2026', () => {
    const seconds = normalizeUnixSeconds(new Date('2025-12-16T12:00:00Z').getTime());
    expect(dateFromUnix(seconds).getUTCFullYear()).toBe(2025);
    expect(dateFromUnix(seconds).getUTCMonth()).toBe(11);
    expect(dateFromUnix(seconds).getUTCDate()).toBe(16);
  });

  test('returns fallback for invalid values', () => {
    expect(normalizeUnixSeconds('not-a-date', 42)).toBe(42);
    expect(dateFromUnix(0)).toBeNull();
  });
});
