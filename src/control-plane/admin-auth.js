/**
 * Admin gate for /analytics and /api/control/admin/*.
 * Prefer HTTP Basic (CONTROL_PLANE_ADMIN_USER + CONTROL_PLANE_ADMIN_PASSWORD).
 * Bearer SESSION_SECRET remains as a fallback for scripts / local use.
 */
import { timingSafeEqual } from 'crypto';
import { getServerSecret } from '../auth/jwt-util.js';

export function isAdminBasicConfigured() {
  return Boolean(
    String(process.env.CONTROL_PLANE_ADMIN_USER || '').trim()
    && String(process.env.CONTROL_PLANE_ADMIN_PASSWORD || '') !== '',
  );
}

function safeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function parseBasicAuth(header) {
  const h = String(header || '');
  if (!h.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export function adminAuthorized(req) {
  const header = req.get('authorization') || '';

  if (isAdminBasicConfigured()) {
    const basic = parseBasicAuth(header);
    const expectUser = String(process.env.CONTROL_PLANE_ADMIN_USER || '').trim();
    const expectPass = String(process.env.CONTROL_PLANE_ADMIN_PASSWORD || '');
    if (basic && safeEqualString(basic.user, expectUser) && safeEqualString(basic.pass, expectPass)) {
      return true;
    }
  }

  const secret = getServerSecret();
  if (!secret) return false;
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return Boolean(bearer) && safeEqualString(bearer, secret);
}

/** Express middleware — 401 + WWW-Authenticate when Basic is configured. */
export function requireAdmin(req, res, next) {
  if (adminAuthorized(req)) return next();
  if (isAdminBasicConfigured()) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Searchable Admin", charset="UTF-8"');
    return res.status(401).type('text/plain').send('Authentication required');
  }
  return res.status(401).json({
    error: 'Unauthorized — pass Authorization: Bearer $SESSION_SECRET or configure CONTROL_PLANE_ADMIN_USER/PASSWORD',
  });
}
