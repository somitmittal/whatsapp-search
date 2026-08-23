import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { canSpawnLocalOllama } from './deployment-env.js';

const TIMEOUT_MS = 180_000;
const HEALTH_CACHE_MS = 30_000;
const START_COOLDOWN_MS = 15_000;
const PULL_COOLDOWN_MS = 30_000;

/** Existing provider default when `OLLAMA_KEEP_ALIVE` is unset. */
export const OLLAMA_DEFAULT_KEEP_ALIVE_SEC = 300;
/** Existing `/api/chat` fallback when `OLLAMA_NUM_CTX` is unset. */
export const OLLAMA_DEFAULT_NUM_CTX = 4096;

export default class OllamaProvider {
  constructor(_apiKey, model = 'llama3.2:3b') {
    this._baseUrl = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
    this._model = model;
    this._healthyAt = 0;
    this._lastStartAttempt = 0;
    this._lastPullAttempt = 0;
    this._warmedUp = false;
    this.pullStatus = null;
    // Seconds to keep model loaded after a request (avoids ~3s reload on each call).
    // Default 300s (5 min) balances speed vs memory. Set OLLAMA_KEEP_ALIVE=0 to unload immediately.
    const envKeepAlive = process.env.OLLAMA_KEEP_ALIVE;
    this._keepAlive = envKeepAlive !== undefined ? Number(envKeepAlive) : OLLAMA_DEFAULT_KEEP_ALIVE_SEC;
  }

  get name() { return 'ollama'; }
  get model() { return this._model; }
  get needsKey() { return false; }

  resetHealthCache() { this._healthyAt = 0; }

  async checkHealth() {
    if (Date.now() - this._healthyAt < HEALTH_CACHE_MS) return true;

    const running = await this._isRunning();
    if (!running) {
      await this._tryStart();
      if (!await this._isRunning()) return false;
    }

    const hasModel = await this._hasModel(this._model);
    if (!hasModel) {
      this._tryPull(this._model).catch(e => console.error('[Ollama] Pull error:', e.message));
      // Give it a brief moment — small models on fast connections may finish quickly.
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (await this._hasModel(this._model)) { this._healthyAt = Date.now(); return true; }
        if (this.pullStatus?.status === 'error') return false;
      }
      // Still downloading — return false but pull continues in background.
      return false;
    }

    this._healthyAt = Date.now();
    return true;
  }

  async chat(messages, options = {}) {
    const body = {
      model: this._model,
      messages,
      stream: false,
      keep_alive: options.keepAlive ?? this._keepAlive,
      options: {
        num_ctx: options.numCtx ?? (Number(process.env.OLLAMA_NUM_CTX) || OLLAMA_DEFAULT_NUM_CTX),
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
      keep_alive: this._keepAlive,
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this._baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      await res.text().catch(() => {});
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

  _findOllamaBin() {
    const candidates = [
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      '/usr/bin/ollama',
    ];
    if (process.platform === 'darwin') {
      candidates.push('/Applications/Ollama.app/Contents/Resources/ollama');
    }
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return null;
  }

  async _tryStart() {
    if (!canSpawnLocalOllama()) return;
    if (Date.now() - this._lastStartAttempt < START_COOLDOWN_MS) return;
    this._lastStartAttempt = Date.now();

    const bin = this._findOllamaBin();
    if (!bin) {
      console.warn('[Ollama] Binary not found — install from https://ollama.com/download or use a cloud LLM provider');
      return;
    }

    console.log('[Ollama] Not running — starting automatically...');
    try {
      const env = { ...process.env };
      if (!env.OLLAMA_NUM_PARALLEL) env.OLLAMA_NUM_PARALLEL = '4';
      const child = spawn(bin, ['serve'], {
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.on('error', (err) => {
        console.error('[Ollama] Auto-start failed:', err.message);
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
    if (this.pullStatus?.status === 'downloading') return;
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
