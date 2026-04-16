import { spawn } from 'child_process';

const TIMEOUT_MS = 180_000;
const HEALTH_CACHE_MS = 30_000;
const START_COOLDOWN_MS = 60_000;
const PULL_COOLDOWN_MS = 300_000;

export default class OllamaProvider {
  constructor(_apiKey, model = 'qwen3.5:4b') {
    this._baseUrl = 'http://localhost:11434';
    this._model = model;
    this._healthyAt = 0;
    this._lastStartAttempt = 0;
    this._lastPullAttempt = 0;
    this._warmedUp = false;
    this.pullStatus = null;
  }

  get name() { return 'ollama'; }
  get model() { return this._model; }
  get needsKey() { return false; }

  async checkHealth() {
    if (Date.now() - this._healthyAt < HEALTH_CACHE_MS) return true;

    const running = await this._isRunning();
    if (!running) {
      await this._tryStart();
      if (!await this._isRunning()) return false;
    }

    const hasModel = await this._hasModel(this._model);
    if (!hasModel) {
      await this._tryPull(this._model);
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (await this._hasModel(this._model)) break;
        if (i === 2) return false;
      }
    }

    this._healthyAt = Date.now();

    if (!this._warmedUp && !this._warmingUp) {
      this._warmUp();
    }

    return true;
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

    const res = await this._fetch('/api/chat', 'POST', body, options.timeoutMs ?? TIMEOUT_MS);
    const data = await res.json();
    return data?.message?.content?.trim() || data?.response?.trim() || '';
  }

  async caption(imageBase64, _mimeType) {
    const body = {
      model: this._model,
      prompt: 'Describe this image in detail for search indexing. Include all visible text, objects, people, locations, activities, and notable details.',
      images: [imageBase64],
      stream: false,
    };

    const res = await this._fetch('/api/generate', 'POST', body, TIMEOUT_MS);
    const data = await res.json();
    return data?.response?.trim() || '';
  }

  async transcribeAudio(_audioBase64, _mimeType) {
    return '[Audio transcription requires Whisper model — use a cloud provider for audio support]';
  }

  async _isRunning() {
    try {
      const res = await this._fetch('/api/tags', 'GET', null, 5000);
      return res.ok;
    } catch {
      return false;
    }
  }

  async _hasModel(name) {
    try {
      const res = await this._fetch('/api/tags', 'GET', null, 5000);
      if (!res.ok) return false;
      const data = await res.json();
      return (data.models || []).some(m =>
        m.name === name || m.name === `${name}:latest` || m.name.startsWith(`${name}:`)
      );
    } catch {
      return false;
    }
  }

  async _tryStart() {
    if (Date.now() - this._lastStartAttempt < START_COOLDOWN_MS) return;
    this._lastStartAttempt = Date.now();

    console.log('[Ollama] Not running — starting automatically...');
    try {
      const child = spawn('ollama', ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();

      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (await this._isRunning()) {
          console.log('[Ollama] Server is up');
          return;
        }
      }
      console.warn('[Ollama] Started but not responding after 15s');
    } catch (err) {
      console.error('[Ollama] Auto-start failed:', err.message);
    }
  }

  async _tryPull(modelName) {
    if (Date.now() - this._lastPullAttempt < PULL_COOLDOWN_MS) return;
    this._lastPullAttempt = Date.now();

    console.log(`[Ollama] Model "${modelName}" not found — downloading (this may take a few minutes)...`);
    this.pullStatus = { model: modelName, status: 'downloading', percent: 0, detail: 'Starting download...' };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 600_000);
      const res = await fetch(`${this._baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: true }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[Ollama] Pull failed: ${text.slice(0, 200)}`);
        this.pullStatus = { model: modelName, status: 'error', percent: 0, detail: `Pull failed: ${text.slice(0, 100)}` };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            const pct = (evt.completed && evt.total)
              ? Math.round((evt.completed / evt.total) * 100)
              : this.pullStatus.percent;
            const detail = evt.status || 'Downloading...';
            this.pullStatus = { model: modelName, status: 'downloading', percent: pct, detail };
            if (pct % 10 === 0 && pct > 0 && pct !== this._lastLoggedPct) {
              this._lastLoggedPct = pct;
              console.log(`[Ollama] Pulling "${modelName}": ${pct}% — ${detail}`);
            }
          } catch { /* ignore malformed lines */ }
        }
      }

      console.log(`[Ollama] Pulled "${modelName}" successfully`);
      this.pullStatus = { model: modelName, status: 'done', percent: 100, detail: 'Download complete!' };
      setTimeout(() => { this.pullStatus = null; }, 10_000);
    } catch (err) {
      console.error(`[Ollama] Pull failed: ${err.message}`);
      this.pullStatus = { model: modelName, status: 'error', percent: 0, detail: err.message };
    }
  }

  _warmUp() {
    this._warmingUp = true;
    console.log(`[Ollama] Pre-loading ${this._model} into memory...`);
    const body = { model: this._model, prompt: 'hi', stream: false, options: { num_predict: 1 } };
    this._fetch('/api/generate', 'POST', body, TIMEOUT_MS)
      .then(() => {
        this._warmedUp = true;
        this._warmingUp = false;
        console.log(`[Ollama] ${this._model} loaded and ready`);
      })
      .catch(() => { this._warmingUp = false; });
  }

  async _fetch(path, method, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const init = { method, signal: controller.signal, headers: {} };
      if (body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(`${this._baseUrl}${path}`, init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}
