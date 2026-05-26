/**
 * Single source of truth for Ollama model tags in this app.
 * - BASE: same names work for local `ollama run` and ollama.com API.
 * - LOCAL_PROXY: only for the desktop Ollama app (cloud-routed huge models).
 * - CLOUD_EXTRA: larger models typically used on Ollama Cloud / hosted catalog.
 */

export const OLLAMA_MODELS_BASE = [
  'llama3.2:3b',
  'llama3.2:1b',
  'qwen3.5:4b',
  'mistral',
  'gemma2:9b',
  'phi3:mini',
];

/** Desktop app only — not the same as the ollama_cloud API provider. */
export const OLLAMA_MODELS_LOCAL_PROXY = [
  'glm-5.1:cloud',
  'deepseek-v3.1:671b-cloud',
  'kimi-k2:1t-cloud',
];

/**
 * Extra options for Ollama Cloud (library tags that exist on ollama.com).
 * Avoid desktop-only proxy tags here — those belong in LOCAL_PROXY only.
 * If a model 404s, run `ollama pull <name>` on ollama.com or pick from /api/tags (merged in Settings when a key is saved).
 */
export const OLLAMA_MODELS_CLOUD_EXTRA = [
  'glm-5.1:cloud',
  'qwen3:8b',
  'mistral-small3.2:24b',
  'deepseek-r1:7b',
  'deepseek-r1:latest',
  'gemma3:4b',
  'gpt-oss:20b',
  'gpt-oss:120b',
];

export function ollamaLocalModelList() {
  return [...OLLAMA_MODELS_BASE, ...OLLAMA_MODELS_LOCAL_PROXY];
}

export function ollamaCloudModelList() {
  return [...OLLAMA_MODELS_BASE, ...OLLAMA_MODELS_CLOUD_EXTRA];
}
