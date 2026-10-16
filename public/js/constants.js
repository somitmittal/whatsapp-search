/** Smaller pages when loading *older* history (after the first full window). */
export const CHAT_PAGE = 80;

/** First open: load enough for a usable view; scroll-up loads older pages. */
export const INITIAL_CHAT_MESSAGES_LIMIT = 500;

export const SEARCH_INPUT_PLACEHOLDER_DEFAULT = 'Ask AI anything about your chats...';

export const SMB_PLACEHOLDERS = {
  clinic: 'Ask about appointments, follow-ups, prescriptions…',
  real_estate: 'Ask about site visits, leads, deals…',
  d2c: 'Ask about orders, delivery, refunds…',
  construction: 'Compare today’s chat expenses with the end-of-day Excel sheet…',
};

/**
 * Fallback model lists (kept in sync with src/llm/provider-models.js + ollama-model-lists.js).
 * Hydrated from GET /api/settings `providers` when available.
 */
export const MODELS = {
  gemini: [
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
  openai: [
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
  ],
  claude: [
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'moonshotai/kimi-k2-instruct-0905',
  ],
  grok: [
    'grok-4.7',
    'grok-4.7-latest',
    'grok-4.6',
    'grok-4.5',
    'grok-4.3',
    'latest',
  ],
  openrouter: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'nvidia/nemotron-3.5-lightning:free',
    'dots-studio/dots-3-note-preview:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'liquid/lfm-2.5-2.6b:free',
  ],
  munito: [
    'qwen/qwen3.8-27b',
    'qwen/qwen3-32b',
    'mistralai/mistral-small-3.2-24b-instruct',
    'google/gemma-3-27b-it',
    'meta-llama/llama-3.3-70b-instruct',
    'deepseek/deepseek-r1',
    'openai/gpt-oss-120b',
  ],
  ollama: [
    'llama3.2:3b',
    'llama3.2:1b',
    'qwen3.5:4b',
    'mistral',
    'gemma2:9b',
    'phi3:mini',
    'llama3.1:8b',
    'llama3.3:70b',
    'qwen3:8b',
    'qwen2.5:7b',
    'gemma3:4b',
    'gemma3:12b',
    'phi4',
    'deepseek-r1:7b',
    'deepseek-r1:latest',
    'mistral-small3.2:24b',
    'glm-5.1:cloud',
    'deepseek-v3.1:671b-cloud',
    'kimi-k2:1t-cloud',
  ],
  ollama_cloud: [
    'llama3.2:3b',
    'llama3.2:1b',
    'qwen3.5:4b',
    'mistral',
    'gemma2:9b',
    'phi3:mini',
    'llama3.1:8b',
    'llama3.3:70b',
    'qwen3:8b',
    'qwen2.5:7b',
    'gemma3:4b',
    'gemma3:12b',
    'phi4',
    'deepseek-r1:7b',
    'deepseek-r1:latest',
    'mistral-small3.2:24b',
    'glm-5.1:cloud',
    'gpt-oss:20b',
    'gpt-oss:120b',
    'kimi-k2:1t-cloud',
  ],
};

export const HINTS = {
  groq: 'On Render, set <code>GROQ_API_KEY</code> as a secret, or get a free key from <a href="https://console.groq.com/keys" target="_blank">console.groq.com</a>. Fast open models (Llama, GPT-OSS, Qwen). <strong>Multiple keys (comma-separated)</strong> rotate automatically.',
  ollama: 'Runs locally — <strong>no API key, no cloud</strong>. Models are <strong>not</strong> downloaded until you confirm. We recommend a model from your RAM/CPU in Settings. Install <a href="https://ollama.com/download" target="_blank">Ollama</a> if needed — you can cancel an in-progress download anytime.',
  munito: '<strong>EU open-model API</strong> — inference in Europe by default. <strong>Does not store your prompts in the cloud</strong> (zero retention for normal requests; not used for training). Key from <a href="https://munito.ai/" target="_blank" rel="noopener">munito.ai</a>. Env: <code>MUNITO_API_KEY</code>. Optional: <code>MUNITO_BASE_URL</code> (default EU).',
  ollama_cloud: 'API key from <a href="https://ollama.com" target="_blank">ollama.com</a>. The <strong>first five</strong> tags are the same as local Ollama; then cloud extras including <code>glm-5.1:cloud</code>. Same <code>/api/chat</code> as local. Optional: <code>OLLAMA_CLOUD_URL</code>.',
  openrouter: 'Key from <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>. Models ending in <code>:free</code> are free tier. Any OpenRouter model id works.',
  gemini: 'Free key from <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a>. Prefers Gemini 4 / 3.8 Flash; older 2.5 IDs remain for existing projects. <strong>Multiple keys separated by commas</strong> rotate automatically.',
  openai: 'Key from <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>. GPT-6 Astra / Sol / Luna are current flagship chat models.',
  claude: 'Key from <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>. Claude 5.5 (Opus / Sonnet / Haiku) and Fable 5.1 are current.',
  grok: 'Key from <a href="https://console.x.ai/" target="_blank">console.x.ai</a>. Grok 4.7 is the current flagship; <code>latest</code> tracks xAI’s newest stable alias.',
};

export function initConstants() {
  fetch('/api/settings').then(r => r.json()).then(({ providers }) => {
    if (!providers || typeof providers !== 'object') return;
    for (const [id, meta] of Object.entries(providers)) {
      if (Array.isArray(meta?.models) && meta.models.length) {
        MODELS[id] = meta.models;
      }
    }
  }).catch(() => {});
}
