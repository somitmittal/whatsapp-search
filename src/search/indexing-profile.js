import config from '../config.js';
import { MODEL_TIERS, numCtxForBudget } from '../llm/ollama-recommend.js';
import { OLLAMA_DEFAULT_KEEP_ALIVE_SEC, OLLAMA_DEFAULT_NUM_CTX } from '../llm/ollama.js';

/** Same ≤4B heuristic DailySummaryService already uses for local concurrency. */
export function isSmallLocalModel(modelName) {
  if (!modelName) return false;
  const m = String(modelName).toLowerCase();
  const sizeMatch = m.match(/(\d+(?:\.\d+)?)\s*b/);
  if (sizeMatch) {
    const params = parseFloat(sizeMatch[1]);
    if (params <= 4) return true;
  }
  if (m.includes(':1b') || m.includes(':3b') || m.includes(':1.5b') || m.includes(':2b')) return true;
  return false;
}

function recommendedLocalIndexModel() {
  return MODEL_TIERS.find((t) => t.model === 'llama3.2:3b')?.model || config.defaultSummaryModel;
}

/**
 * Local Ollama indexing uses a small model. Search can keep a larger one.
 * `llama3.2:3b` is the existing desktop default summary/search model.
 */
export function resolveOllamaIndexingModel(configuredModel) {
  if (isSmallLocalModel(configuredModel)) return configuredModel;
  return recommendedLocalIndexModel();
}

/** Cap at the 4GB-tier context from `numCtxForBudget`; never raise above OLLAMA_NUM_CTX. */
export function localSummaryNumCtx() {
  const envCtx = Number(process.env.OLLAMA_NUM_CTX);
  const configured = envCtx > 0 ? envCtx : OLLAMA_DEFAULT_NUM_CTX;
  return Math.min(configured, numCtxForBudget(4));
}

export function localSummaryLlmExtras() {
  return {
    numCtx: localSummaryNumCtx(),
    keepAlive: OLLAMA_DEFAULT_KEEP_ALIVE_SEC,
  };
}

export async function createIndexingSummaryProvider(createProviderFn, providerName, apiKey, configuredModel) {
  let model = configuredModel;
  if (providerName === 'ollama') {
    const next = resolveOllamaIndexingModel(configuredModel);
    if (next && next !== configuredModel) {
      console.log(`[Summaries] Indexing with ${next} (search/summary setting ${configuredModel} is larger than 4B)`);
      model = next;
    }
  }
  return createProviderFn(providerName, apiKey, model || undefined);
}
