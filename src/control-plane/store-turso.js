/**
 * Control-plane store on Turso (hosted libSQL / SQLite).
 * Same shape as the local SQLite store — never stores chat content.
 */
import { createClient } from '@libsql/client';
import { createHash, randomBytes } from 'crypto';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  platform TEXT,
  version TEXT,
  anon_id TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  utm_medium TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_event_created ON analytics_events(event, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_platform ON analytics_events(platform);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  country TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  install_id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  os TEXT,
  app_version TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL DEFAULT 'trial',
  status TEXT NOT NULL DEFAULT 'active',
  trial_ends_at TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_licenses_user ON licenses(user_id);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  install_id TEXT,
  code TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  user_id TEXT,
  install_id TEXT,
  platform TEXT,
  props_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_events_name ON product_events(event, created_at);
`;

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function rowToObject(row) {
  if (!row) return null;
  if (typeof row === 'object' && !Array.isArray(row)) {
    // libsql Row is array-like + named props; copy enumerable own keys we care about
    const out = {};
    for (const key of Object.keys(row)) {
      if (Number.isNaN(Number(key))) out[key] = row[key];
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

export function isTursoConfigured() {
  const url = String(process.env.TURSO_DATABASE_URL || '').trim();
  if (!url) return false;
  // Local libSQL file for tests; hosted Turso needs an auth token.
  if (url.startsWith('file:')) return true;
  return Boolean(String(process.env.TURSO_AUTH_TOKEN || '').trim());
}

export async function openTursoControlPlaneStore({
  url = process.env.TURSO_DATABASE_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
} = {}) {
  const dbUrl = String(url || '').trim();
  const token = String(authToken || '').trim();
  const client = createClient(
    dbUrl.startsWith('file:')
      ? { url: dbUrl }
      : { url: dbUrl, authToken: token },
  );
  await client.executeMultiple(SCHEMA_SQL);

  async function get(sql, args = []) {
    const rs = await client.execute({ sql, args });
    return rowToObject(rs.rows[0]) || null;
  }

  async function all(sql, args = []) {
    const rs = await client.execute({ sql, args });
    return (rs.rows || []).map((r) => rowToObject(r)).filter(Boolean);
  }

  async function run(sql, args = []) {
    await client.execute({ sql, args });
  }

  const store = {
    kind: 'turso',
    close() {
      try { client.close(); } catch { /* ignore */ }
    },

    async logAnalyticsEvent(row) {
      await run(
        `INSERT INTO analytics_events (event, platform, version, anon_id, utm_source, utm_campaign, utm_medium, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.event || 'download_clicked',
          row.platform || null,
          row.version || null,
          row.anonId || row.anon_id || null,
          row.utmSource || row.utm_source || null,
          row.utmCampaign || row.utm_campaign || null,
          row.utmMedium || row.utm_medium || null,
          row.userAgent || row.user_agent || null,
        ],
      );
    },

    async downloadSummary() {
      const byPlatform = await all(`
        SELECT platform AS platform, COUNT(*) AS count
        FROM analytics_events
        WHERE event = 'download_clicked'
        GROUP BY platform
        ORDER BY count DESC
      `);
      const byDay = await all(`
        SELECT substr(created_at, 1, 10) AS day, platform, COUNT(*) AS count
        FROM analytics_events
        WHERE event = 'download_clicked'
        GROUP BY day, platform
        ORDER BY day DESC
        LIMIT 90
      `);
      const byVersion = await all(`
        SELECT version, platform, COUNT(*) AS count
        FROM analytics_events
        WHERE event = 'download_clicked'
        GROUP BY version, platform
        ORDER BY count DESC
        LIMIT 50
      `);
      const totalRow = await get(`
        SELECT COUNT(*) AS c FROM analytics_events WHERE event = 'download_clicked'
      `);
      return {
        total: Number(totalRow?.c || 0),
        byPlatform,
        byDay,
        byVersion,
      };
    },

    async upsertUser({ email, name, utmSource, utmCampaign, country }) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!normalized) throw new Error('email required');
      const existing = await get('SELECT * FROM users WHERE email = ?', [normalized]);
      if (existing) {
        await run(
          `UPDATE users SET last_seen_at = datetime('now'),
            name = COALESCE(?, name),
            utm_source = COALESCE(utm_source, ?),
            utm_campaign = COALESCE(utm_campaign, ?)
           WHERE id = ?`,
          [name || null, utmSource || null, utmCampaign || null, existing.id],
        );
        return get('SELECT * FROM users WHERE id = ?', [existing.id]);
      }
      const id = newId('usr');
      await run(
        `INSERT INTO users (id, email, name, utm_source, utm_campaign, country, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [id, normalized, name || null, utmSource || null, utmCampaign || null, country || null],
      );
      return get('SELECT * FROM users WHERE id = ?', [id]);
    },

    async getUserById(id) {
      return get('SELECT * FROM users WHERE id = ?', [id]);
    },

    async getUserByEmail(email) {
      return get('SELECT * FROM users WHERE email = ?', [String(email || '').trim().toLowerCase()]);
    },

    async upsertDevice({ installId, userId, os, appVersion }) {
      const id = String(installId || '').trim();
      if (!id) throw new Error('installId required');
      const existing = await get('SELECT * FROM devices WHERE install_id = ?', [id]);
      if (existing) {
        await run(
          `UPDATE devices SET
            user_id = COALESCE(?, user_id),
            os = COALESCE(?, os),
            app_version = COALESCE(?, app_version),
            last_seen_at = datetime('now')
           WHERE install_id = ?`,
          [userId || null, os || null, appVersion || null, id],
        );
      } else {
        await run(
          'INSERT INTO devices (install_id, user_id, os, app_version) VALUES (?, ?, ?, ?)',
          [id, userId || null, os || null, appVersion || null],
        );
      }
      return get('SELECT * FROM devices WHERE install_id = ?', [id]);
    },

    async getDevice(installId) {
      return get('SELECT * FROM devices WHERE install_id = ?', [String(installId || '')]);
    },

    async createTrialLicense(userId, trialDays = 14) {
      const existing = await get(
        `SELECT * FROM licenses WHERE user_id = ? AND status IN ('active', 'trialing')
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      if (existing) return existing;
      const id = newId('lic');
      const trialEnds = new Date(Date.now() + trialDays * 86400000).toISOString();
      await run(
        `INSERT INTO licenses (id, user_id, plan, status, trial_ends_at)
         VALUES (?, ?, 'trial', 'trialing', ?)`,
        [id, userId, trialEnds],
      );
      return get('SELECT * FROM licenses WHERE id = ?', [id]);
    },

    async getLicenseForUser(userId) {
      return get(
        `SELECT * FROM licenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
    },

    async getLicenseForInstall(installId) {
      const device = await this.getDevice(installId);
      if (!device?.user_id) return null;
      return this.getLicenseForUser(device.user_id);
    },

    async updateLicenseStripe(userId, { customerId, subscriptionId, plan, status }) {
      const lic = await this.getLicenseForUser(userId);
      if (!lic) return null;
      await run(
        `UPDATE licenses SET
          stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_subscription_id = COALESCE(?, stripe_subscription_id),
          plan = COALESCE(?, plan),
          status = COALESCE(?, status),
          updated_at = datetime('now')
         WHERE id = ?`,
        [customerId || null, subscriptionId || null, plan || null, status || null, lic.id],
      );
      return this.getLicenseForUser(userId);
    },

    async setLicenseStatusByEmail(email, status, { plan = null } = {}) {
      const user = await this.getUserByEmail(email);
      if (!user) return null;
      let lic = await this.getLicenseForUser(user.id);
      if (!lic) lic = await this.createTrialLicense(user.id, 14);
      const next = String(status || '').trim().toLowerCase();
      if (!next) throw new Error('status required');
      let nextPlan = plan != null ? String(plan).trim().toLowerCase() : null;
      if (!nextPlan && next === 'active') nextPlan = 'pro';
      if (!nextPlan && next === 'trialing') nextPlan = 'trial';
      if (nextPlan) {
        await run(
          `UPDATE licenses SET status = ?, plan = ?, updated_at = datetime('now') WHERE id = ?`,
          [next, nextPlan, lic.id],
        );
      } else {
        await run(
          `UPDATE licenses SET status = ?, updated_at = datetime('now') WHERE id = ?`,
          [next, lic.id],
        );
      }
      return {
        user,
        license: await this.getLicenseForUser(user.id),
      };
    },

    async createMagicLink({ email, installId, utmSource, utmCampaign, ttlMinutes = 30 }) {
      const token = randomBytes(24).toString('hex');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const tokenHash = hashToken(token);
      const expires = new Date(Date.now() + ttlMinutes * 60000).toISOString();
      await run(
        `INSERT INTO magic_links (token_hash, email, install_id, code, utm_source, utm_campaign, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          tokenHash,
          String(email).trim().toLowerCase(),
          installId || null,
          code,
          utmSource || null,
          utmCampaign || null,
          expires,
        ],
      );
      return { token, code, expiresAt: expires };
    },

    async consumeMagicLinkByToken(token) {
      const row = await get('SELECT * FROM magic_links WHERE token_hash = ?', [hashToken(token)]);
      return consumeMagicRow(run, row);
    },

    async consumeMagicLinkByCode(email, code) {
      const row = await get(
        `SELECT * FROM magic_links
         WHERE email = ? AND code = ? AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [String(email).trim().toLowerCase(), String(code).trim()],
      );
      return consumeMagicRow(run, row);
    },

    async logProductEvent({ event, userId, installId, platform, props }) {
      await run(
        `INSERT INTO product_events (event, user_id, install_id, platform, props_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
          event,
          userId || null,
          installId || null,
          platform || null,
          props ? JSON.stringify(props) : null,
        ],
      );
    },

    async listUsers(limit = 100) {
      return all(
        `SELECT u.*, l.plan, l.status AS license_status, l.trial_ends_at
         FROM users u
         LEFT JOIN licenses l ON l.user_id = u.id
         ORDER BY u.created_at DESC
         LIMIT ?`,
        [limit],
      );
    },

    async findUserIdByStripeCustomerId(customerId) {
      const row = await get(
        'SELECT user_id FROM licenses WHERE stripe_customer_id = ? LIMIT 1',
        [customerId],
      );
      return row?.user_id || null;
    },
  };

  return store;
}

async function consumeMagicRow(run, row) {
  if (!row) return null;
  if (row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  await run(
    `UPDATE magic_links SET consumed_at = datetime('now') WHERE token_hash = ?`,
    [row.token_hash],
  );
  return row;
}
