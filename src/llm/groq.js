const BASE_URL = 'https://api.groq.com/openai/v1';
const TIMEOUT_MS = 60_000;
const ASR_TIMEOUT_MS = 120_000;

function mimeToAudioFilenameExt(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('audio/mp4')) return 'm4a';
  if (m.includes('webm')) return 'webm';
  if (m.includes('flac')) return 'flac';
  return 'ogg';
}

/** Parse one or more API keys from a comma/newline-separated string. */
function parseKeys(raw) {
  if (!raw) return [];
  return String(raw).split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
}

export default class GroqProvider {
  constructor(apiKey, model = 'llama-3.3-70b-versatile') {
    this._keys = parseKeys(apiKey);
    this._keyIdx = 0;
    this._model = model;
  }

  get name() { return 'groq'; }
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
    if (this._keys.length === 0) {
      console.log('[Groq] No API key configured');
      return false;
    }
    try {
      const res = await this._fetchRaw(this._keys[0], '/models', 'GET', null, 10_000);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.log(`[Groq] Health check failed (${res.status}): ${text.slice(0, 200)}`);
        return false;
      }
      const data = await res.json();
      if (data?.data) {
        const modelIds = data.data.map(m => m.id);
        console.log(`[Groq] ${modelIds.length} models available (${this._keys.length} key(s) configured)`);
        if (!modelIds.includes(this._model)) {
          console.log(`[Groq] Warning: selected model "${this._model}" not in available list`);
        }
      }
      return true;
    } catch (err) {
      console.log(`[Groq] Health check error: ${err.message}`);
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

    const res = await this._fetchWithRotation('/chat/completions', 'POST', body, options.timeoutMs ?? TIMEOUT_MS);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  }

  async caption(_imageBase64, _mimeType) {
    return '[Image captioning not supported via Groq — use Gemini or OpenAI for media]';
  }

  /**
   * Groq Whisper (OpenAI-compatible `/audio/transcriptions`).
   * Voice notes / audio clips up to provider max size (typically 25 MB).
   */
  async transcribeAudio(audioBase64, mimeType = 'audio/ogg') {
    if (!this._keys.length) return '';
    let buf;
    try {
      buf = Buffer.from(audioBase64, 'base64');
    } catch {
      return '';
    }
    if (buf.length < 32) return '';

    const ext = mimeToAudioFilenameExt(mimeType);
    const keyCount = this._keys.length || 1;

    for (let attempt = 0; attempt < keyCount + 1; attempt++) {
      const key = this._nextKey();
      if (!key) return '';

      const form = new FormData();
      form.append('file', new Blob([buf]), `audio.${ext}`);
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'json');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS);
      try {
        const res = await fetch(`${BASE_URL}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal: controller.signal,
        });
        if (res.status === 429 && attempt < keyCount) {
          console.log('[Groq ASR] 429, rotating key…');
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Groq ASR ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        return String(data?.text || '').trim();
      } catch (err) {
        if (attempt < keyCount && (err.name === 'AbortError' || `${err.message}`.includes('429'))) {
          continue;
        }
        console.warn('[Groq ASR]', err.message);
        return '';
      } finally {
        clearTimeout(timer);
      }
    }
    return '';
  }

  /**
   * Tries every key in round-robin on 429 before giving up.
   */
  async _fetchWithRotation(path, method, body, timeout) {
    const keyCount = this._keys.length || 1;

    for (let attempt = 0; attempt < keyCount + 1; attempt++) {
      const key = this._nextKey();
      if (!key) throw new Error('Groq: no API key configured');

      try {
        const res = await this._fetchRaw(key, path, method, body, timeout);
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 429 && attempt < keyCount) {
            console.log(`[Groq] Key #${(this._keyIdx - 1 + keyCount) % keyCount + 1} rate-limited (429), rotating to next key...`);
            continue;
          }
          throw new Error(`Groq API ${res.status}: ${text.slice(0, 300)}`);
        }
        return res;
      } catch (err) {
        const is429 = err.message?.includes('429');
        if (is429 && attempt < keyCount) {
          console.log(`[Groq] Key rate-limited, rotating...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('Groq: all keys rate-limited — please wait before retrying');
  }

  async _fetchRaw(key, path, method, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const init = {
        method,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${key}` },
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
}
