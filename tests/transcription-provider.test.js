import { describe, expect, jest, test } from '@jest/globals';
import {
  TRANSCRIBE_PROVIDER_ORDER,
  findTranscriptionProvider,
  isUsableTranscription,
} from '../src/llm/transcription.js';

describe('isUsableTranscription', () => {
  test('rejects empty text', () => {
    expect(isUsableTranscription('')).toBe(false);
    expect(isUsableTranscription(null)).toBe(false);
    expect(isUsableTranscription('   ')).toBe(false);
  });

  test('rejects the placeholder string non-ASR providers return', () => {
    expect(isUsableTranscription('[Audio transcription not supported via OpenAI chat API — use Whisper endpoint separately]')).toBe(false);
    expect(isUsableTranscription('[Audio transcription not directly supported via Claude API]')).toBe(false);
  });

  test('accepts real transcripts', () => {
    expect(isUsableTranscription('Hi Sumit, hope it downloaded and worked for you.')).toBe(true);
  });
});

describe('findTranscriptionProvider', () => {
  test('returns the cheapest configured provider first', async () => {
    const created = { gemini: { transcribeAudio: jest.fn() }, groq: { transcribeAudio: jest.fn() } };
    const found = await findTranscriptionProvider(async (id) => created[id]);
    expect(found.id).toBe('gemini');
    expect(found.provider).toBe(created.gemini);
  });

  test('skips unconfigured providers and falls through to the next', async () => {
    const groqInstance = { transcribeAudio: jest.fn() };
    // gemini throws (no key), groq available.
    const found = await findTranscriptionProvider(async (id) => {
      if (id === 'groq') return groqInstance;
      throw new Error(`${id} has no API key yet`);
    });
    expect(found.id).toBe('groq');
    expect(found.provider).toBe(groqInstance);
  });

  test('unwraps {provider} results from the factory', async () => {
    const provider = { transcribeAudio: jest.fn() };
    const found = await findTranscriptionProvider(async (id) => ({ provider: [id] && provider, selection: null }));
    expect(found.provider).toBe(provider);
  });

  test('returns null when no provider is usable', async () => {
    const found = await findTranscriptionProvider(async () => {
      throw new Error('no key');
    });
    expect(found).toBe(null);
  });

  test('provider order puts the free ASR providers first', () => {
    expect([...TRANSCRIBE_PROVIDER_ORDER]).toEqual(['gemini', 'groq', 'openai']);
  });
});
