/**
 * Munito — EU open-model inference (OpenAI-compatible Chat Completions).
 * Default: EU endpoint, zero data retention for transient inference.
 * @see https://docs.munito.ai/quickstart
 */

const DEFAULT_BASE = 'https://api.eu.munito.ai/inference/v1';
const TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = 'qwen/qwen3.8-27b';

function parseKeys(raw) {
  if (!raw) return [];
  return String(raw).split(/[\n,]+/).map((k) => k.trim()).filter(Boolean);
}

function baseUrl() {
  const raw = (process.env.MUNITO_BASE_URL || '').trim().replace(/\/$/, '');
  return raw || DEFAULT_BASE;
}

export default class MunitoProvider {
  constructor(apiKey, model = DEFAULT_MODEL) {
    this._keys = parseKeys(apiKey);
    this._keyIdx = 0;
    this._model = model || DEFAULT_MODEL;
    this._base = baseUrl();
  }

  get name() { return 'munito'; }
  get model() { return this._model; }
  get needsKey() { return true; }

  _nextKey() {
    if (this._keys.length === 0) return '';
    const key = this._keys[this._keyIdx % this._keys.length];
    this._keyIdx = (this._keyIdx + 1) % this._keys.length;
    return key;
  }

  async checkHealth() {
    if (this._keys.length === 0) {
      console.log('[Munito] No API key configured');
      return false;
    }
    try {
      const res = await this._fetchRaw(this._keys[0], '/models', 'GET', null, 12_000);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.log(`[Munito] Health check failed (${res.status}): ${text.slice(0, 200)}`);
        return false;
      }
      const data = await res.json();
      const n = Array.isArray(data?.data) ? data.data.length : 0;
      console.log(`[Munito] OK (${n} models, base=${this._base})`);
      return true;
    } catch (err) {
      console.log(`[Munito] Health check error: ${err.message}`);
      return false;
    }
  }

  async chat(messages, options = {}) {
    const body = {
      model: this._model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
    };
    const res = await this._fetchWithRotation('/chat/completions', 'POST', body, options.timeoutMs ?? TIMEOUT_MS);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  }

  async caption(imageBase64, mimeType = 'image/jpeg') {
    const body = {
      model: this._model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe this image in detail for search indexing. Include all visible text, objects, people, locations, activities, and notable details.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${imageBase64}` },
          },
        ],
      }],
      max_tokens: 512,
    };
    try {
      const res = await this._fetchWithRotation('/chat/completions', 'POST', body, TIMEOUT_MS);
      const data = await res.json();
      return data?.choices?.[0]?.message?.content?.trim()
        || '[Vision: this Munito model may not support images — pick a multimodal model]';
    } catch (err) {
      return `[Vision unavailable: ${err.message}]`;
    }
  }

  async transcribeAudio(_audioBase64, _mimeType) {
    return '[Audio transcription not supported via Munito chat API]';
  }

  async _fetchWithRotation(path, method, body, timeout) {
    const keyCount = this._keys.length || 1;
    for (let attempt = 0; attempt < keyCount + 2; attempt++) {
      const key = this._nextKey();
      if (!key) throw new Error('Munito: no API key configured');
      try {
        const res = await this._fetchRaw(key, path, method, body, timeout);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if ((res.status === 429 || res.status === 503) && attempt < keyCount + 1) {
            console.log('[Munito] Rate limit / busy — rotating key...');
            continue;
          }
          throw new Error(`Munito API ${res.status}: ${text.slice(0, 400)}`);
        }
        return res;
      } catch (err) {
        const msg = err.message || '';
        if ((msg.includes('429') || msg.includes('503')) && attempt < keyCount + 1) continue;
        throw err;
      }
    }
    throw new Error('Munito: all keys exhausted or rate-limited');
  }

  async _fetchRaw(key, path, method, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = {
        Authorization: `Bearer ${key}`,
      };
      if (body && method !== 'GET') {
        headers['Content-Type'] = 'application/json';
      }
      const init = {
        method,
        signal: controller.signal,
        headers,
      };
      if (body && method !== 'GET') init.body = JSON.stringify(body);
      return await fetch(`${this._base}${path}`, init);
    } finally {
      clearTimeout(timer);
    }
  }
}
