import { mkdirSync } from 'fs';
import config from './config.js';
import { runWithTenant, getCurrentTenantId } from './storage/tenant-context.js';
import { LEGACY_TENANT_ID } from './storage/tenant-constants.js';
import Database from './storage/database.js';
import SmartSearch from './search/smart-search.js';
import MediaIndexService from './search/media-index-service.js';
import EmbeddingIndexService from './search/embedding-index-service.js';
import { terminateMiniLmEncoder } from './search/minilm-encoder.js';
import DailySummaryService from './search/daily-summary-service.js';
import WebServer from './web/server.js';
import ActionItemService from './search/action-item-service.js';
import { createProvider } from './llm/provider.js';
import {
  applyLlmDefaultsIfUnset,
  effectiveSearchApiKey,
  effectiveSummaryApiKey,
  effectiveMediaIndexApiKey,
} from './llm/defaults.js';
import { createIndexingSummaryProvider, resolveOllamaIndexingModel } from './search/indexing-profile.js';

function assertJwtOnPublicHost() {
  const onPublic =
    process.env.RENDER === 'true' || Boolean(String(process.env.RENDER_EXTERNAL_URL || '').trim());
  const tok = (config.serverSecret || '').trim();
  if (!onPublic || tok) return;
  console.error(
    '[FATAL] This instance is exposed on the public internet (Render) but no server secret is set.\n' +
      'Add SESSION_SECRET (or JWT_SECRET) as a long random string in Render → Environment, then redeploy.\n' +
      'This is a server key only (not a token for users) — it enables per-browser sessions and data isolation.',
  );
  process.exit(1);
}

async function main() {
  assertJwtOnPublicHost();

  console.log('=================================');
  console.log('  WhatsApp Mirror');
  console.log('  Local AI Search + Chrome Extension');
  console.log('  100% Local Data | Your Choice of AI');
  console.log('=================================\n');

  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.mediaDir, { recursive: true });

  console.log('Initializing database...');
  const db = new Database();
  const defaultTenantId = config.defaultTenantId || LEGACY_TENANT_ID;
  runWithTenant(defaultTenantId, () => applyLlmDefaultsIfUnset(db));

  const { savedProvider, savedKey } = runWithTenant(defaultTenantId, () => ({
    savedProvider: db.getSetting('llm_provider') || config.defaultSearchProvider,
    savedKey: effectiveSearchApiKey(db),
  }));
  let savedModel = runWithTenant(defaultTenantId, () => db.getSetting('llm_model') || config.defaultSearchModel);

  if (savedProvider === 'ollama') {
    const { canSpawnLocalOllama } = await import('./llm/deployment-env.js');
    if (canSpawnLocalOllama()) {
      const { resolveSafeOllamaModel, applyOllamaMemorySettings } = await import('./llm/ollama-recommend.js');
      const safe = resolveSafeOllamaModel(savedModel);
      runWithTenant(defaultTenantId, () => applyOllamaMemorySettings(db, safe));
      if (safe.warning) {
        console.warn(`[Ollama] Startup: ${safe.warning}`);
      }
    } else {
      console.warn('[Ollama] Local Ollama skipped on this host — configure Groq or Ollama Cloud in Settings / env.');
    }
  }

  let provider = null;
  try {
    provider = await createProvider(savedProvider, savedKey, savedModel || undefined);
  } catch (err) {
    console.log('No LLM configured yet. Configure one in Settings at http://localhost:3000');
  }

  /** Searchable descriptions for images / video / audio (FTS) — default Gemini 2.5 Flash when key present. */
  let mediaIndexProvider = provider;

  let summaryProvider = provider;
  const sumProvSetting = runWithTenant(defaultTenantId, () => db.getSetting('summary_provider'));
  if (sumProvSetting && sumProvSetting !== 'same') {
    try {
      const sumKey = runWithTenant(defaultTenantId, () => effectiveSummaryApiKey(db));
      const sumModel = runWithTenant(defaultTenantId, () => db.getSetting('summary_model')) || config.defaultSummaryModel;
      summaryProvider = await createIndexingSummaryProvider(createProvider, sumProvSetting, sumKey, sumModel);
      console.log(`Summary provider: ${sumProvSetting} (${summaryProvider.model})`);
    } catch (err) {
      console.log(`Summary provider "${sumProvSetting}" failed to init, falling back to search provider: ${err.message}`);
      summaryProvider = provider;
    }
  } else if (savedProvider === 'ollama' && savedModel) {
    const indexModel = resolveOllamaIndexingModel(savedModel);
    if (indexModel !== savedModel) {
      try {
        summaryProvider = await createProvider('ollama', '', indexModel);
        console.log(`Summary provider: ollama (${summaryProvider.model}) — search stays on ${savedModel}`);
      } catch (err) {
        console.log(`Indexing model ${indexModel} failed to init: ${err.message}`);
      }
    }
  }

  const isWaLive = () => webServer?.isTenantWaLive?.(getCurrentTenantId()) ?? false;

  const summaryService = new DailySummaryService({
    db,
    provider: summaryProvider,
    fallbackProvider: summaryProvider !== provider ? provider : null,
    onProgress: (data) => {
      if (webServer) webServer.onSummaryProgress(data);
    },
    isWaLive,
    onIdle: () => mediaIndexService.scheduleProcess(),
  });
  const embeddingIndexService = new EmbeddingIndexService({
    db,
    getPriorityChatJid: () => summaryService.getPriorityChatForTenant(getCurrentTenantId()),
    isWaLive,
  });
  const searchEngine = new SmartSearch(db, provider, { embeddingIndex: embeddingIndexService });
  const mediaIndexService = new MediaIndexService({
    db,
    getProvider: () => mediaIndexProvider,
    getPriorityChatJid: () => summaryService.getPriorityChatForTenant(getCurrentTenantId()),
    isWaLive,
    shouldDefer: () => summaryService.isBusy() || !summaryService.hasCaughtUp(),
  });

  async function reloadMediaIndexProvider() {
    const storedMip = runWithTenant(defaultTenantId, () => (db.getSetting('media_index_provider') || '').trim());
    const mip = storedMip === '' ? config.defaultMediaIndexProvider : storedMip;
    const storedMim = runWithTenant(defaultTenantId, () => (db.getSetting('media_index_model') || '').trim());
    const mim = storedMim === '' ? config.defaultMediaIndexModel : storedMim;
    const mik = runWithTenant(defaultTenantId, () => effectiveMediaIndexApiKey(db));
    const searchP = provider;

    if (!searchP) {
      mediaIndexProvider = null;
      mediaIndexService.setProvider(null);
      return { healthy: false, provider: mip, model: '' };
    }

    if (!mik || mip === 'same') {
      mediaIndexProvider = searchP;
      mediaIndexService.setProvider(mediaIndexProvider);
      let healthy = false;
      try {
        healthy = await mediaIndexProvider.checkHealth();
      } catch {}
      console.log(`Media index LLM: same as search (${mediaIndexProvider.model})`);
      return { healthy, provider: 'same', model: mediaIndexProvider.model || '' };
    }

    try {
      mediaIndexProvider = await createProvider(mip, mik, mim || undefined);
      mediaIndexService.setProvider(mediaIndexProvider);
      let healthy = false;
      try {
        healthy = await mediaIndexProvider.checkHealth();
      } catch {}
      console.log(`Media index LLM: ${mip} (${mediaIndexProvider.model})`);
      return { healthy, provider: mip, model: mediaIndexProvider.model || '' };
    } catch (err) {
      console.warn(`Media index LLM (${mip}) failed: ${err.message} — using search LLM`);
      mediaIndexProvider = searchP;
      mediaIndexService.setProvider(mediaIndexProvider);
      let healthy = false;
      try {
        healthy = await mediaIndexProvider.checkHealth();
      } catch {}
      return { healthy, provider: 'same', model: mediaIndexProvider.model || '' };
    }
  }

  await reloadMediaIndexProvider();

  let webServer;
  const actionItemService = new ActionItemService({
    db,
    getProvider: () => provider,
    onSuggestionsUpdated: ({ chatJid }) => {
      webServer?._broadcast?.({ type: 'chat-action-items', data: { chatJid } }, defaultTenantId);
    },
  });
  webServer = new WebServer({
    db,
    searchEngine,
    summaryService,
    mediaIndexService,
    embeddingIndexService,
    actionItemService,
    reloadMediaIndexProvider,
  });

  if (provider) {
    provider.checkHealth().then(healthy => {
      if (healthy) {
        console.log(`Search LLM connected: ${savedProvider} (${provider.model})`);
      } else {
        console.log(`Search LLM configured: ${savedProvider} — but not reachable (configure API key in Settings)`);
      }
    }).catch(err => console.log(`Search LLM health check failed: ${err.message}`));
  }

  const effectiveSumProvider = summaryProvider || provider;
  if (effectiveSumProvider) {
    effectiveSumProvider.checkHealth().then(healthy => {
      if (healthy) {
        const pName = sumProvSetting && sumProvSetting !== 'same' ? sumProvSetting : savedProvider;
        console.log(`Summary LLM connected: ${pName} (${effectiveSumProvider.model})`);
        const stats = runWithTenant(defaultTenantId, () => db.getTotalStats());
        if (stats.totalMessages > 0 && !webServer.isTenantWaHistoryBusy(defaultTenantId)) {
          console.log('Generating daily summaries in background...');
          void runWithTenant(defaultTenantId, async () => {
            try {
              const count = await summaryService.indexPendingDays();
              if (count > 0) console.log(`Generated ${count} daily summaries`);
              else console.log('All summaries up to date');
            } catch (err) {
              console.error('Summary error:', err.message);
            }
          });
        }
      }
    }).catch(err => console.log(`Summary LLM health check failed: ${err.message}`));
  }

  let summaryInterval = setInterval(async () => {
    try {
      if (webServer.isTenantWaHistoryBusy(defaultTenantId)) return;
      await runWithTenant(defaultTenantId, async () => {
        await summaryService.indexPendingDays();
      });
    } catch { /* */ }
  }, 300_000);

  let mediaIndexInterval = setInterval(async () => {
    try {
      if (webServer.isTenantWaHistoryBusy(defaultTenantId)) return;
      await runWithTenant(defaultTenantId, async () => {
        await mediaIndexService.processPending(12);
      });
    } catch { /* */ }
  }, 120_000);

  let embeddingIndexInterval = setInterval(async () => {
    try {
      if (webServer.isTenantWaHistoryBusy(defaultTenantId)) return;
      await runWithTenant(defaultTenantId, async () => {
        await embeddingIndexService.processPending(12);
      });
    } catch { /* */ }
  }, 120_000);

  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(summaryInterval);
    clearInterval(mediaIndexInterval);
    clearInterval(embeddingIndexInterval);
    await webServer.destroyAllWhatsAppClients();
    webServer.stop();
    await terminateMiniLmEncoder();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await webServer.start();

  console.log('Server ready.');
  if (!config.waSyncFullHistory) {
    console.log('[WA] WA_SYNC_FULL_HISTORY disabled — less linked-device sync traffic; less chat history on first connect.');
  }
  if (config.waAutoAppStateResync) {
    console.log('[WA] WA_AUTO_APP_STATE_RESYNC enabled — auto app-state sync after connect (more phone notifications).');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
