import { describe, expect, test } from '@jest/globals';
import { maskApiKeyForDisplay, publicSettingsFromDb } from '../src/llm/defaults.js';

describe('maskApiKeyForDisplay', () => {
  test('hides long secrets', () => {
    expect(maskApiKeyForDisplay('gsk_abcdefghijklmnopqrstuvwxyz1234')).toBe('gsk_…1234');
    expect(maskApiKeyForDisplay('short')).toBe('••••••••');
    expect(maskApiKeyForDisplay('')).toBe('');
    expect(maskApiKeyForDisplay('   ')).toBe('');
  });
});

describe('publicSettingsFromDb', () => {
  test('masks keys and sets flags', () => {
    const db = {
      getAllSettings: () => ({
        llm_provider: 'groq',
        llm_model: 'x',
        llm_api_key: 'secretkey_one,two',
        summary_provider: 'same',
        summary_api_key: '',
      }),
    };
    const pub = publicSettingsFromDb(db);
    expect(pub.hasLlmApiKey).toBe(true);
    expect(pub.hasSummaryApiKey).toBe(false);
    expect(pub.llm_api_key).toMatch(/^secr…/);
    expect(pub.llm_api_key).toContain('…');
    expect(pub.summary_api_key).toBe('');
  });
});
