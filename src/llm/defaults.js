/**
 * Server-side default models and env-backed API keys (e.g. Render secrets).
 * User keys stored in SQLite override environment when non-empty.
 */

import config from '../config.js';

export function applyLlmDefaultsIfUnset(db) {
  if (!db.getSetting('llm_provider')) {
    db.setSetting('llm_provider', config.defaultSearchProvider);
  }
  if (!db.getSetting('llm_model')) {
    db.setSetting('llm_model', config.defaultSearchModel);
  }
  if (!db.getSetting('summary_provider')) {
    db.setSetting('summary_provider', config.defaultSummaryProvider);
  }
  if (!db.getSetting('summary_model')) {
    db.setSetting('summary_model', config.defaultSummaryModel);
  }
}

/** DB `llm_api_key` wins; else `GROQ_API_KEY` or `LLM_API_KEY`. */
export function effectiveSearchApiKey(db) {
  const user = (db.getSetting('llm_api_key') || '').trim();
  if (user) return user;
  return (process.env.GROQ_API_KEY || process.env.LLM_API_KEY || '').trim();
}

/** DB `summary_api_key` wins; else `OLLAMA_CLOUD_API_KEY` or `SUMMARY_API_KEY`. */
export function effectiveSummaryApiKey(db) {
  const user = (db.getSetting('summary_api_key') || '').trim();
  if (user) return user;
  return (process.env.OLLAMA_CLOUD_API_KEY || process.env.SUMMARY_API_KEY || '').trim();
}

/**
 * Collect Gemini API keys from env for rotation (comma/newline lists + extra vars).
 * Supported:
 * - `GEMINI_API_KEY` — one or more keys separated by comma or newline
 * - `GEMINI_API_KEYS` — extra keys (merged, deduped)
 * - `MEDIA_INDEX_API_KEY`, `MEDIA_INDEX_API_KEYS`
 * - `GEMINI_API_KEY_1` … `GEMINI_API_KEY_24` — one key per var (Render-friendly)
 * @returns {string} comma-separated keys for `GeminiProvider` (see `gemini.js` `parseKeys`)
 */
export function geminiKeysFromEnv() {
  const chunks = [];
  const push = (raw) => {
    if (raw == null || raw === '') return;
    const s = String(raw).trim();
    if (!s) return;
    for (const part of s.split(/[\n,]+/)) {
      const k = part.trim();
      if (k) chunks.push(k);
    }
  };
  push(process.env.GEMINI_API_KEY);
  push(process.env.GEMINI_API_KEYS);
  push(process.env.MEDIA_INDEX_API_KEY);
  push(process.env.MEDIA_INDEX_API_KEYS);
  for (let i = 1; i <= 24; i += 1) {
    push(process.env[`GEMINI_API_KEY_${i}`]);
  }
  return [...new Set(chunks)].join(',');
}

/** DB `media_index_api_key` wins; else merged Gemini keys from env (media FTS indexing). */
export function effectiveMediaIndexApiKey(db) {
  const user = (db.getSetting('media_index_api_key') || '').trim();
  if (user) return user;
  return geminiKeysFromEnv();
}

/** For Settings UI: whether keys come from DB vs server env vs neither. */
export function keyHints(db) {
  const hasStoredSearch = !!(db.getSetting('llm_api_key') || '').trim();
  const hasStoredSummary = !!(db.getSetting('summary_api_key') || '').trim();
  const hasStoredMediaIndex = !!(db.getSetting('media_index_api_key') || '').trim();
  const hasEnvSearch = !!(process.env.GROQ_API_KEY || process.env.LLM_API_KEY || '').trim();
  const hasEnvSummary = !!(process.env.OLLAMA_CLOUD_API_KEY || process.env.SUMMARY_API_KEY || '').trim();
  const hasEnvMediaIndex = !!geminiKeysFromEnv().trim();
  return {
    search: hasStoredSearch ? 'user' : (hasEnvSearch ? 'env' : 'none'),
    summary: hasStoredSummary ? 'user' : (hasEnvSummary ? 'env' : 'none'),
    mediaIndex: hasStoredMediaIndex ? 'user' : (hasEnvMediaIndex ? 'env' : 'none'),
  };
}

/** Mask a secret for JSON responses — never send raw API keys to the browser. */
export function maskApiKeyForDisplay(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * Settings blob safe for GET /api/settings: masks stored keys and adds hasLlmApiKey / hasSummaryApiKey.
 */
export function publicSettingsFromDb(db) {
  const settings = db.getAllSettings();
  const llmRaw = (settings.llm_api_key || '').trim();
  const sumRaw = (settings.summary_api_key || '').trim();
  const mediaRaw = (settings.media_index_api_key || '').trim();
  return {
    ...settings,
    llm_api_key: llmRaw ? maskApiKeyForDisplay(llmRaw) : '',
    summary_api_key: sumRaw ? maskApiKeyForDisplay(sumRaw) : '',
    media_index_api_key: mediaRaw ? maskApiKeyForDisplay(mediaRaw) : '',
    hasLlmApiKey: !!llmRaw,
    hasSummaryApiKey: !!sumRaw,
    hasMediaIndexApiKey: !!mediaRaw,
  };
}
