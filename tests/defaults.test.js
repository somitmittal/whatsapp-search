import { describe, expect, test } from '@jest/globals';
import { migrateAwayFromLocalOllama, maskApiKeyForDisplay, publicSettingsFromDb } from '../src/llm/defaults.js';

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
        media_index_provider: 'gemini',
        media_index_api_key: '',
      }),
    };
    const pub = publicSettingsFromDb(db);
    expect(pub.hasLlmApiKey).toBe(true);
    expect(pub.hasSummaryApiKey).toBe(false);
    expect(pub.hasMediaIndexApiKey).toBe(false);
    expect(pub.llm_api_key).toMatch(/^secr…/);
    expect(pub.llm_api_key).toContain('…');
    expect(pub.summary_api_key).toBe('');
  });
});

describe('migrateAwayFromLocalOllama', () => {
  test('moves ollama providers to cloud defaults on Render', () => {
    const prev = process.env.RENDER;
    process.env.RENDER = 'true';
    const settings = {
      llm_provider: 'ollama',
      llm_model: 'llama3.2:3b',
      summary_provider: 'ollama',
      summary_model: 'llama3.2:3b',
      media_index_provider: 'ollama',
      media_index_model: 'llama3.2:3b',
    };
    const db = {
      getSetting: (k) => settings[k],
      setSetting: (k, v) => { settings[k] = v; },
    };
    migrateAwayFromLocalOllama(db);
    expect(settings.llm_provider).toBe('groq');
    expect(settings.summary_provider).toBe('ollama_cloud');
    expect(settings.media_index_provider).toBe('gemini');
    if (prev === undefined) delete process.env.RENDER;
    else process.env.RENDER = prev;
  });
});
