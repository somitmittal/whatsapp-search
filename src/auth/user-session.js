import { randomBytes, randomUUID } from 'node:crypto';

export const SESSION_COOKIE = 'ws.sid';
const SESSION_DAYS = 30;

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function defaultExpiresAt() {
  return nowSec() + SESSION_DAYS * 24 * 3600;
}

/**
 * @param {string | null | undefined} s
 * @returns {boolean}
 */
export function isOpaqueSessionId(s) {
  return typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s);
}

/**
 * @param {import('express').Request} req
 * @returns {string | null}
 */
export function getSessionIdFromRequest(req) {
  const c = req.cookies && req.cookies[SESSION_COOKIE];
  if (isOpaqueSessionId(c)) return c;
  const auth = req.headers?.authorization;
  if (auth) {
    const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(auth).trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export class UserSessionService {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this._db = db;
  }

  /**
   * @param {string} id
   * @returns {{ id: string, tenant_id: string, created_at: number, expires_at: number } | null}
   */
  getById(id) {
    if (!isOpaqueSessionId(id)) return null;
    const row = this._db
      .prepare('SELECT id, tenant_id, created_at, expires_at FROM user_sessions WHERE id = ?')
      .get(id);
    if (!row) return null;
    if (row.expires_at < nowSec()) {
      this._db.prepare('DELETE FROM user_sessions WHERE id = ?').run(id);
      return null;
    }
    return row;
  }

  /**
   * @param {string} id
   */
  touch(id) {
    if (!isOpaqueSessionId(id)) return;
    this._db
      .prepare('UPDATE user_sessions SET expires_at = ? WHERE id = ?')
      .run(defaultExpiresAt(), id);
  }

  /**
   * @param {string} id
   * @param {string} tenantId
   */
  rebindTenant(id, tenantId) {
    if (!isOpaqueSessionId(id) || !tenantId) return;
    this._db.prepare('UPDATE user_sessions SET tenant_id = ? WHERE id = ?').run(tenantId, id);
  }

  /**
   * @param {string} tenantId
   * @returns {string} session id
   */
  create(tenantId) {
    const id = randomBytes(32).toString('hex');
    const t = nowSec();
    const e = defaultExpiresAt();
    this._db
      .prepare('INSERT INTO user_sessions (id, tenant_id, created_at, expires_at) VALUES (?,?,?,?)')
      .run(id, tenantId, t, e);
    return id;
  }

  /**
   * @returns {{ sessionId: string, tenantId: string }}
   */
  createTenantWithSession() {
    const tid = randomUUID();
    this._db.prepare('INSERT INTO tenants (id, email, password_hash) VALUES (?, NULL, NULL)').run(tid);
    const sessionId = this.create(tid);
    return { sessionId, tenantId: tid };
  }

  /**
   * @param {string} id
   * @returns {number}
   */
  deleteById(id) {
    if (!isOpaqueSessionId(id)) return 0;
    return this._db.prepare('DELETE FROM user_sessions WHERE id = ?').run(id).changes;
  }
}

/**
 * @param {import('express').Response} res
 * @param {string} sessionId
 * @param {{ secure: boolean }} opts
 */
export function setSessionCookie(res, sessionId, opts) {
  res.cookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    secure: Boolean(opts?.secure),
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
}

/**
 * @param {import('express').Response} res
 * @param {{ secure: boolean }} opts
 */
export function clearSessionCookie(res, opts) {
  res.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure: Boolean(opts?.secure),
    sameSite: 'lax',
  });
}
