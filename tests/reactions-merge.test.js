import { describe, test, expect } from '@jest/globals';

/** Mirrors client aggregation shape */
function mergeCounts(prev, emoji) {
  const counts = prev && typeof prev === 'object' ? { ...prev } : {};
  counts[emoji] = (Number(counts[emoji]) || 0) + 1;
  return counts;
}

describe('reaction count merge', () => {
  test('increments per emoji', () => {
    expect(mergeCounts({}, '👍')).toEqual({ '👍': 1 });
    expect(mergeCounts({ '👍': 2 }, '👍')).toEqual({ '👍': 3 });
    expect(mergeCounts({ '👍': 1 }, '❤️')).toEqual({ '👍': 1, '❤️': 1 });
  });
});
