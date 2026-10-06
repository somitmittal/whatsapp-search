/**
 * HTTP / CORS / origin policy for the local desktop + optional public (Render) deploy.
 *
 * The UI used to send `Access-Control-Allow-Origin: *` while the API returned private
 * chats without a same-origin check. Any website could `fetch('http://127.0.0.1:…/api/chats')`
 * and read WhatsApp data while Searchable was running.
 */

const OPEN_API_PATHS = new Set([
  '/health',
  '/api/health',
  '/api/waba/webhook',
  '/api/gmail/oauth/callback',
]);

export function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0:0:0:0:0:0:0:1';
}

export function parseOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * @param {string | undefined | null} origin
 * @param {{
 *   isPublicInternet?: boolean,
 *   renderOrigin?: string | null,
 *   extraOrigins?: string[],
 *   path?: string,
 * }} opts
 */
export function isTrustedBrowserOrigin(origin, opts = {}) {
  if (!origin) return true;
  const u = parseOrigin(origin);
  if (!u) return false;

  if (u.protocol === 'chrome-extension:' || u.protocol === 'moz-extension:') {
    return !opts.isPublicInternet;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;

  if (isLoopbackHostname(u.hostname)) {
    return !opts.isPublicInternet;
  }

  const path = String(opts.path || '');
  if (
    !opts.isPublicInternet
    && u.protocol === 'https:'
    && u.hostname === 'web.whatsapp.com'
    && path.startsWith('/api/extension/')
  ) {
    return true;
  }

  const render = opts.renderOrigin ? parseOrigin(opts.renderOrigin) : null;
  if (render && u.origin === render.origin) return true;

  for (const extra of opts.extraOrigins || []) {
    const e = parseOrigin(extra.includes('://') ? extra : `https://${extra}`);
    if (e && u.origin === e.origin) return true;
  }
  return false;
}

export function extraAllowedOriginsFromEnv() {
  const raw = process.env.ALLOWED_ORIGINS || process.env.GOOGLE_OAUTH_PUBLIC_ORIGINS || '';
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function renderPublicOrigin() {
  const render = String(process.env.RENDER_EXTERNAL_URL || '').trim();
  if (!render) return null;
  try {
    return new URL(render).origin;
  } catch {
    return null;
  }
}

export function pathAllowsUnauthenticatedCrossOrigin(pathname) {
  const p = String(pathname || '').split('?')[0];
  return OPEN_API_PATHS.has(p);
}

export function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
  ].join('; ');
}

export function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.path === '/' || req.path.endsWith('.html') || !req.path.includes('.')) {
    res.setHeader('Content-Security-Policy', contentSecurityPolicy());
  }
}

/**
 * Reflect CORS only for trusted origins. Never `*`.
 */
export function applyTrustedCors(req, res, opts) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!isTrustedBrowserOrigin(origin, opts)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cookie');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

export function rejectUntrustedOrigin(req, res, opts) {
  if (pathAllowsUnauthenticatedCrossOrigin(req.path)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  if (isTrustedBrowserOrigin(origin, opts)) return false;
  res.status(403).json({ error: 'Origin not allowed' });
  return true;
}

export function isSafeExternalUrl(url, { loopbackPort } = {}) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:' && isLoopbackHostname(u.hostname)) {
    if (loopbackPort != null && Number(u.port || 80) !== Number(loopbackPort)) return false;
    return true;
  }
  return false;
}

export function defaultBindHost({
  hostEnv = process.env.HOST || process.env.WEB_HOST,
  isPublicInternet = false,
} = {}) {
  const explicit = String(hostEnv || '').trim();
  if (explicit) return explicit;
  return isPublicInternet ? '0.0.0.0' : '127.0.0.1';
}
