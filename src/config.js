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
   * Search: Groq. Summary: Ollama Cloud (gpt-oss:20b on free tier when available).
   * On Render, set `GROQ_API_KEY` and `OLLAMA_CLOUD_API_KEY` as secrets; users can paste their own keys in Settings to override.
   */
  defaultSearchProvider: 'groq',
  defaultSearchModel:
    process.env.LLM_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  defaultSummaryProvider: 'ollama_cloud',
  defaultSummaryModel: process.env.SUMMARY_MODEL || 'gpt-oss:20b',
  /**
   * Vision + audio transcription for FTS media indexing (`media_ai_index`).
   * Separate from Search — uses Gemini by default when any Gemini env key is set (see `geminiKeysFromEnv` in defaults.js) or DB `media_index_api_key`.
   */
  defaultMediaIndexProvider: (process.env.MEDIA_INDEX_PROVIDER || 'gemini').trim(),
  defaultMediaIndexModel:
    (process.env.MEDIA_INDEX_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
};

export default config;
