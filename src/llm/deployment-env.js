import os from 'os';

/** Smallest practical host RAM for `ollama serve` + a tiny model (see Ollama model cards). */
const MIN_HOST_RAM_GB = 2;

export function isRenderDeployment() {
  return process.env.RENDER === 'true'
    || Boolean(String(process.env.RENDER_EXTERNAL_URL || '').trim());
}

function ollamaAutoStartDisabled() {
  const v = String(process.env.OLLAMA_AUTO_START ?? '').trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no';
}

function hostRamGb() {
  return os.totalmem() / (1024 ** 3);
}

function isLocalOllamaHost() {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
  return host.includes('localhost') || host.includes('127.0.0.1');
}

/**
 * Whether this process may run `ollama serve` locally (desktop / dev with enough RAM).
 * Cloud hosts (Render) and low-RAM containers always return false.
 */
export function canSpawnLocalOllama() {
  if (ollamaAutoStartDisabled()) return false;
  if (isRenderDeployment()) return false;
  if (!isLocalOllamaHost()) return false;
  if (hostRamGb() < MIN_HOST_RAM_GB) return false;
  return true;
}

export function localOllamaUnsupportedReason() {
  if (ollamaAutoStartDisabled()) {
    return 'Local Ollama auto-start is disabled (OLLAMA_AUTO_START=false).';
  }
  if (isRenderDeployment()) {
    return 'Local Ollama cannot run on cloud hosting (e.g. Render). Use Groq or Ollama Cloud in Settings.';
  }
  if (!isLocalOllamaHost()) {
    return 'OLLAMA_HOST points to a remote server — this app will not start a local Ollama process.';
  }
  if (hostRamGb() < MIN_HOST_RAM_GB) {
    return `This machine has ~${hostRamGb().toFixed(1)} GB RAM — not enough for local Ollama. Use a cloud provider in Settings.`;
  }
  return '';
}
