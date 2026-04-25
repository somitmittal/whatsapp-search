import { mkdirSync } from 'fs';
import config from './config.js';
import { runWithTenant } from './storage/tenant-context.js';
import { LEGACY_TENANT_ID } from './storage/tenant-constants.js';
import Database from './storage/database.js';
import SmartSearch from './search/smart-search.js';
import MediaIndexService from './search/media-index-service.js';
import DailySummaryService from './search/daily-summary-service.js';
import WebServer from './web/server.js';
import ActionItemService from './search/action-item-service.js';
import { createProvider } from './llm/provider.js';
import {
  applyLlmDefaultsIfUnset,
  effectiveSearchApiKey,
  effectiveSummaryApiKey,
} from './llm/defaults.js';

function assertJwtOnPublicHost() {
  const onPublic =
    process.env.RENDER === 'true' || Boolean(String(process.env.RENDER_EXTERNAL_URL || '').trim());
  const tok = (process.env.JWT_SECRET || config.jwtSecret || '').trim();
  if (!onPublic || tok) return;
  console.error(
    '[FATAL] This instance is exposed on the public internet (Render) but JWT_SECRET is not set.\n' +
      'Multi-tenant login is required on public deployments so each user only sees their own data.\n' +
      'In Render → Environment, add JWT_SECRET (long random string), redeploy, then users can Register/Login on the same URL.',
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

  const { savedProvider, savedKey, savedModel } = runWithTenant(defaultTenantId, () => ({
    savedProvider: db.getSetting('llm_provider') || config.defaultSearchProvider,
    savedKey: effectiveSearchApiKey(db),
    savedModel: db.getSetting('llm_model') || config.defaultSearchModel,
  }));

  let provider = null;
  try {
    provider = await createProvider(savedProvider, savedKey, savedModel || undefined);
  } catch (err) {
    console.log('No LLM configured yet. Configure one in Settings at http://localhost:3000');
  }

  let summaryProvider = provider;
  const sumProvSetting = runWithTenant(defaultTenantId, () => db.getSetting('summary_provider'));
  if (sumProvSetting && sumProvSetting !== 'same') {
    try {
      const sumKey = runWithTenant(defaultTenantId, () => effectiveSummaryApiKey(db));
      const sumModel = runWithTenant(defaultTenantId, () => db.getSetting('summary_model')) || config.defaultSummaryModel;
      summaryProvider = await createProvider(sumProvSetting, sumKey, sumModel || undefined);
      console.log(`Summary provider: ${sumProvSetting} (${summaryProvider.model})`);
    } catch (err) {
      console.log(`Summary provider "${sumProvSetting}" failed to init, falling back to search provider: ${err.message}`);
      summaryProvider = provider;
    }
  }

  const searchEngine = new SmartSearch(db, provider);
  const mediaIndexService = new MediaIndexService({
    db,
    getProvider: () => provider,
  });
  let webServer;
  const actionItemService = new ActionItemService({
    db,
    getProvider: () => provider,
    onSuggestionsUpdated: ({ chatJid }) => {
      webServer?._broadcast?.({ type: 'chat-action-items', data: { chatJid } }, defaultTenantId);
    },
  });
  const summaryService = new DailySummaryService({
    db,
    provider: summaryProvider,
    fallbackProvider: summaryProvider !== provider ? provider : null,
    onProgress: (data) => {
      if (webServer) webServer.onSummaryProgress(data);
    },
  });
  webServer = new WebServer({ db, searchEngine, summaryService, mediaIndexService, actionItemService });

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
        if (stats.totalMessages > 0) {
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
      await runWithTenant(defaultTenantId, async () => {
        await summaryService.indexPendingDays();
      });
    } catch { /* */ }
  }, 300_000);

  let mediaIndexInterval = setInterval(async () => {
    try {
      await runWithTenant(defaultTenantId, async () => {
        await mediaIndexService.processPending(12);
      });
    } catch { /* */ }
  }, 120_000);

  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(summaryInterval);
    clearInterval(mediaIndexInterval);
    await waClient.destroy();
    webServer.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await webServer.start();

  console.log('Server ready.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
