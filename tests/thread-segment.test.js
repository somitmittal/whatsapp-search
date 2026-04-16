import { describe, it, expect } from '@jest/globals';
import { segmentIntoThreads } from '../src/search/thread-segment.js';

describe('segmentIntoThreads', () => {
  it('returns empty for no messages', () => {
    expect(segmentIntoThreads([])).toEqual([]);
  });

  it('groups messages within gap into one thread', () => {
    const t0 = 1000;
    const msgs = [
      { timestamp: t0 },
      { timestamp: t0 + 60 },
      { timestamp: t0 + 120 },
    ];
    const threads = segmentIntoThreads(msgs);
    expect(threads.length).toBe(1);
    expect(threads[0].length).toBe(3);
  });

  it('splits on large gap', () => {
    const t0 = 1000;
    const splitAfter = t0 + 120;
    const nextStart = splitAfter + 31 * 60;
    const msgs = [
      { timestamp: t0 },
      { timestamp: t0 + 60 },
      { timestamp: splitAfter },
      { timestamp: nextStart },
      { timestamp: nextStart + 60 },
      { timestamp: nextStart + 120 },
    ];
    const threads = segmentIntoThreads(msgs);
    expect(threads.length).toBe(2);
  });
});
