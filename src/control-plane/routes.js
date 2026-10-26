/**
 * Control-plane HTTP routes: download analytics, accounts, licenses, Stripe, admin.
 */
import { resolve } from 'path';
import express from 'express';
import { getServerSecret } from '../auth/jwt-util.js';
import config from '../config.js';
import { getLatestGitHubRelease, sendReleaseError } from '../releases/github-releases.js';
import { sendMagicLinkEmail } from './email.js';
import {
  applyControlPlanePolicy,
  getUpdateDownloadUrl,
} from './app-policy.js';
import {
  evaluateEntitlement,
  signLicenseToken,
  trialDays,
} from './license.js';
import { isLicenseGateEnabled } from './license-gate.js';
import { capturePostHog } from './posthog.js';
import {
  findAssetForPlatform,
  normalizePlatform,
  PLATFORMS,
} from './platforms.js';
import {
  createCheckoutSession,
  createCustomerPortalSession,
  constructWebhookEvent,
  isStripeConfigured,
} from './stripe-billing.js';
import { adminAuthorized, requireAdmin } from './admin-auth.js';
import { getControlPlaneStore } from './store.js';
import { isPublicInternetDeploy, publicDeployBaseUrl } from '../deploy-env.js';

export { isLicenseGateEnabled } from './license-gate.js';
export { adminAuthorized, requireAdmin } from './admin-auth.js';

function publicBaseUrl(req) {
  const envUrl = publicDeployBaseUrl();
  if (envUrl) return envUrl;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

/** Strict email shape — rejects HTML / quote characters used in stored XSS. */
export function isValidControlPlaneEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || e.length > 254) return false;
  if (/[<>"'`\\]/.test(e)) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(e);
}

/**
 * Must be mounted **before** `express.json()` so Stripe signature verification sees raw bytes.
 * @param {import('express').Application} app
 * @param {ReturnType<typeof getControlPlaneStore>} store
 */
export function registerStripeWebhookRoute(app, store) {
  app.post(
    '/api/control/webhooks/stripe',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      try {
        const sig = req.get('stripe-signature');
        if (!sig) {
          return res.status(400).json({ error: 'Missing stripe-signature header' });
        }
        if (!Buffer.isBuffer(req.body)) {
          return res.status(400).json({ error: 'Expected raw request body' });
        }
        const event = await constructWebhookEvent(req.body, sig);
        await handleStripeEvent(store, event);
        return res.json({ received: true });
      } catch (err) {
        console.error('[stripe webhook]', err.message);
        return res.status(400).json({ error: err.message });
      }
    },
  );
}

function clientIpCountry(req) {
  return (req.get('cf-ipcountry') || req.get('x-vercel-ip-country') || '').trim() || null;
}

/**
 * @param {import('express').Application} app
 * @param {{ store?: ReturnType<typeof getControlPlaneStore> }} [opts]
 */
export function registerControlPlaneRoutes(app, opts = {}) {
  const store = opts.store || getControlPlaneStore(config.controlPlaneDbPath);

  app.get('/api/releases/download/:platform', async (req, res) => {
    const platform = normalizePlatform(req.params.platform);
    if (!platform) {
      return res.status(400).json({ error: 'Unknown platform', platforms: Object.keys(PLATFORMS) });
    }
    const repo = config.githubRepo;
    try {
      const data = await getLatestGitHubRelease(repo);
      const asset = findAssetForPlatform(data.allAssets, platform);
      if (!asset?.url) {
        return res.status(404).json({ error: `No asset for platform ${platform}`, version: data.version });
      }
      const anonId = (req.query.anon || req.query.anon_id || '').toString().slice(0, 64) || null;
      const utmSource = (req.query.utm_source || '').toString().slice(0, 80) || null;
      const utmCampaign = (req.query.utm_campaign || '').toString().slice(0, 80) || null;
      const utmMedium = (req.query.utm_medium || '').toString().slice(0, 80) || null;
      await store.logAnalyticsEvent({
        event: 'download_clicked',
        platform,
        version: data.version,
        anonId,
        utmSource,
        utmCampaign,
        utmMedium,
        userAgent: (req.get('user-agent') || '').slice(0, 300),
      });
      await store.logProductEvent({
        event: 'download_clicked',
        installId: anonId,
        platform,
        props: { version: data.version, utmSource, utmCampaign },
      });
      void capturePostHog('download_clicked', {
        distinctId: anonId || `dl_${platform}`,
        properties: { platform, version: data.version, utm_source: utmSource, utm_campaign: utmCampaign },
      });
      return res.redirect(302, asset.url);
    } catch (err) {
      return sendReleaseError(res, err, repo);
    }
  });

  app.get('/api/analytics/downloads', requireAdmin, async (req, res) => {
    const summary = await store.downloadSummary();
    return res.json({
      ...summary,
      platforms: Object.values(PLATFORMS).map((p) => p.id),
      githubDownloadCountsNote: 'Also compare with GitHub asset download_count on /api/releases/latest',
    });
  });

  app.get('/analytics', requireAdmin, (_req, res) => {
    // `dotfiles: 'allow'` lets dev worktrees under `.worktrees/…` serve pages.
    res.sendFile(resolve(config.publicDir, 'analytics.html'), { dotfiles: 'allow' });
  });

  app.post('/api/control/auth/request-link', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!isValidControlPlaneEmail(email)) {
        return res.status(400).json({ error: 'Valid email required' });
      }
      const hasResend = Boolean((process.env.RESEND_API_KEY || '').trim());
      const publicDeploy = isPublicInternetDeploy();
      // Public hosts must send real email — never return OTP in the JSON body.
      if (publicDeploy && !hasResend) {
        return res.status(503).json({ error: 'Email delivery is not configured' });
      }
      const installId = String(req.body?.installId || '').trim().slice(0, 80) || null;
      const utmSource = String(req.body?.utmSource || req.body?.utm_source || '').slice(0, 80) || null;
      const utmCampaign = String(req.body?.utmCampaign || req.body?.utm_campaign || '').slice(0, 80) || null;
      const os = String(req.body?.os || '').slice(0, 40) || null;
      const appVersion = String(req.body?.appVersion || '').slice(0, 40) || null;

      if (installId) {
        await store.upsertDevice({ installId, os, appVersion });
      }

      const { token, code, expiresAt } = await store.createMagicLink({
        email, installId, utmSource, utmCampaign,
      });
      const verifyUrl = `${publicBaseUrl(req)}/api/control/auth/verify?token=${encodeURIComponent(token)}`;
      await sendMagicLinkEmail({ to: email, verifyUrl, code });

      await store.logProductEvent({
        event: 'magic_link_requested',
        installId,
        props: { email },
      });
      void capturePostHog('magic_link_requested', {
        distinctId: email,
        properties: { installId, utm_source: utmSource },
      });

      const payload = { ok: true, expiresAt, email };
      // Local / test only — never on Render or when CONTROL_PLANE_EXPOSE_DEV_CODE is unset on public.
      const allowDevCode = process.env.NODE_ENV === 'test'
        || (!publicDeploy && (
          !hasResend
          || process.env.CONTROL_PLANE_EXPOSE_DEV_CODE === '1'
        ));
      if (allowDevCode) payload.devCode = code;
      if (process.env.NODE_ENV === 'test') payload.devToken = token;
      return res.json(payload);
    } catch (err) {
      console.error('[control-plane] request-link:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/control/auth/verify', async (req, res) => {
    try {
      const token = String(req.query.token || '');
      const row = await store.consumeMagicLinkByToken(token);
      if (!row) {
        return res.status(400).type('html').send(verifyHtml('Link invalid or expired. Request a new code in the app.', false));
      }
      const result = await activateAccount(store, row);
      return res.status(200).type('html').send(verifyHtml(
        `Signed in as <strong>${escapeHtml(result.user.email)}</strong>. `
        + `Pro trial active until ${escapeHtml(result.entitlement.trialEndsAt || 'n/a')}. `
        + 'Return to Searchable — it will unlock automatically.',
        true,
        result,
      ));
    } catch (err) {
      return res.status(500).type('html').send(verifyHtml(escapeHtml(err.message), false));
    }
  });

  app.post('/api/control/auth/verify-code', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!isValidControlPlaneEmail(email)) {
        return res.status(400).json({ error: 'Valid email required' });
      }
      const code = String(req.body?.code || '').trim();
      const row = await store.consumeMagicLinkByCode(email, code);
      if (!row) return res.status(400).json({ error: 'Invalid or expired code' });
      const installId = String(req.body?.installId || row.install_id || '').trim() || null;
      if (installId && !row.install_id) row.install_id = installId;
      const result = await activateAccount(store, row);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/control/license/status', async (req, res) => {
    const installId = String(req.query.installId || '').trim();
    if (!installId) return res.status(400).json({ error: 'installId required' });
    const appVersion = String(req.query.appVersion || '').slice(0, 40) || null;
    const device = await store.upsertDevice({
      installId,
      os: String(req.query.os || '').slice(0, 40) || null,
      appVersion,
    });
    const license = await store.getLicenseForInstall(installId);
    const baseEntitlement = evaluateEntitlement(license);
    const { entitlement, policy } = applyControlPlanePolicy(baseEntitlement, {
      appVersion,
      downloadUrl: getUpdateDownloadUrl(req),
    });
    let user = null;
    if (device.user_id) user = await store.getUserById(device.user_id);
    const secret = getServerSecret();
    let licenseToken = null;
    if (secret && user && entitlement.allowed) {
      licenseToken = signLicenseToken({
        userId: user.id,
        email: user.email,
        plan: entitlement.plan,
        status: entitlement.status,
        trialEndsAt: entitlement.trialEndsAt,
        installId,
      }, secret);
    }
    await store.logProductEvent({
      event: 'license_status_checked',
      userId: user?.id,
      installId,
      props: {
        allowed: entitlement.allowed,
        plan: entitlement.plan,
        reason: entitlement.reason,
        appVersion,
      },
    });
    return res.json({
      entitlement,
      policy,
      email: user?.email || null,
      userId: user?.id || null,
      licenseToken,
      trialDays: trialDays(),
      stripeEnabled: isStripeConfigured(),
    });
  });

  app.get('/api/control/entitlement', async (req, res) => {
    const installId = String(req.query.installId || req.get('x-install-id') || '').trim();
    const appVersion = String(req.query.appVersion || req.get('x-app-version') || '').slice(0, 40);
    if (!installId) {
      return res.json({
        allowed: false,
        reason: 'account_required',
        plan: 'none',
        gateEnabled: isLicenseGateEnabled(),
      });
    }
    const license = await store.getLicenseForInstall(installId);
    const { entitlement, policy } = applyControlPlanePolicy(evaluateEntitlement(license), {
      appVersion,
      downloadUrl: getUpdateDownloadUrl(req),
    });
    return res.json({ ...entitlement, policy, gateEnabled: isLicenseGateEnabled() });
  });

  app.post('/api/control/billing/checkout', async (req, res) => {
    try {
      if (!isStripeConfigured()) {
        return res.status(503).json({ error: 'Stripe is not configured (STRIPE_SECRET_KEY + STRIPE_PRICE_ID)' });
      }
      const installId = String(req.body?.installId || '').trim();
      const device = await store.getDevice(installId);
      if (!device?.user_id) return res.status(401).json({ error: 'Sign in first' });
      const user = await store.getUserById(device.user_id);
      const base = publicBaseUrl(req);
      const session = await createCheckoutSession({
        customerEmail: user.email,
        userId: user.id,
        successUrl: `${base}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/?billing=cancel`,
      });
      await store.logProductEvent({
        event: 'checkout_started',
        userId: user.id,
        installId,
        props: { sessionId: session.id },
      });
      void capturePostHog('checkout_started', {
        distinctId: user.email,
        properties: { installId },
      });
      return res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/control/billing/portal', async (req, res) => {
    try {
      if (!isStripeConfigured()) return res.status(503).json({ error: 'Stripe is not configured' });
      const installId = String(req.body?.installId || '').trim();
      const device = await store.getDevice(installId);
      if (!device?.user_id) return res.status(401).json({ error: 'Sign in first' });
      const license = await store.getLicenseForUser(device.user_id);
      if (!license?.stripe_customer_id) {
        return res.status(400).json({ error: 'No Stripe customer yet — subscribe first' });
      }
      const session = await createCustomerPortalSession({
        customerId: license.stripe_customer_id,
        returnUrl: `${publicBaseUrl(req)}/`,
      });
      return res.json({ url: session.url });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/control/events', async (req, res) => {
    const event = String(req.body?.event || '').trim().slice(0, 80);
    if (!event) return res.status(400).json({ error: 'event required' });
    const installId = String(req.body?.installId || '').trim().slice(0, 80) || null;
    const platform = String(req.body?.platform || '').slice(0, 40) || null;
    let userId = null;
    if (installId) {
      const d = await store.getDevice(installId);
      userId = d?.user_id || null;
    }
    await store.logProductEvent({
      event,
      userId,
      installId,
      platform,
      props: req.body?.properties || null,
    });
    void capturePostHog(event, {
      distinctId: userId || installId || 'anonymous',
      properties: { ...(req.body?.properties || {}), installId, platform },
    });
    return res.json({ ok: true });
  });

  app.get('/api/control/admin/users', requireAdmin, async (_req, res) => {
    return res.json({ users: await store.listUsers(200) });
  });

  /**
   * Remote lock / unlock a user license.
   * Body: { email, status: 'disabled' | 'revoked' | 'trialing' | 'active' | 'canceled' }
   */
  app.post('/api/control/admin/license', requireAdmin, async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const status = String(req.body?.status || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'email required' });
      const allowed = new Set(['disabled', 'revoked', 'locked', 'trialing', 'active', 'canceled', 'past_due']);
      if (!allowed.has(status)) {
        return res.status(400).json({
          error: `status must be one of: ${[...allowed].join(', ')}`,
        });
      }
      const result = await store.setLicenseStatusByEmail(email, status);
      if (!result) return res.status(404).json({ error: 'User not found' });
      const entitlement = evaluateEntitlement(result.license);
      await store.logProductEvent({
        event: 'admin_license_update',
        userId: result.user.id,
        props: { status, email },
      });
      return res.json({
        ok: true,
        user: { id: result.user.id, email: result.user.email },
        license: result.license,
        entitlement,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/control/admin/policy', requireAdmin, (req, res) => {
    const { policy } = applyControlPlanePolicy(
      { allowed: true, plan: 'pro', status: 'active', reason: null, trialEndsAt: null },
      { appVersion: '999.0.0', downloadUrl: getUpdateDownloadUrl(req) },
    );
    return res.json({
      minAppVersion: policy.minAppVersion,
      downloadUrl: policy.downloadUrl,
      licenseGate: isLicenseGateEnabled(),
    });
  });

  return { store };
}

async function activateAccount(store, magicRow) {
  const user = await store.upsertUser({
    email: magicRow.email,
    utmSource: magicRow.utm_source,
    utmCampaign: magicRow.utm_campaign,
    country: null,
  });
  if (magicRow.install_id) {
    await store.upsertDevice({ installId: magicRow.install_id, userId: user.id });
  }
  const license = await store.createTrialLicense(user.id, trialDays());
  const entitlement = evaluateEntitlement(license);
  const secret = getServerSecret();
  const licenseToken = secret
    ? signLicenseToken({
      userId: user.id,
      email: user.email,
      plan: entitlement.plan,
      status: entitlement.status,
      trialEndsAt: entitlement.trialEndsAt,
      installId: magicRow.install_id,
    }, secret)
    : null;

  await store.logProductEvent({
    event: 'account_created',
    userId: user.id,
    installId: magicRow.install_id,
    props: { trialEndsAt: entitlement.trialEndsAt },
  });
  void capturePostHog('account_created', {
    distinctId: user.email,
    properties: {
      installId: magicRow.install_id,
      utm_source: magicRow.utm_source,
      trial_ends_at: entitlement.trialEndsAt,
    },
  });
  void capturePostHog('trial_start', {
    distinctId: user.email,
    properties: { trial_ends_at: entitlement.trialEndsAt },
  });

  return {
    user: { id: user.id, email: user.email },
    license,
    entitlement,
    licenseToken,
  };
}

async function handleStripeEvent(store, event) {
  if (!event?.type) return;
  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object || {};
    const userId = session.client_reference_id || session.metadata?.searchable_user_id;
    if (!userId) return;
    await store.updateLicenseStripe(userId, {
      customerId: session.customer,
      subscriptionId: session.subscription,
      plan: 'pro',
      status: 'active',
    });
    await store.logProductEvent({
      event: 'subscribed',
      userId,
      props: { sessionId: session.id },
    });
    const user = await store.getUserById(userId);
    void capturePostHog('subscribed', {
      distinctId: user?.email || userId,
      properties: { plan: 'pro' },
    });
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data?.object || {};
    const customerId = sub.customer;
    const userId = await store.findUserIdByStripeCustomerId(customerId);
    if (userId) {
      await store.updateLicenseStripe(userId, { status: 'canceled', plan: 'trial' });
    }
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function verifyHtml(message, ok, result) {
  const tokenBlock = result?.licenseToken
    ? `<p style="font-size:12px;word-break:break-all;background:#f0f2f5;padding:10px;border-radius:8px">License token (auto-synced if you opened from the same device):<br>${escapeHtml(result.licenseToken)}</p>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Searchable</title>
    <style>body{font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 20px;color:#111b21}
    .ok{color:#008f72}.bad{color:#b91c1c}</style></head>
    <body><h1>Searchable</h1><p class="${ok ? 'ok' : 'bad'}">${message}</p>${tokenBlock}
    <p><a href="/">Open web app</a></p></body></html>`;
}
