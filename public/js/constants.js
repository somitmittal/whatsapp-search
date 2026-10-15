/** Smaller pages when loading *older* history (after the first full window). */
export const CHAT_PAGE = 80;

/** First open: load enough for a usable view; scroll-up loads older pages. */
export const INITIAL_CHAT_MESSAGES_LIMIT = 500;

export const SEARCH_INPUT_PLACEHOLDER_DEFAULT = 'Ask AI anything about your chats...';

export const SMB_PLACEHOLDERS = {
  clinic: 'Ask about appointments, follow-ups, prescriptions…',
  real_estate: 'Ask about site visits, leads, deals…',
  d2c: 'Ask about orders, delivery, refunds…',
  construction: 'Ask about site expenses, labour, fuel, discrepancies…',
};

// Ollama local vs cloud: same first 5 tags (see src/llm/ollama-model-lists.js). Hydrated from /api/settings when possible.
export const MODELS = {
  groq: ['llama-3.3-70b-versatile','llama-3.1-8b-instant','meta-llama/llama-4-scout-17b-16e-instruct','qwen/qwen3-32b'],
  ollama: ['llama3.2:3b','llama3.2:1b','qwen3.5:4b','mistral','gemma2:9b','phi3:mini','glm-5.1:cloud','deepseek-v3.1:671b-cloud','kimi-k2:1t-cloud'],
  ollama_cloud: ['llama3.2:3b','qwen3.5:4b','mistral','gemma2:9b','phi3:mini','glm-5.1:cloud','qwen3:8b','mistral-small3.2:24b','deepseek-r1:7b','deepseek-r1:latest','gemma3:4b','gpt-oss:20b','gpt-oss:120b'],
  munito: ['qwen/qwen3.8-27b','qwen/qwen3-32b','mistralai/mistral-small-3.2-24b-instruct','google/gemma-3-27b-it','meta-llama/llama-3.3-70b-instruct'],
  openrouter: ['google/gemma-2-9b-it:free','meta-llama/llama-3.2-3b-instruct:free','mistralai/mistral-7b-instruct:free','qwen/qwen-2.5-7b-instruct:free','meta-llama/llama-3.2-1b-instruct:free'],
  gemini: ['gemini-2.5-flash','gemini-2.0-flash','gemini-2.0-flash-lite'],
  openai: ['gpt-4o-mini','gpt-4o','gpt-4.1-mini','gpt-4.1-nano'],
  claude: ['claude-sonnet-4-20250514','claude-haiku-4-20250414'],
  grok: ['grok-2-latest','grok-2-mini'],
};

export const HINTS = {
  groq: 'On Render, set <code>GROQ_API_KEY</code> as a secret, or get a free key from <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>. Llama 70B at high speed. <strong>Multiple keys (comma-separated)</strong> rotate automatically.',
  ollama: 'Runs locally — <strong>no API key, no cloud</strong>. Models are <strong>not</strong> downloaded until you confirm. We recommend a model from your RAM/CPU in Settings. Install <a href="https://ollama.com/download" target="_blank">Ollama</a> if needed — you can cancel an in-progress download anytime.',
  munito: '<strong>EU open-model API</strong> — inference in Europe by default. <strong>Does not store your prompts in the cloud</strong> (zero retention for normal requests; not used for training). Key from <a href="https://munito.ai/" target="_blank" rel="noopener">munito.ai</a>. Env: <code>MUNITO_API_KEY</code>. Optional: <code>MUNITO_BASE_URL</code> (default EU).',
  ollama_cloud: 'API key from <a href="https://ollama.com" target="_blank">ollama.com</a>. The <strong>first five</strong> tags are the same as local Ollama; then cloud extras including <code>glm-5.1:cloud</code>. Same <code>/api/chat</code> as local. Optional: <code>OLLAMA_CLOUD_URL</code>.',
  openrouter: 'Key from <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>. Models ending in <code>:free</code> are free tier. Any OpenRouter model id works.',
  gemini: 'Free key from <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>. <strong>Paste multiple keys separated by commas</strong> — they will be rotated on each call to avoid rate limits.',
  openai: 'Key from <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>.',
  claude: 'Key from <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>.',
  grok: 'Free tier ($25/mo credits) from <a href="https://console.x.ai/" target="_blank">console.x.ai</a>. Uses grok-2 family.',
};

export function initConstants() {
  fetch('/api/settings').then(r => r.json()).then(({ providers }) => {
    if (providers?.ollama?.models?.length) MODELS.ollama = providers.ollama.models;
    if (providers?.ollama_cloud?.models?.length) MODELS.ollama_cloud = providers.ollama_cloud.models;
    if (providers?.munito?.models?.length) MODELS.munito = providers.munito.models;
  }).catch(() => {});
}
