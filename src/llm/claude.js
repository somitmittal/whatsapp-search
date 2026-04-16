const BASE_URL = 'https://api.anthropic.com/v1';
const TIMEOUT_MS = 60_000;

export default class ClaudeProvider {
  constructor(apiKey, model = 'claude-sonnet-4-20250514') {
    this._apiKey = apiKey || '';
    this._model = model;
  }

  get name() { return 'claude'; }
  get model() { return this._model; }
  get needsKey() { return true; }

  async checkHealth() {
    if (!this._apiKey) return false;
    try {
      const res = await this._fetch('/messages', 'POST', {
        model: this._model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }, 8000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(messages, options = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');

    const body = {
      model: this._model,
      max_tokens: options.maxTokens ?? 2048,
      messages: nonSystem,
    };
    if (systemMsg) body.system = systemMsg.content;

    const res = await this._fetch('/messages', 'POST', body, options.timeoutMs ?? TIMEOUT_MS);
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() || '';
  }

  async caption(imageBase64, mimeType = 'image/jpeg') {
    const body = {
      model: this._model,
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: 'Describe this image in detail for search indexing. Include all visible text, objects, people, locations, activities, and notable details.' },
        ],
      }],
    };

    const res = await this._fetch('/messages', 'POST', body, TIMEOUT_MS);
    const data = await res.json();
    return data?.content?.[0]?.text?.trim() || '';
  }

  async transcribeAudio(_audioBase64, _mimeType) {
    return '[Audio transcription not directly supported via Claude API]';
  }

  async _fetch(path, method, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const init = {
        method,
        signal: controller.signal,
        headers: {
          'x-api-key': this._apiKey,
          'anthropic-version': '2023-06-01',
        },
      };
      if (body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${BASE_URL}${path}`, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}
