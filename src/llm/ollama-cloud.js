const DEFAULT_BASE = 'https://ollama.com';
const TIMEOUT_MS = 180_000;

/** Model names returned by Ollama Cloud /api/tags (merge with static defaults in Settings UI). */
export async function fetchOllamaCloudModelNames(apiKey) {
  const keys = parseKeys(apiKey);
  if (!keys.length) return [];
  const base = (process.env.OLLAMA_CLOUD_URL || DEFAULT_BASE).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${base}/api/tags`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${keys[0]}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name).filter(Boolean);
    return [...new Set(names)].sort();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function parseKeys(raw) {
  if (!raw) return [];
  return String(raw).split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
}

/**
 * Ollama Cloud — hosted models at ollama.com (API key required).
 * Same HTTP API shape as local Ollama (/api/chat).
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md
 */
export default class OllamaCloudProvider {
  constructor(apiKey, model = 'qwen3.5:4b') {
    this._keys = parseKeys(apiKey);
    this._keyIdx = 0;
    this._model = model;
    this._baseUrl = (process.env.OLLAMA_CLOUD_URL || DEFAULT_BASE).replace(/\/$/, '');
  }

  get name() { return 'ollama_cloud'; }
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
      console.log('[Ollama Cloud] No API key — get one at ollama.com');
      return false;
    }
    try {
      const res = await this._fetchRaw(this._keys[0], '/api/tags', 'GET', null, 15_000);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.log(`[Ollama Cloud] Health failed (${res.status}): ${t.slice(0, 200)}`);
        return false;
      }
      console.log(`[Ollama Cloud] Connected (${this._keys.length} key(s))`);
      return true;
    } catch (err) {
      console.log(`[Ollama Cloud] Health error: ${err.message}`);
      return false;
    }
  }

  async chat(messages, options = {}) {
    const body = {
      model: this._model,
      messages,
      stream: false,
      options: {
        num_ctx: options.numCtx ?? 16384,
        temperature: options.temperature ?? 0.3,
      },
    };
    const res = await this._fetchWithRotation('/api/chat', 'POST', body, options.timeoutMs ?? TIMEOUT_MS);
    const data = await res.json();
    return data?.message?.content?.trim() || '';
  }

  async caption() {
    return '[Use a vision model on Ollama Cloud for images]';
  }

  async _fetchWithRotation(path, method, body, timeout) {
    const keyCount = this._keys.length || 1;
    for (let attempt = 0; attempt < keyCount + 1; attempt++) {
      const key = this._nextKey();
      if (!key) throw new Error('Ollama Cloud: no API key');
      try {
        const res = await this._fetchRaw(key, path, method, body, timeout);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 429 && attempt < keyCount) {
            console.log('[Ollama Cloud] Rotating key...');
            continue;
          }
          throw new Error(`Ollama Cloud ${res.status}: ${text.slice(0, 300)}`);
        }
        return res;
      } catch (err) {
        if (attempt < keyCount && (err.message?.includes('429'))) continue;
        throw err;
      }
    }
    throw new Error('Ollama Cloud: request failed');
  }

  async _fetchRaw(key, path, method, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const init = {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
        },
      };
      if (body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return await fetch(`${this._baseUrl}${path}`, init);
    } finally {
      clearTimeout(timer);
    }
  }
}
