import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

/**
 * One long random string on the **server** (you never paste it in the app — it is not a “user JWT”).
 * `SESSION_SECRET` (clear name) or `JWT_SECRET` (legacy) — used for: multi-tenant sessions, contact
 * field encryption, and the public-URL safety check. Same value either way.
 */
const serverSecret = (process.env.SESSION_SECRET || process.env.JWT_SECRET || '').trim();

const onRender =
  process.env.RENDER === 'true'
  || Boolean(String(process.env.RENDER_EXTERNAL_URL || '').trim());

const config = {
  dataDir: resolve(ROOT, process.env.DATA_DIR || './data'),
  mediaDir: resolve(ROOT, process.env.DATA_DIR || './data', 'media'),
  dbPath: resolve(ROOT, process.env.DATA_DIR || './data', 'whatsapp_search.db'),
  /** Render/Heroku set `PORT`; local dev often uses `WEB_PORT`. */
  webPort: parseInt(process.env.PORT || process.env.WEB_PORT || '3000', 10),
  /** Bind all interfaces so PaaS (e.g. Render) can route traffic. Override with `HOST` / `WEB_HOST`. */
  webHost: process.env.HOST || process.env.WEB_HOST || '0.0.0.0',
  publicDir: resolve(ROOT, 'public'),
  /**
   * Gmail API (optional): set in `.env` to enable “Sync from Gmail” for WhatsApp `.txt` / `.zip` exports.
   * Redirect URI in Google Cloud Console must match exactly (e.g. `https://<host>/api/gmail/oauth/callback`).
   */
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  /** If unset, derived at runtime from `RENDER_EXTERNAL_URL` or `http://localhost:<WEB_PORT>`. */
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  /**
   * Optional comma-separated origins allowed for Gmail OAuth when using `?origin=` from the browser
   * (e.g. custom domain). Localhost / 127.0.0.1 always allowed; `RENDER_EXTERNAL_URL` origin always allowed.
   */
  googleOauthPublicOrigins: process.env.GOOGLE_OAUTH_PUBLIC_ORIGINS || '',
  /**
   * Same as env `SESSION_SECRET` or `JWT_SECRET` (either name works).
   * This is a **server** secret, not a token the browser stores.
   */
  serverSecret,
  /** @deprecated use `serverSecret` — same value. */
  jwtSecret: serverSecret,
  /** Legacy default tenant id (used only for non-auth local/dev flows). */
  defaultTenantId: (process.env.DEFAULT_TENANT_ID || 'legacy-default').trim(),
  /**
   * Defaults when settings table has no row yet (first run / new DB).
   * Local desktop: Ollama with llama3.2:3b.
   * Render / cloud: Groq search + Ollama Cloud summaries + Gemini media (keys via env).
   */
  defaultSearchProvider: process.env.LLM_PROVIDER || (onRender ? 'groq' : 'ollama'),
  defaultSearchModel:
    process.env.LLM_MODEL || process.env.GROQ_MODEL || (onRender ? 'llama-3.3-70b-versatile' : 'llama3.2:3b'),
  defaultSummaryProvider: process.env.SUMMARY_PROVIDER || (onRender ? 'ollama_cloud' : 'ollama'),
  defaultSummaryModel: process.env.SUMMARY_MODEL || (onRender ? 'gpt-oss:20b' : 'llama3.2:3b'),
  /**
   * Vision + audio transcription for FTS media indexing (`media_ai_index`).
   * Separate from Search — local Ollama on desktop; Gemini on Render when keys are set.
   */
  defaultMediaIndexProvider: (process.env.MEDIA_INDEX_PROVIDER || (onRender ? 'gemini' : 'ollama')).trim(),
  defaultMediaIndexModel:
    (process.env.MEDIA_INDEX_MODEL || process.env.GEMINI_MODEL || (onRender ? 'gemini-2.5-flash' : 'llama3.2:3b')).trim(),

  /**
   * Baileys linked-device history: default `false` for fewer phone “syncing” alerts on connect.
   * Set `WA_SYNC_FULL_HISTORY=true` if you explicitly want deeper automatic history on first connect.
   */
  waSyncFullHistory: (() => {
    const v = String(process.env.WA_SYNC_FULL_HISTORY ?? '').trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    return false;
  })(),
  /** Rows per SQLite batch during `messaging-history.set` (smaller = less event-loop blocking / fewer disconnects). */
  waHistoryChunkSize: Math.max(50, parseInt(process.env.WA_HISTORY_CHUNK_SIZE || '350', 10) || 350),
  /** Idle ms after the last history batch before marking sync complete (Baileys often pauses 5–30s between batches). */
  waSyncDoneDelayMs: Math.max(3000, parseInt(process.env.WA_SYNC_DONE_DELAY_MS || '15000', 10) || 15000),
  /** Live chats active within this user-selected window form the first post-sync indexing queue. */
  liveRecentWindowDays: 5,
  /**
   * Auto-index only chats above this size whose latest message is inside `indexRecentWindowDays`.
   * Smaller or older chats stay unindexed until they grow, or the user opts them in.
   */
  indexMinMessageCount: 50,
  indexRecentWindowDays: 10,
  /**
   * If true, after each READY we auto-run `resyncAppState` + phone-book refresh (heavy; extra sync traffic/notifications).
   * Default false — use Settings → “Refresh contact names” or `POST /api/wa/sync-contacts` when you want names updated.
   * Set `WA_AUTO_APP_STATE_RESYNC=1` to restore automatic refresh (old behavior).
   */
  waAutoAppStateResync: ['1', 'true', 'yes'].includes(
    String(process.env.WA_AUTO_APP_STATE_RESYNC ?? '').trim().toLowerCase(),
  ),
  /**
   * Import-first MVP: sidebar/search work from SQLite exports without linking WhatsApp.
   * Set `WA_LIVE_SYNC=1` to re-enable live QR sync UI and auto-connect on page load.
   */
  importFirstMvp: !['1', 'true', 'yes'].includes(
    String(process.env.WA_LIVE_SYNC ?? '').trim().toLowerCase(),
  ),
  waLiveSyncAutoConnect: ['1', 'true', 'yes'].includes(
    String(process.env.WA_LIVE_SYNC_AUTO_CONNECT ?? '').trim().toLowerCase(),
  ),
  /** Packaged Mac/Windows desktop app (Electron). */
  isDesktopApp: ['1', 'true', 'yes'].includes(
    String(process.env.DESKTOP_APP ?? '').trim().toLowerCase(),
  ),
  /** GitHub `owner/repo` for desktop release downloads (see /download). */
  githubRepo: (process.env.GITHUB_REPO || 'somitmittal/whatsapp-search').trim(),
  /** WhatsApp export date order for ambiguous DD/MM vs MM/DD: `auto`, `DMY`, or `MDY`. */
  importDateOrder: (process.env.IMPORT_DATE_ORDER || 'auto').trim().toUpperCase(),
};

export default config;
