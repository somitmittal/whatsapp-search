import { describe, afterEach, expect, jest, test } from '@jest/globals';

const originalFetch = globalThis.fetch;

describe('OpenAIProvider.transcribeAudio', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const loadProvider = async () => (await import('../src/llm/openai.js')).default;

  test('posts a Whisper multipart request and returns the transcript', async () => {
    const Provider = await loadProvider();
    const provider = new Provider('sk-test', 'gpt-6-luna');

    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ text: 'Hi Sumit, hope it downloaded and worked for you.' }),
    }));

    const b64 = Buffer.from('fake-opus-audio-bytes-more-than-32-bytes-..........').toString('base64');
    const text = await provider.transcribeAudio(b64, 'audio/mp4');

    expect(text).toBe('Hi Sumit, hope it downloaded and worked for you.');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body;
    expect(form.get('model')).toBe('whisper-1');
    const file = form.get('file');
    expect(file.name).toBe('audio.m4a');
    expect(file.type).toBe('audio/mp4');
  });

  test('returns empty string without a key or with tiny payloads', async () => {
    const Provider = await loadProvider();
    const noKey = new Provider('', 'gpt-6-luna');
    await expect(noKey.transcribeAudio('YWJjZGVmZ2hpamtsbW5vcA==', 'audio/webm')).resolves.toBe('');

    const withKey = new Provider('sk-test', 'gpt-6-luna');
    await expect(withKey.transcribeAudio(Buffer.from('ab').toString('base64'), 'audio/webm')).resolves.toBe('');
  });

  test('surfaces API errors instead of returning fake transcripts', async () => {
    const Provider = await loadProvider();
    const provider = new Provider('sk-test', 'gpt-6-luna');
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    }));
    const b64 = Buffer.from('fake-opus-audio-bytes-more-than-32-bytes-..........').toString('base64');
    await expect(provider.transcribeAudio(b64, 'audio/webm')).rejects.toThrow(/OpenAI ASR 401/);
  });
});
