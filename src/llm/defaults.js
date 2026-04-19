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

/** For Settings UI: whether keys come from DB vs server env vs neither. */
export function keyHints(db) {
  const hasStoredSearch = !!(db.getSetting('llm_api_key') || '').trim();
  const hasStoredSummary = !!(db.getSetting('summary_api_key') || '').trim();
  const hasEnvSearch = !!(process.env.GROQ_API_KEY || process.env.LLM_API_KEY || '').trim();
  const hasEnvSummary = !!(process.env.OLLAMA_CLOUD_API_KEY || process.env.SUMMARY_API_KEY || '').trim();
  return {
    search: hasStoredSearch ? 'user' : (hasEnvSearch ? 'env' : 'none'),
    summary: hasStoredSummary ? 'user' : (hasEnvSummary ? 'env' : 'none'),
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
  return {
    ...settings,
    llm_api_key: llmRaw ? maskApiKeyForDisplay(llmRaw) : '',
    summary_api_key: sumRaw ? maskApiKeyForDisplay(sumRaw) : '',
    hasLlmApiKey: !!llmRaw,
    hasSummaryApiKey: !!sumRaw,
  };
}
