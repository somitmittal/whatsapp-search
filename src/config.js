import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
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
   * When set, all `/api/*` routes (except health + Gmail OAuth callback) and WebSockets require
   * `Authorization: Bearer <WEB_ACCESS_TOKEN>` or `?access_token=` on the WebSocket URL.
   * Required for any public URL (e.g. Render) so strangers cannot read your DB or scan the WhatsApp QR.
   */
  webAccessToken: process.env.WEB_ACCESS_TOKEN || '',
  /** Required for multi-tenant user accounts (`/api/auth/*`). If unset, app uses single `legacy-default` tenant (no login). */
  jwtSecret: process.env.JWT_SECRET || '',
  /** WhatsApp ingest + background jobs scope to this tenant when JWT auth is off (default `legacy-default`). */
  defaultTenantId: (process.env.DEFAULT_TENANT_ID || 'legacy-default').trim(),
  /**
   * Defaults when settings table has no row yet (first run / new DB).
   * Search: Groq. Summary: Ollama Cloud (gpt-oss:20b on free tier when available).
   * On Render, set `GROQ_API_KEY` and `OLLAMA_CLOUD_API_KEY` as secrets; users can paste their own keys in Settings to override.
   */
  defaultSearchProvider: 'groq',
  defaultSearchModel:
    process.env.LLM_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  defaultSummaryProvider: 'ollama_cloud',
  defaultSummaryModel: process.env.SUMMARY_MODEL || 'gpt-oss:20b',
};

export default config;
