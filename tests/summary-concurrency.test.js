import { afterEach, describe, expect, test } from '@jest/globals';
import { applyOllamaMemorySettings } from '../src/llm/ollama-recommend.js';
import { getSummaryThreadConcurrency } from '../src/search/daily-summary-service.js';

function verdict(overrides) {
  return {
    model: 'llama3.2:3b', numCtx: 2048, exceedsBudget: false, pressure: 'normal', ...overrides,
  };
}

afterEach(() => {
  applyOllamaMemorySettings(null, verdict({ model: '__reset__' }));
});

describe('getSummaryThreadConcurrency for local Ollama', () => {
  test('fans out small models when they fit the RAM budget', () => {
    applyOllamaMemorySettings(null, verdict());
    expect(getSummaryThreadConcurrency(true, 1, 'llama3.2:3b')).toBe(3);
  });

  test('runs one request at a time when the model exceeds the RAM budget', () => {
    applyOllamaMemorySettings(null, verdict({ exceedsBudget: true }));
    expect(getSummaryThreadConcurrency(true, 1, 'llama3.2:3b')).toBe(1);
  });

  test('runs one request at a time under memory pressure', () => {
    applyOllamaMemorySettings(null, verdict({ pressure: 'warn' }));
    expect(getSummaryThreadConcurrency(true, 1, 'llama3.2:3b')).toBe(1);
  });

  test('ignores a verdict recorded for a different model', () => {
    applyOllamaMemorySettings(null, verdict({ model: 'gemma2:9b', exceedsBudget: true }));
    expect(getSummaryThreadConcurrency(true, 1, 'llama3.2:3b')).toBe(3);
  });

  test('does not limit cloud providers', () => {
    applyOllamaMemorySettings(null, verdict({ exceedsBudget: true }));
    expect(getSummaryThreadConcurrency(false, 1, 'llama3.2:3b')).toBeGreaterThan(1);
  });
});
