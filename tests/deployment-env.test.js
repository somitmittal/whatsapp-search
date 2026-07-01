import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import {
  canSpawnLocalOllama,
  isRenderDeployment,
  localOllamaUnsupportedReason,
} from '../src/llm/deployment-env.js';

describe('deployment-env', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env = { ...envBackup };
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  test('detects Render deployment', () => {
    delete process.env.RENDER;
    delete process.env.RENDER_EXTERNAL_URL;
    expect(isRenderDeployment()).toBe(false);
    process.env.RENDER = 'true';
    expect(isRenderDeployment()).toBe(true);
  });

  test('disallows spawn on Render', () => {
    process.env.RENDER = 'true';
    expect(canSpawnLocalOllama()).toBe(false);
    expect(localOllamaUnsupportedReason()).toMatch(/cloud hosting/i);
  });

  test('disallows spawn when OLLAMA_AUTO_START=false', () => {
    delete process.env.RENDER;
    delete process.env.RENDER_EXTERNAL_URL;
    process.env.OLLAMA_AUTO_START = 'false';
    expect(canSpawnLocalOllama()).toBe(false);
  });
});
