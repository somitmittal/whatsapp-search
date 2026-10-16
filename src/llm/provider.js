/**
 * Unified LLM provider interface and factory.
 * All providers implement: chat(), caption(), checkHealth().
 */

import { ollamaLocalModelList, ollamaCloudModelList } from './ollama-model-lists.js';
import { PROVIDER_MODELS } from './provider-models.js';

const PROVIDERS = {
  gemini: () => import('./gemini.js'),
  openai: () => import('./openai.js'),
  claude: () => import('./claude.js'),
  ollama: () => import('./ollama.js'),
  ollama_cloud: () => import('./ollama-cloud.js'),
  grok: () => import('./grok.js'),
  groq: () => import('./groq.js'),
  openrouter: () => import('./openrouter.js'),
  munito: () => import('./munito.js'),
};

export const PROVIDER_META = {
  openrouter: {
    name: 'OpenRouter (free tiers + paid)',
    free: true,
    keyRequired: true,
    models: [...PROVIDER_MODELS.openrouter],
  },
  munito: {
    name: 'Munito (EU · zero retention)',
    free: true,
    keyRequired: true,
    privacyNote: 'European inference (EU by default). Zero data retention for normal requests — prompts are not stored or used for training.',
    models: [...PROVIDER_MODELS.munito],
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
    models: [...PROVIDER_MODELS.groq],
  },
  gemini: { name: 'Google Gemini', free: true, keyRequired: true, models: [...PROVIDER_MODELS.gemini] },
  openai: { name: 'OpenAI', free: false, keyRequired: true, models: [...PROVIDER_MODELS.openai] },
  claude: { name: 'Anthropic Claude', free: false, keyRequired: true, models: [...PROVIDER_MODELS.claude] },
  grok: { name: 'Grok (xAI)', free: true, keyRequired: true, models: [...PROVIDER_MODELS.grok] },
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
