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
};

export default config;
