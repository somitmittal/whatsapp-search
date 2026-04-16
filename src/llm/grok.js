const BASE_URL = 'https://api.x.ai/v1';
const TIMEOUT_MS = 60_000;

export default class GrokProvider {
  constructor(apiKey, model = 'grok-2-latest') {
    this._apiKey = apiKey || '';
    this._model = model;
    this._availableModels = null;
  }

  get name() { return 'grok'; }
  get model() { return this._model; }
  get needsKey() { return true; }

  async checkHealth() {
    if (!this._apiKey) {
      console.log('[Grok] No API key configured');
      return false;
    }
    try {
      const res = await this._fetchRaw('/models', 'GET', null, 10_000);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.log(`[Grok] Health check failed (${res.status}): ${text.slice(0, 200)}`);
        return false;
      }
      const data = await res.json();
      if (data?.data) {
        this._availableModels = data.data.map(m => m.id);
        console.log(`[Grok] Available models: ${this._availableModels.join(', ')}`);
        if (!this._availableModels.includes(this._model)) {
          console.log(`[Grok] Warning: selected model "${this._model}" not in available list, trying anyway`);
        }
      }
      return true;
    } catch (err) {
      console.log(`[Grok] Health check error: ${err.message}`);
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

  async caption(imageBase64, mimeType = 'image/jpeg') {
    const visionModel = this._availableModels?.includes('grok-2-vision-latest')
      ? 'grok-2-vision-latest'
      : this._model;

    const body = {
      model: visionModel,
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
    return '[Audio transcription not yet supported via Grok API]';
  }

  async _fetchRaw(path, method, body, timeout) {
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
      return await fetch(`${BASE_URL}${path}`, init);
    } finally {
      clearTimeout(timer);
    }
  }

  async _fetch(path, method, body, timeout) {
    const res = await this._fetchRaw(path, method, body, timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Grok API ${res.status}: ${text.slice(0, 300)}`);
    }
    return res;
  }
}
