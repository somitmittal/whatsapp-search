/**
 * Unified LLM provider interface and factory.
 * All providers implement: chat(), caption(), checkHealth().
 */

import { ollamaLocalModelList, ollamaCloudModelList } from './ollama-model-lists.js';

const PROVIDERS = {
  gemini: () => import('./gemini.js'),
  openai: () => import('./openai.js'),
  claude: () => import('./claude.js'),
  ollama: () => import('./ollama.js'),
  ollama_cloud: () => import('./ollama-cloud.js'),
  grok: () => import('./grok.js'),
  groq: () => import('./groq.js'),
  openrouter: () => import('./openrouter.js'),
};

export const PROVIDER_META = {
  openrouter: {
    name: 'OpenRouter (free tiers + paid)',
    free: true,
    keyRequired: true,
    models: [
      'google/gemma-2-9b-it:free',
      'meta-llama/llama-3.2-3b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'qwen/qwen-2.5-7b-instruct:free',
      'meta-llama/llama-3.2-1b-instruct:free',
    ],
  },
  ollama_cloud: {
    name: 'Ollama Cloud',
    free: false,
    keyRequired: true,
    models: ollamaCloudModelList(),
  },
  groq: {
    name: 'Groq (Fast Llama)',
    free: true,
    keyRequired: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b'],
  },
  gemini: { name: 'Google Gemini', free: true, keyRequired: true, models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'] },
  openai: { name: 'OpenAI', free: false, keyRequired: true, models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'] },
  claude: { name: 'Anthropic Claude', free: false, keyRequired: true, models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'] },
  grok: { name: 'Grok (xAI)', free: true, keyRequired: true, models: ['grok-2-latest', 'grok-2-mini'] },
  ollama: { name: 'Ollama (local)', free: true, keyRequired: false, models: ollamaLocalModelList() },
};

const _cache = new Map();

export async function createProvider(providerName, apiKey, model) {
  const key = `${providerName}:${apiKey || ''}:${model || ''}`;
  if (_cache.has(key)) return _cache.get(key);

  const loader = PROVIDERS[providerName];
  if (!loader) throw new Error(`Unknown provider: ${providerName}`);

  const mod = await loader();
  const instance = new mod.default(apiKey, model);
  _cache.set(key, instance);
  return instance;
}

export function clearProviderCache() {
  _cache.clear();
}
