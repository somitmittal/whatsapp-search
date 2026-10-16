import { PROVIDER_META, createProvider } from '../llm/provider.js';
import { effectiveSearchApiKey, effectiveSummaryApiKey } from '../llm/defaults.js';
import { canSpawnLocalOllama } from '../llm/deployment-env.js';
import { listLocalOllamaModels } from '../llm/ollama-recommend.js';
import { fetchOllamaCloudModelNames } from '../llm/ollama-cloud.js';
import config from '../config.js';

/** Per-provider keys entered from the GPT model picker (JSON map in tenant settings). */
const KEYS_SETTING = 'gpt_provider_keys';

/** Conventional env names so a server operator can pre-provision keys for the picker. */
const ENV_KEYS = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  munito: ['MUNITO_API_KEY'],
  ollama_cloud: ['OLLAMA_CLOUD_API_KEY'],
};

/** Picker order: cheapest-to-try first, then paid frontier providers, then local. */
const ORDER = ['gemini', 'groq', 'openrouter', 'openai', 'claude', 'grok', 'munito', 'ollama_cloud', 'ollama'];

function readKeyMap(db) {
  try {
    const raw = db.getSetting(KEYS_SETTING);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function setProviderKey(db, provider, apiKey) {
  if (!PROVIDER_META[provider]) throw new Error(`Unknown provider: ${provider}`);
  const map = readKeyMap(db);
  const key = String(apiKey || '').trim();
  if (key) map[provider] = key;
  else delete map[provider];
  db.setSetting(KEYS_SETTING, JSON.stringify(map));
}

/** Picker key → existing search/summary key when it is for the same provider → env. */
export function resolveProviderKey(db, provider) {
  const own = readKeyMap(db)[provider];
  if (own) return own;
  if (provider === (db.getSetting('llm_provider') || config.defaultSearchProvider)) {
    const k = effectiveSearchApiKey(db);
    if (k) return k;
  }
  if (provider === db.getSetting('summary_provider')) {
    const k = effectiveSummaryApiKey(db);
    if (k) return k;
  }
  for (const name of ENV_KEYS[provider] || []) {
    const v = String(process.env[name] || '').trim();
    if (v) return v;
  }
  return '';
}

export function defaultSelection(db) {
  return {
    provider: db.getSetting('llm_provider') || config.defaultSearchProvider,
    model: db.getSetting('llm_model') || config.defaultSearchModel,
  };
}

function keySource(db, provider) {
  if (readKeyMap(db)[provider]) return 'picker';
  if (provider === (db.getSetting('llm_provider') || config.defaultSearchProvider) && effectiveSearchApiKey(db)) return 'settings';
  if (provider === db.getSetting('summary_provider') && effectiveSummaryApiKey(db)) return 'settings';
  if ((ENV_KEYS[provider] || []).some((n) => String(process.env[n] || '').trim())) return 'env';
  return null;
}

/**
 * Everything the picker needs: providers in display order, whether each is usable,
 * its models (live lists for Ollama local/cloud when reachable), and the current default.
 */
export async function listModelCatalog(db) {
  const providers = await Promise.all(ORDER.filter((id) => PROVIDER_META[id]).map(async (id) => {
    const meta = PROVIDER_META[id];
    let models = [...(meta.models || [])];
    let configured = false;
    let source = null;
    if (id === 'ollama') {
      configured = canSpawnLocalOllama();
      if (configured) {
        const local = await listLocalOllamaModels();
        if (local.length) models = [...new Set([...local, ...models])];
        source = 'local';
      }
    } else {
      source = keySource(db, id);
      configured = !!source;
      if (id === 'ollama_cloud' && configured) {
        const remote = await fetchOllamaCloudModelNames(resolveProviderKey(db, id)).catch(() => []);
        if (remote.length) models = [...new Set([...remote, ...models])];
      }
    }
    return {
      id,
      name: meta.name,
      free: !!meta.free,
      keyRequired: !!meta.keyRequired,
      privacyNote: meta.privacyNote || null,
      configured,
      keySource: source,
      models,
    };
  }));
  return { default: defaultSelection(db), providers };
}

/**
 * Provider instance for a picker selection. Falls back to the app default when the
 * selection is missing or its provider has no key.
 */
export async function providerForSelection(db, selection, fallback) {
  const provider = String(selection?.provider || '').trim();
  const model = String(selection?.model || '').trim();
  if (!provider || !model || !PROVIDER_META[provider]) return { provider: fallback, selection: null };
  if (provider === 'ollama') {
    return { provider: await createProvider('ollama', '', model), selection: { provider, model } };
  }
  const key = resolveProviderKey(db, provider);
  if (!key) throw new Error(`${PROVIDER_META[provider].name} has no API key yet — add one from the model picker.`);
  return { provider: await createProvider(provider, key, model), selection: { provider, model } };
}
