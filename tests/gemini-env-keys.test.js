import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { geminiKeysFromEnv } from '../src/llm/defaults.js';

describe('geminiKeysFromEnv', () => {
  const keys = [
    'GEMINI_API_KEY',
    'GEMINI_API_KEYS',
    'MEDIA_INDEX_API_KEY',
    'MEDIA_INDEX_API_KEYS',
    'GEMINI_API_KEY_1',
    'GEMINI_API_KEY_2',
  ];
  const snapshot = {};

  beforeEach(() => {
    keys.forEach((k) => {
      snapshot[k] = process.env[k];
      delete process.env[k];
    });
  });

  afterEach(() => {
    keys.forEach((k) => {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    });
  });

  test('comma-separated in GEMINI_API_KEY', () => {
    process.env.GEMINI_API_KEY = 'alpha,beta';
    expect(geminiKeysFromEnv()).toBe('alpha,beta');
  });

  test('merges GEMINI_API_KEY + GEMINI_API_KEYS + numbered vars and dedupes', () => {
    process.env.GEMINI_API_KEY = 'a,b';
    process.env.GEMINI_API_KEYS = 'c';
    process.env.GEMINI_API_KEY_1 = 'b';
    process.env.GEMINI_API_KEY_2 = 'd';
    expect(geminiKeysFromEnv()).toBe('a,b,c,d');
  });

  test('newline-separated keys', () => {
    process.env.GEMINI_API_KEY = 'key-one\nkey-two';
    expect(geminiKeysFromEnv()).toBe('key-one,key-two');
  });
});
