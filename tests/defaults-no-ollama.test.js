import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { applyLlmDefaultsIfUnset, cleanupUnselectedOllamaDefault } from '../src/llm/defaults.js';
import config from '../src/config.js';
import WebServer from '../src/web/server.js';
import EventEmitter from 'events';

describe('No default Ollama on desktop startup', () => {
  let origProvider;
  let origModel;

  beforeEach(() => {
    origProvider = process.env.LLM_PROVIDER;
    origModel = process.env.LLM_MODEL;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
  });

  afterEach(() => {
    if (origProvider !== undefined) process.env.LLM_PROVIDER = origProvider;
    else delete process.env.LLM_PROVIDER;
    if (origModel !== undefined) process.env.LLM_MODEL = origModel;
    else delete process.env.LLM_MODEL;
  });

  test('applyLlmDefaultsIfUnset does not set Ollama on desktop when unconfigured', () => {
    const settings = {};
    const db = {
      getSetting: (k) => settings[k],
      setSetting: (k, v) => { settings[k] = v; },
    };

    applyLlmDefaultsIfUnset(db);

    expect(settings.llm_provider).toBeFalsy();
    expect(settings.llm_model).toBeFalsy();
    expect(settings.summary_provider).toBeFalsy();
    expect(settings.summary_model).toBeFalsy();
  });

  test('cleanupUnselectedOllamaDefault clears legacy auto-defaulted Ollama when llm_user_selected is not 1', () => {
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

    cleanupUnselectedOllamaDefault(db);

    expect(settings.llm_provider).toBe('');
    expect(settings.llm_model).toBe('');
    expect(settings.summary_provider).toBe('');
    expect(settings.summary_model).toBe('');
    expect(settings.media_index_provider).toBe('');
    expect(settings.media_index_model).toBe('');
  });

  test('cleanupUnselectedOllamaDefault preserves Ollama when user explicitly selected it', () => {
    const settings = {
      llm_provider: 'ollama',
      llm_model: 'llama3.2:3b',
      llm_user_selected: '1',
      summary_provider: 'ollama',
      summary_model: 'llama3.2:3b',
    };
    const db = {
      getSetting: (k) => settings[k],
      setSetting: (k, v) => { settings[k] = v; },
    };

    cleanupUnselectedOllamaDefault(db);

    expect(settings.llm_provider).toBe('ollama');
    expect(settings.llm_model).toBe('llama3.2:3b');
  });

  test('cleanupUnselectedOllamaDefault preserves Ollama when LLM_PROVIDER is set in env', () => {
    process.env.LLM_PROVIDER = 'ollama';
    const settings = {
      llm_provider: 'ollama',
      llm_model: 'llama3.2:3b',
    };
    const db = {
      getSetting: (k) => settings[k],
      setSetting: (k, v) => { settings[k] = v; },
    };

    cleanupUnselectedOllamaDefault(db);

    expect(settings.llm_provider).toBe('ollama');
    expect(settings.llm_model).toBe('llama3.2:3b');
  });
});

describe('WebServer start error handling', () => {
  test('rejects promise on EADDRINUSE without uncaught exception', async () => {
    const fakeServer = new EventEmitter();
    fakeServer.listen = () => {
      // Simulate async error event from net.Server
      process.nextTick(() => {
        const err = new Error('listen EADDRINUSE: address already in use 127.0.0.1:3000');
        err.code = 'EADDRINUSE';
        fakeServer.emit('error', err);
      });
    };

    const server = Object.create(WebServer.prototype);
    server._server = fakeServer;

    await expect(server.start()).rejects.toThrow('listen EADDRINUSE');
  });
});
