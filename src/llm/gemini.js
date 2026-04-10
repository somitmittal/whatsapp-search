const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 60_000;

const FALLBACK_CHAIN = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
];

/** Parse one or more API keys from a comma/newline-separated string. */
function parseKeys(raw) {
  if (!raw) return [];
  return String(raw).split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
}

export default class GeminiProvider {
  constructor(apiKey, model = 'gemini-2.5-flash') {
    this._keys = parseKeys(apiKey);
    this._keyIdx = 0;
    this._model = model;
    this._fallbackModels = FALLBACK_CHAIN.filter(m => m !== model);
  }

  get name() { return 'gemini'; }
  get model() { return this._model; }
  get needsKey() { return true; }

  /** Returns the current key and advances the index for the next call. */
  _nextKey() {
    if (this._keys.length === 0) return '';
    const key = this._keys[this._keyIdx % this._keys.length];
    this._keyIdx = (this._keyIdx + 1) % this._keys.length;
    return key;
  }

  async checkHealth() {
    if (this._keys.length === 0) return false;
    try {
      const res = await this._fetchWithKey(this._keys[0], `/models/${this._model}`, 'GET', null, 8000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(messages, options = {}) {
    const contents = messages.map(m => ({
      role: m.role === 'system' ? 'user' : m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    if (messages[0]?.role === 'system' && contents.length > 1) {
      contents[0].parts[0].text = `[System instruction]\n${messages[0].content}`;
    }

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.3,
        maxOutputTokens: options.maxTokens ?? 2048,
      },
    };

    const res = await this._fetchWithFallback(
      `/models/${this._model}:generateContent`, 'POST', body, TIMEOUT_MS,
    );
    const data = await res.json();
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      console.log(`[Gemini] Chat finishReason: ${candidate.finishReason}`);
    }
    return candidate?.content?.parts?.[0]?.text?.trim() || '';
  }

  async caption(imageBase64, mimeType = 'image/jpeg') {
    const body = {
      contents: [{
        parts: [
          { text: 'Describe this image in detail for search indexing. Include all visible text, objects, people, locations, activities, colors, and any other notable details.' },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      }],
      generationConfig: { maxOutputTokens: 512 },
    };

    const res = await this._fetchWithFallback(
      `/models/${this._model}:generateContent`, 'POST', body, TIMEOUT_MS,
    );
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  async transcribeAudio(audioBase64, mimeType = 'audio/ogg') {
    const body = {
      contents: [{
        parts: [
          { text: 'Transcribe this audio message word for word. If there are multiple speakers, identify them.' },
          { inline_data: { mime_type: mimeType, data: audioBase64 } },
        ],
      }],
      generationConfig: { maxOutputTokens: 1024 },
    };

    const res = await this._fetchWithFallback(
      `/models/${this._model}:generateContent`, 'POST', body, TIMEOUT_MS,
    );
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  }

  async _fetchWithFallback(path, method, body, timeout) {
    const modelInPath = path.includes(`/models/${this._model}`);
    const modelsToTry = [this._model, ...this._fallbackModels];

    for (const model of modelsToTry) {
      const actualPath = modelInPath
        ? path.replace(`/models/${this._model}`, `/models/${model}`)
        : path;
      try {
        return await this._fetchWithRotation(actualPath, method, body, timeout);
      } catch (err) {
        const retryable = err.message?.includes('429') || err.message?.includes('503');
        if (retryable) {
          console.log(`[Gemini] ${model} unavailable (${err.message?.match(/\d{3}/)?.[0]}), trying next model...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('Gemini: all models unavailable — try again shortly');
  }

  /**
   * Tries every key in round-robin on 429 before giving up.
   * Each key gets one attempt; if all are rate-limited, backs off and retries once.
   */
  async _fetchWithRotation(path, method, body, timeout) {
    const keyCount = this._keys.length || 1;

    for (let attempt = 0; attempt < keyCount + 1; attempt++) {
      const key = this._nextKey();
      if (!key) throw new Error('Gemini: no API key configured');

      try {
        const res = await this._fetchWithKey(key, path, method, body, timeout);
        return res;
      } catch (err) {
        const is429 = err.message?.includes('429');
        const is503 = err.message?.includes('503');

        if (is429 && attempt < keyCount) {
          // Rotate to next key immediately
          console.log(`[Gemini] Key #${(this._keyIdx) % keyCount + 1} rate-limited (429), rotating to next key...`);
          continue;
        }
        if (is503 && attempt < keyCount) {
          console.log(`[Gemini] 503, rotating key...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('Gemini: all keys rate-limited — please wait before retrying');
  }

  async _fetchWithKey(key, path, method, body, timeout, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const url = `${BASE_URL}${path}?key=${key}`;
        const init = { method, signal: controller.signal, headers: {} };
        if (body) {
          init.headers['Content-Type'] = 'application/json';
          init.body = JSON.stringify(body);
        }
        const res = await fetch(url, init);
        if ((res.status === 429 || res.status === 503) && attempt < retries) {
          clearTimeout(timer);
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Gemini API ${res.status}: ${text.slice(0, 300)}`);
        }
        return res;
      } catch (err) {
        clearTimeout(timer);
        const retryable = err.message?.includes('429') || err.message?.includes('503');
        if (attempt < retries && retryable) continue;
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
