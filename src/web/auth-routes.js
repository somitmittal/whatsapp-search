import { isJwtAuthEnabled } from '../auth/jwt-util.js';
import {
  clearSessionCookie,
  getSessionIdFromRequest,
} from '../auth/user-session.js';
import { getCurrentTenantId } from '../storage/tenant-context.js';

/**
 * @param {import('express').Application} app
 * @param {{ sessions: import('../auth/user-session.js').UserSessionService, isSecureCookie: () => boolean }} ctx
 */
export function registerAuthRoutes(app, ctx) {
  const { sessions } = ctx;
  const isSecure = () =>
    ctx && typeof ctx.isSecureCookie === 'function' ? ctx.isSecureCookie() : false;

  app.get('/api/auth/status', (_req, res) => {
    res.json({
      sessionAuthEnabled: isJwtAuthEnabled(),
    });
  });

  /**
   * Current tenant + opaque session id (for mobile / extension). Web uses httpOnly cookie only.
   */
  app.get('/api/auth/ensure', (req, res) => {
    if (!isJwtAuthEnabled()) {
      return res.status(503).json({ error: 'Set SESSION_SECRET (or JWT_SECRET) on the server.' });
    }
    const sid = req.waSessionId;
    if (!sid) {
      return res.status(500).json({ error: 'Session not ready' });
    }
    return res.json({
      tenantId: getCurrentTenantId(),
      sessionId: sid,
    });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (!isJwtAuthEnabled()) {
      return res.status(503).json({ error: 'Server auth is not enabled.' });
    }
    const sid = getSessionIdFromRequest(req) || req.waSessionId;
    if (sid) sessions.deleteById(sid);
    clearSessionCookie(res, { secure: isSecure() });
    return res.json({ ok: true });
  });
}
