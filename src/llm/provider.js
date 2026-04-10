/**
 * Unified LLM provider interface and factory.
 * All providers implement: chat(), caption(), checkHealth().
 */

const PROVIDERS = {
  gemini: () => import('./gemini.js'),
  openai: () => import('./openai.js'),
  claude: () => import('./claude.js'),
  ollama: () => import('./ollama.js'),
  grok: () => import('./grok.js'),
  groq: () => import('./groq.js'),
};

export const PROVIDER_META = {
  groq: { name: 'Groq (Fast Llama)', free: true, keyRequired: true, models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b'] },
  gemini: { name: 'Google Gemini', free: true, keyRequired: true, models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'] },
  openai: { name: 'OpenAI', free: false, keyRequired: true, models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1-nano'] },
  claude: { name: 'Anthropic Claude', free: false, keyRequired: true, models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'] },
  grok: { name: 'Grok (xAI)', free: true, keyRequired: true, models: ['grok-2-latest', 'grok-2-mini'] },
  ollama: { name: 'Ollama', free: true, keyRequired: false, models: ['qwen3.5:4b', 'llama3.2:3b', 'mistral', 'gemma2:9b', 'phi3:mini', 'glm-5.1:cloud'] },
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
