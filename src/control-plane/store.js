/**
 * Control-plane store (accounts, licenses, download analytics).
 * Separate from the local chat DB — never stores message content.
 *
 * Backend:
 * - Turso (hosted SQLite) when TURSO_DATABASE_URL + TURSO_AUTH_TOKEN are set
 * - Local SQLite file otherwise (desktop / tests / ephemeral Render)
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes, createHash } from 'crypto';
import { isTursoConfigured, openTursoControlPlaneStore } from './store-turso.js';

let singleton = null;
let initPromise = null;

export function openControlPlaneStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const store = wrapStore(db);
  store.kind = 'sqlite';
  return store;
}

/**
 * Prefer this on startup (awaits Turso schema). Safe to call multiple times.
 */
export async function ensureControlPlaneStore(dbPath) {
  if (singleton) return singleton;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (isTursoConfigured()) {
      singleton = await openTursoControlPlaneStore();
      console.log('[control-plane] backend=turso');
    } else {
      singleton = openControlPlaneStore(dbPath);
      console.log('[control-plane] backend=sqlite');
    }
    return singleton;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export function getControlPlaneStore(dbPath) {
  if (singleton) return singleton;
  if (isTursoConfigured()) {
    throw new Error(
      'Turso is configured — call await ensureControlPlaneStore() before getControlPlaneStore()',
    );
  }
  singleton = openControlPlaneStore(dbPath);
  return singleton;
}

export { isTursoConfigured };

/** @internal test helper */
export function resetControlPlaneStoreForTests() {
  if (singleton) {
    try { singleton.close(); } catch { /* ignore */ }
    singleton = null;
  }
  initPromise = null;
}

function initSchema(db) {
  db.exec(`
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
  `);
}

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function wrapStore(db) {
  const insertEvent = db.prepare(`
    INSERT INTO analytics_events (event, platform, version, anon_id, utm_source, utm_campaign, utm_medium, user_agent)
    VALUES (@event, @platform, @version, @anon_id, @utm_source, @utm_campaign, @utm_medium, @user_agent)
  `);

  return {
    db,
    close() { db.close(); },

    logAnalyticsEvent(row) {
      insertEvent.run({
        event: row.event || 'download_clicked',
        platform: row.platform || null,
        version: row.version || null,
        anon_id: row.anonId || row.anon_id || null,
        utm_source: row.utmSource || row.utm_source || null,
        utm_campaign: row.utmCampaign || row.utm_campaign || null,
        utm_medium: row.utmMedium || row.utm_medium || null,
        user_agent: row.userAgent || row.user_agent || null,
      });
    },

    downloadSummary() {
      const byPlatform = db.prepare(`
        SELECT platform AS platform, COUNT(*) AS count
        FROM analytics_events
        WHERE event = 'download_clicked'
        GROUP BY platform
        ORDER BY count DESC
      `).all();
      const byDay = db.prepare(`
        SELECT substr(created_at, 1, 10) AS day, platform, COUNT(*) AS count
        FROM analytics_events
        WHERE event = 'download_clicked'
        GROUP BY day, platform
        ORDER BY day DESC
        LIMIT 90
      `).all();
      const byVersion = db.prepare(`
        SELECT version, platform, COUNT(*) AS count
        FROM analytics_events
        WHERE event = 'download_clicked'
        GROUP BY version, platform
        ORDER BY count DESC
        LIMIT 50
      `).all();
      const total = db.prepare(`
        SELECT COUNT(*) AS c FROM analytics_events WHERE event = 'download_clicked'
      `).get().c;
      return { total, byPlatform, byDay, byVersion };
    },

    upsertUser({ email, name, utmSource, utmCampaign, country }) {
      const normalized = String(email || '').trim().toLowerCase();
      if (!normalized) throw new Error('email required');
      const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
      if (existing) {
        db.prepare(`
          UPDATE users SET last_seen_at = datetime('now'),
            name = COALESCE(?, name),
            utm_source = COALESCE(utm_source, ?),
            utm_campaign = COALESCE(utm_campaign, ?)
          WHERE id = ?
        `).run(name || null, utmSource || null, utmCampaign || null, existing.id);
        return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
      }
      const id = newId('usr');
      db.prepare(`
        INSERT INTO users (id, email, name, utm_source, utm_campaign, country, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(id, normalized, name || null, utmSource || null, utmCampaign || null, country || null);
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    },

    getUserById(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    },

    getUserByEmail(email) {
      return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase()) || null;
    },

    upsertDevice({ installId, userId, os, appVersion }) {
      const id = String(installId || '').trim();
      if (!id) throw new Error('installId required');
      const existing = db.prepare('SELECT * FROM devices WHERE install_id = ?').get(id);
      if (existing) {
        db.prepare(`
          UPDATE devices SET
            user_id = COALESCE(?, user_id),
            os = COALESCE(?, os),
            app_version = COALESCE(?, app_version),
            last_seen_at = datetime('now')
          WHERE install_id = ?
        `).run(userId || null, os || null, appVersion || null, id);
      } else {
        db.prepare(`
          INSERT INTO devices (install_id, user_id, os, app_version)
          VALUES (?, ?, ?, ?)
        `).run(id, userId || null, os || null, appVersion || null);
      }
      return db.prepare('SELECT * FROM devices WHERE install_id = ?').get(id);
    },

    getDevice(installId) {
      return db.prepare('SELECT * FROM devices WHERE install_id = ?').get(String(installId || '')) || null;
    },

    createTrialLicense(userId, trialDays = 14) {
      const existing = db.prepare(`
        SELECT * FROM licenses WHERE user_id = ? AND status IN ('active', 'trialing')
        ORDER BY created_at DESC LIMIT 1
      `).get(userId);
      if (existing) return existing;
      const id = newId('lic');
      const trialEnds = new Date(Date.now() + trialDays * 86400000).toISOString();
      db.prepare(`
        INSERT INTO licenses (id, user_id, plan, status, trial_ends_at)
        VALUES (?, ?, 'trial', 'trialing', ?)
      `).run(id, userId, trialEnds);
      return db.prepare('SELECT * FROM licenses WHERE id = ?').get(id);
    },

    getLicenseForUser(userId) {
      return db.prepare(`
        SELECT * FROM licenses WHERE user_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(userId) || null;
    },

    getLicenseForInstall(installId) {
      const device = this.getDevice(installId);
      if (!device?.user_id) return null;
      return this.getLicenseForUser(device.user_id);
    },

    updateLicenseStripe(userId, { customerId, subscriptionId, plan, status }) {
      const lic = this.getLicenseForUser(userId);
      if (!lic) return null;
      db.prepare(`
        UPDATE licenses SET
          stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_subscription_id = COALESCE(?, stripe_subscription_id),
          plan = COALESCE(?, plan),
          status = COALESCE(?, status),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(customerId || null, subscriptionId || null, plan || null, status || null, lic.id);
      return this.getLicenseForUser(userId);
    },

    /**
     * Admin remote lock / unlock. status: disabled|revoked|locked|trialing|active|canceled
     * Optional plan override (e.g. restore Pro → plan=pro, status=active).
     */
    setLicenseStatusByEmail(email, status, { plan = null } = {}) {
      const user = this.getUserByEmail(email);
      if (!user) return null;
      let lic = this.getLicenseForUser(user.id);
      if (!lic) {
        lic = this.createTrialLicense(user.id, 14);
      }
      const next = String(status || '').trim().toLowerCase();
      if (!next) throw new Error('status required');
      let nextPlan = plan != null ? String(plan).trim().toLowerCase() : null;
      if (!nextPlan && next === 'active') nextPlan = 'pro';
      if (!nextPlan && next === 'trialing') nextPlan = 'trial';
      if (nextPlan) {
        db.prepare(`
          UPDATE licenses SET status = ?, plan = ?, updated_at = datetime('now') WHERE id = ?
        `).run(next, nextPlan, lic.id);
      } else {
        db.prepare(`
          UPDATE licenses SET status = ?, updated_at = datetime('now') WHERE id = ?
        `).run(next, lic.id);
      }
      return {
        user,
        license: this.getLicenseForUser(user.id),
      };
    },

    createMagicLink({ email, installId, utmSource, utmCampaign, ttlMinutes = 30 }) {
      const token = randomBytes(24).toString('hex');
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const tokenHash = hashToken(token);
      const expires = new Date(Date.now() + ttlMinutes * 60000).toISOString();
      db.prepare(`
        INSERT INTO magic_links (token_hash, email, install_id, code, utm_source, utm_campaign, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        tokenHash,
        String(email).trim().toLowerCase(),
        installId || null,
        code,
        utmSource || null,
        utmCampaign || null,
        expires,
      );
      return { token, code, expiresAt: expires };
    },

    consumeMagicLinkByToken(token) {
      const row = db.prepare('SELECT * FROM magic_links WHERE token_hash = ?').get(hashToken(token));
      return consumeMagicRow(db, row);
    },

    consumeMagicLinkByCode(email, code) {
      const row = db.prepare(`
        SELECT * FROM magic_links
        WHERE email = ? AND code = ? AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `).get(String(email).trim().toLowerCase(), String(code).trim());
      return consumeMagicRow(db, row);
    },

    logProductEvent({ event, userId, installId, platform, props }) {
      db.prepare(`
        INSERT INTO product_events (event, user_id, install_id, platform, props_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        event,
        userId || null,
        installId || null,
        platform || null,
        props ? JSON.stringify(props) : null,
      );
    },

    listUsers(limit = 100) {
      return db.prepare(`
        SELECT u.*, l.plan, l.status AS license_status, l.trial_ends_at
        FROM users u
        LEFT JOIN licenses l ON l.user_id = u.id
        ORDER BY u.created_at DESC
        LIMIT ?
      `).all(limit);
    },

    findUserIdByStripeCustomerId(customerId) {
      const row = db.prepare(
        'SELECT user_id FROM licenses WHERE stripe_customer_id = ? LIMIT 1',
      ).get(customerId);
      return row?.user_id || null;
    },
  };
}

function consumeMagicRow(db, row) {
  if (!row) return null;
  if (row.consumed_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  db.prepare(`UPDATE magic_links SET consumed_at = datetime('now') WHERE token_hash = ?`).run(row.token_hash);
  return row;
}
