import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { signTenantToken, isJwtAuthEnabled } from '../auth/jwt-util.js';

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * @param {import('better-sqlite3').Database} sqlDb
 */
export function registerAuthRoutes(app, sqlDb) {
  app.post('/api/auth/register', (req, res) => {
    if (!isJwtAuthEnabled()) {
      return res.status(503).json({ error: 'Registration disabled (set JWT_SECRET).' });
    }
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email.includes('@') || password.length < 8) {
      return res.status(400).json({ error: 'Valid email and password (8+ chars) required.' });
    }
    try {
      const exists = sqlDb.prepare('SELECT id FROM tenants WHERE email = ?').get(email);
      if (exists) return res.status(409).json({ error: 'Email already registered.' });
      const id = randomUUID();
      const hash = bcrypt.hashSync(password, 12);
      sqlDb.prepare(
        'INSERT INTO tenants (id, email, password_hash) VALUES (?, ?, ?)',
      ).run(id, email, hash);
      const token = signTenantToken(id, email);
      return res.json({ token, tenantId: id, email });
    } catch (e) {
      console.error('[auth/register]', e.message);
      return res.status(500).json({ error: 'Registration failed.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    if (!isJwtAuthEnabled()) {
      return res.status(503).json({ error: 'Login disabled (set JWT_SECRET).' });
    }
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
      const row = sqlDb.prepare(
        'SELECT id, email, password_hash FROM tenants WHERE email = ?',
      ).get(email);
      if (!row || !bcrypt.compareSync(password, row.password_hash)) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      const token = signTenantToken(row.id, row.email);
      return res.json({ token, tenantId: row.id, email: row.email });
    } catch (e) {
      console.error('[auth/login]', e.message);
      return res.status(500).json({ error: 'Login failed.' });
    }
  });

  app.get('/api/auth/status', (_req, res) => {
    res.json({
      jwtAuthEnabled: isJwtAuthEnabled(),
    });
  });
}
