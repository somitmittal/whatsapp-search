const BASE_URL = 'https://api.openai.com/v1';
const TIMEOUT_MS = 60_000;

export default class OpenAIProvider {
  constructor(apiKey, model = 'gpt-4o-mini') {
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

    const res = await this._fetch('/chat/completions', 'POST', body, TIMEOUT_MS);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
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

  async transcribeAudio(_audioBase64, _mimeType) {
    return '[Audio transcription not supported via OpenAI chat API — use Whisper endpoint separately]';
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
