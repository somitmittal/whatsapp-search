const BASE_URL = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 120_000;

function parseKeys(raw) {
  if (!raw) return [];
  return String(raw).split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
}

/**
 * OpenRouter — many models including free `:free` tiers.
 * @see https://openrouter.ai/docs
 */
export default class OpenRouterProvider {
  constructor(apiKey, model = 'google/gemma-2-9b-it:free') {
    this._keys = parseKeys(apiKey);
    this._keyIdx = 0;
    this._model = model;
  }

  get name() { return 'openrouter'; }
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
      console.log('[OpenRouter] No API key configured');
      return false;
    }
    try {
      const res = await this._fetchRaw(this._keys[0], '/models', 'GET', null, 15_000);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.log(`[OpenRouter] Health check failed (${res.status}): ${text.slice(0, 200)}`);
        return false;
      }
      const data = await res.json();
      console.log(`[OpenRouter] OK (${data?.data?.length || 0} models listed, ${this._keys.length} key(s))`);
      return true;
    } catch (err) {
      console.log(`[OpenRouter] Health check error: ${err.message}`);
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

  async caption() {
    return '[Vision: pick a multimodal model on OpenRouter]';
  }

  async _fetchWithRotation(path, method, body, timeout) {
    const keyCount = this._keys.length || 1;
    for (let attempt = 0; attempt < keyCount + 2; attempt++) {
      const key = this._nextKey();
      if (!key) throw new Error('OpenRouter: no API key configured');
      try {
        const res = await this._fetchRaw(key, path, method, body, timeout);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if ((res.status === 429 || res.status === 503) && attempt < keyCount + 1) {
            console.log('[OpenRouter] Rate limit / busy — rotating key...');
            continue;
          }
          throw new Error(`OpenRouter API ${res.status}: ${text.slice(0, 400)}`);
        }
        return res;
      } catch (err) {
        const msg = err.message || '';
        if ((msg.includes('429') || msg.includes('503')) && attempt < keyCount + 1) continue;
        throw err;
      }
    }
    throw new Error('OpenRouter: all keys exhausted or rate-limited');
  }

  async _fetchRaw(key, path, method, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = {
        Authorization: `Bearer ${key}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'WhatsApp Search',
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
      return await fetch(`${BASE_URL}${path}`, init);
    } finally {
      clearTimeout(timer);
    }
  }
}
