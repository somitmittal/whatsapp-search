import { audioFileExt } from '../whatsapp/voice-content.js';

const BASE_URL = 'https://api.openai.com/v1';
const TIMEOUT_MS = 60_000;

export default class OpenAIProvider {
  constructor(apiKey, model = 'gpt-6-luna') {
    this._apiKey = apiKey || '';
    this._model = model;
  }

  get name() { return 'openai'; }
  get model() { return this._model; }
  get needsKey() { return true; }

  async checkHealth() {
    if (!this._apiKey) return false;
    try {
      const res = await this._fetch('/models', 'GET', null, 8000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(messages, options = {}) {
    const body = {
      model: this._model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
    };

    const res = await this._fetch('/chat/completions', 'POST', body, options.timeoutMs ?? TIMEOUT_MS);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  }

  async *chatStream(messages, options = {}) {
    const { readTextChunks } = await import('./stream-chat.js');
    const body = {
      model: this._model,
      messages,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
      stream: true,
    };
    const res = await this._fetch('/chat/completions', 'POST', body, options.timeoutMs ?? TIMEOUT_MS);
    yield* readTextChunks(res.body);
  }

  async caption(imageBase64, mimeType = 'image/jpeg') {
    const body = {
      model: this._model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image in detail for search indexing. Include all visible text, objects, people, locations, activities, and notable details.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      }],
      max_tokens: 512,
    };

    const res = await this._fetch('/chat/completions', 'POST', body, TIMEOUT_MS);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  }

  /**
   * OpenAI `/audio/transcriptions` (Whisper / gpt-series ASR). Voice notes and
   * dictation clips up to the provider's typical 25 MB cap.
   */
  async transcribeAudio(audioBase64, mimeType = 'audio/ogg') {
    if (!this._apiKey) return '';
    let buf;
    try {
      buf = Buffer.from(audioBase64, 'base64');
    } catch {
      return '';
    }
    if (buf.length < 32) return '';

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: mimeType || 'audio/ogg' }), `audio.${audioFileExt(mimeType)}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this._apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI ASR ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = await res.json();
      return String(data?.text || '').trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async _fetch(path, method, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const init = {
        method,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this._apiKey}` },
      };
      if (body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${BASE_URL}${path}`, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 300)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}
