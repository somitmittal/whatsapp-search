import { describe, expect, test } from '@jest/globals';
import { numCtxForBudget } from '../src/llm/ollama-recommend.js';
import { OLLAMA_DEFAULT_KEEP_ALIVE_SEC } from '../src/llm/ollama.js';
import {
  isSmallLocalModel,
  localSummaryNumCtx,
  resolveOllamaIndexingModel,
} from '../src/search/indexing-profile.js';

describe('isSmallLocalModel', () => {
  test('treats 4B and below as small', () => {
    expect(isSmallLocalModel('llama3.2:3b')).toBe(true);
    expect(isSmallLocalModel('llama3.2:1b')).toBe(true);
    expect(isSmallLocalModel('qwen3.5:4b')).toBe(true);
  });

  test('treats 9B as large', () => {
    expect(isSmallLocalModel('gemma2:9b')).toBe(false);
  });
});

describe('resolveOllamaIndexingModel', () => {
  test('keeps small models', () => {
    expect(resolveOllamaIndexingModel('llama3.2:1b')).toBe('llama3.2:1b');
  });

  test('downshifts large local models to the recommended 3B tier', () => {
    expect(resolveOllamaIndexingModel('gemma2:9b')).toBe('llama3.2:3b');
  });
});

describe('localSummaryNumCtx', () => {
  test('caps at the 4GB-tier context', () => {
    const prev = process.env.OLLAMA_NUM_CTX;
    process.env.OLLAMA_NUM_CTX = '4096';
    try {
      expect(localSummaryNumCtx()).toBe(numCtxForBudget(4));
      expect(localSummaryNumCtx()).toBe(2048);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_NUM_CTX;
      else process.env.OLLAMA_NUM_CTX = prev;
    }
  });

  test('does not raise a tighter existing budget', () => {
    const prev = process.env.OLLAMA_NUM_CTX;
    process.env.OLLAMA_NUM_CTX = '1536';
    try {
      expect(localSummaryNumCtx()).toBe(1536);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_NUM_CTX;
      else process.env.OLLAMA_NUM_CTX = prev;
    }
  });
});

describe('keep-alive constant', () => {
  test('matches the existing OllamaProvider default', () => {
    expect(OLLAMA_DEFAULT_KEEP_ALIVE_SEC).toBe(300);
  });
});
