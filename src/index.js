import { mkdirSync } from 'fs';
import config from './config.js';
import Database from './storage/database.js';
import SmartSearch from './search/smart-search.js';
import DailySummaryService from './search/daily-summary-service.js';
import WebServer from './web/server.js';
import WaClient from './whatsapp/wa-client.js';
import { createProvider } from './llm/provider.js';

async function main() {
  console.log('=================================');
  console.log('  WhatsApp Mirror');
  console.log('  Local AI Search + Chrome Extension');
  console.log('  100% Local Data | Your Choice of AI');
  console.log('=================================\n');

  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.mediaDir, { recursive: true });

  console.log('Initializing database...');
  const db = new Database();

  const savedProvider = db.getSetting('llm_provider') || 'gemini';
  const savedKey = db.getSetting('llm_api_key') || '';
  const savedModel = db.getSetting('llm_model') || '';

  let provider = null;
  try {
    provider = await createProvider(savedProvider, savedKey, savedModel || undefined);
  } catch (err) {
    console.log('No LLM configured yet. Configure one in Settings at http://localhost:3000');
  }

  let summaryProvider = provider;
  const sumProvSetting = db.getSetting('summary_provider');
  if (sumProvSetting && sumProvSetting !== 'same') {
    try {
      const sumKey = db.getSetting('summary_api_key') || '';
      const sumModel = db.getSetting('summary_model') || '';
      summaryProvider = await createProvider(sumProvSetting, sumKey, sumModel || undefined);
      console.log(`Summary provider: ${sumProvSetting} (${summaryProvider.model})`);
    } catch (err) {
      console.log(`Summary provider "${sumProvSetting}" failed to init, falling back to search provider: ${err.message}`);
      summaryProvider = provider;
    }
  }

  const searchEngine = new SmartSearch(db, provider);
  const summaryService = new DailySummaryService({
    db,
    provider: summaryProvider,
    fallbackProvider: summaryProvider !== provider ? provider : null,
  });
  const webServer = new WebServer({ db, searchEngine, summaryService });

  // ── WhatsApp Linked-Device client ───────────────────────────────
  const waClient = new WaClient({
    onQr:      (dataUrl) => webServer.onWaQr(dataUrl),
    onReady:   (info)    => console.log(`[WA] Logged in as ${info.name || info.phone}`),
    onMessages:(rows)    => webServer.onWaMessages(rows),
    onStatus:  (s)       => webServer.onWaStatus(s),
    onProgress:(p)       => webServer.onWaProgress(p),
    onSearchQuery: async (query) => {
      try {
        return await searchEngine.search(query, null);
      } catch (e) {
        return { error: e.message };
      }
    },
    onDisconnected: () => console.log('[WA] Connection closed'),
  });
  webServer.setWaClient(waClient);

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
        const stats = db.getTotalStats();
        if (stats.totalMessages > 0) {
          console.log('Generating daily summaries in background...');
          summaryService.indexPendingDays().then(count => {
            if (count > 0) console.log(`Generated ${count} daily summaries`);
            else console.log('All summaries up to date');
          }).catch(err => console.error('Summary error:', err.message));
        }
      }
    }).catch(err => console.log(`Summary LLM health check failed: ${err.message}`));
  }

  let summaryInterval = setInterval(async () => {
    try { await summaryService.indexPendingDays(); } catch {}
  }, 300_000);

  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(summaryInterval);
    await waClient.destroy();
    webServer.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await webServer.start();

  console.log('Starting WhatsApp client...');
  console.log('Scan the QR code at http://localhost:3000 to link your device\n');

  // Start the WA client after the HTTP server is up so the QR can be served immediately
  waClient.start().catch(err => console.error('[WA] Fatal start error:', err.message));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
