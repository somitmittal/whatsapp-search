/**
 * Curated chat/search model IDs per provider (Oct 2026).
 * Keep text-capable models in Settings; specialized audio/image/video IDs stay out unless useful for media index.
 */

export const PROVIDER_MODELS = {
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
    'thinkingmachines/inkling:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'thinkingmachines/inkling-small:free',
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
};

/** Gemini generateContent fallbacks when the selected model is unavailable. */
export const GEMINI_FALLBACK_CHAIN = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];
