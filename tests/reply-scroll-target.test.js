import { describe, expect, test } from '@jest/globals';
import { messageIdsMatch, scrollContainerToElement } from '../public/js/messages-render.js';

describe('messageIdsMatch', () => {
  test('matches identical WhatsApp message ids', () => {
    expect(messageIdsMatch('ABCD1234', 'ABCD1234')).toBe(true);
  });

  test('matches ids with an optional leading m prefix', () => {
    expect(messageIdsMatch('mABCD1234', 'ABCD1234')).toBe(true);
    expect(messageIdsMatch('ABCD1234', 'mABCD1234')).toBe(true);
    expect(messageIdsMatch('mABCD1234', 'mABCD1234')).toBe(true);
  });

  test('rejects unrelated ids and empty values', () => {
    expect(messageIdsMatch('ABCD', 'EFGH')).toBe(false);
    expect(messageIdsMatch(null, 'ABCD')).toBe(false);
    expect(messageIdsMatch('ABCD', undefined)).toBe(false);
  });
});

describe('scrollContainerToElement', () => {
  test('centers the target inside the transcript scroller (not via scrollIntoView)', () => {
    const container = {
      scrollTop: 800,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 100, height: 400 }),
    };
    const el = {
      getBoundingClientRect: () => ({ top: 500, height: 80 }),
    };
    // delta from container top = 400; center ⇒ 800 + 400 - 200 + 40 = 1040
    scrollContainerToElement(container, el, { block: 'center' });
    expect(container.scrollTop).toBe(1040);
  });
});
