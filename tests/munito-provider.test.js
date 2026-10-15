import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import MunitoProvider from '../src/llm/munito.js';
import { PROVIDER_META } from '../src/llm/provider.js';

describe('munito provider', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
    delete process.env.MUNITO_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test('is registered with privacy-oriented meta', () => {
    expect(PROVIDER_META.munito).toBeTruthy();
    expect(PROVIDER_META.munito.name).toMatch(/EU/i);
    expect(PROVIDER_META.munito.privacyNote).toMatch(/zero data retention/i);
    expect(PROVIDER_META.munito.models.length).toBeGreaterThan(0);
  });

  test('defaults to EU inference base URL', async () => {
    const p = new MunitoProvider('test-key', 'qwen/qwen3.8-27b');
    expect(p.name).toBe('munito');
    let seenUrl = '';
    const orig = global.fetch;
    global.fetch = async (url) => {
      seenUrl = String(url);
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'qwen/qwen3.8-27b' }] }),
        text: async () => '',
      };
    };
    try {
      await p.checkHealth();
      expect(seenUrl).toContain('api.eu.munito.ai/inference/v1/models');
    } finally {
      global.fetch = orig;
    }
  });

  test('chat posts OpenAI-compatible completions', async () => {
    const p = new MunitoProvider('k1', 'qwen/qwen3.8-27b');
    const orig = global.fetch;
    global.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe('qwen/qwen3.8-27b');
      expect(body.messages[0].content).toBe('hi');
      expect(init.headers.Authorization).toBe('Bearer k1');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '  hello from eu  ' } }] }),
        text: async () => '',
      };
    };
    try {
      const out = await p.chat([{ role: 'user', content: 'hi' }]);
      expect(out).toBe('hello from eu');
    } finally {
      global.fetch = orig;
    }
  });
});
