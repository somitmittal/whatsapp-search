import { describe, expect, test } from '@jest/globals';
import { selectPullStatus } from '../src/llm/pull-status.js';

describe('selectPullStatus', () => {
  test('active download wins over another provider terminal state', () => {
    const done = { model: 'search-model', status: 'done', percent: 100 };
    const downloading = { model: 'media-model', status: 'downloading', percent: 42 };

    expect(selectPullStatus([done, downloading])).toBe(downloading);
  });

  test('error wins over done when no download is active', () => {
    const done = { model: 'search-model', status: 'done', percent: 100 };
    const error = { model: 'summary-model', status: 'error', percent: 0 };

    expect(selectPullStatus([done, error])).toBe(error);
  });

  test('returns null when no provider has pull state', () => {
    expect(selectPullStatus([null, undefined])).toBeNull();
  });
});
