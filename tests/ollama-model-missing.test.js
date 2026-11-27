import { describe, expect, test } from '@jest/globals';
import {
  OllamaModelMissingError,
  parseOllamaModelMissing,
} from '../src/llm/ollama.js';

describe('OllamaModelMissingError', () => {
  test('exposes a stable code and model for the Ask AI download CTA', () => {
    const err = new OllamaModelMissingError('qwen3.5:4b');
    expect(err.code).toBe('ollama_model_missing');
    expect(err.model).toBe('qwen3.5:4b');
    expect(err.message).toMatch(/not installed/i);
    expect(err.message).not.toMatch(/Ollama 404/);
  });
});

describe('parseOllamaModelMissing', () => {
  test('parses raw Ollama 404 payloads', () => {
    const parsed = parseOllamaModelMissing(
      `Ollama 404: {"error":"model 'qwen3.5:4b' not found"}`,
    );
    expect(parsed).toEqual({ model: 'qwen3.5:4b', code: 'ollama_model_missing' });
  });

  test('passes through structured errors', () => {
    const err = new OllamaModelMissingError('llama3.2:3b');
    expect(parseOllamaModelMissing(err)).toEqual({
      model: 'llama3.2:3b',
      code: 'ollama_model_missing',
    });
  });

  test('returns null for unrelated failures', () => {
    expect(parseOllamaModelMissing('Ollama 500: boom')).toBeNull();
    expect(parseOllamaModelMissing(null)).toBeNull();
  });
});
