import config from '../config.js';
import { applyControlPlanePolicy, getUpdateDownloadUrl } from './app-policy.js';
import { evaluateEntitlement, entitlementFromTokenPayload, verifyLicenseToken } from './license.js';
import { getServerSecret } from '../auth/jwt-util.js';
import { isLicenseGateEnabled } from './license-gate.js';
import { capturePostHog } from './posthog.js';

function withLocalPolicy(entitlement, req) {
  const appVersion = String(
    req.get('x-app-version') || req.query?.appVersion || config.appVersion || '',
  ).slice(0, 40);
  return applyControlPlanePolicy(entitlement, {
    appVersion,
    downloadUrl: getUpdateDownloadUrl(req),
  }).entitlement;
}

/**
 * Resolve AI entitlement for a request (local store and/or remote control plane).
 * Same gate for AI search and WhatsApp GPT: account → 14-day trial → pay.
 */
export async function resolveSearchEntitlement(req, store) {
  if (!isLicenseGateEnabled()) {
    return { allowed: true, plan: 'open', status: 'disabled_gate', reason: null };
  }

  const installId = String(
    req.get('x-install-id') || req.body?.installId || req.query?.installId || '',
  ).trim();
  const licenseHeader = String(req.get('x-license-token') || '').trim();
  const secret = getServerSecret();
  const appVersion = String(
    req.get('x-app-version') || req.query?.appVersion || config.appVersion || '',
  ).slice(0, 40);

  if (licenseHeader && secret) {
    const payload = verifyLicenseToken(licenseHeader, secret);
    const fromToken = entitlementFromTokenPayload(payload);
    if (fromToken.allowed) return withLocalPolicy(fromToken, req);
  }

  const remote = (config.controlPlaneUrl || '').replace(/\/$/, '');
  if (remote && installId) {
    try {
      const qs = new URLSearchParams({ installId });
      if (appVersion) qs.set('appVersion', appVersion);
      const url = `${remote}/api/control/license/status?${qs}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        return data.entitlement || evaluateEntitlement(null);
      }
    } catch (err) {
      console.warn('[entitlement] remote check failed:', err.message);
    }
  }

  if (store && installId) {
    return withLocalPolicy(evaluateEntitlement(store.getLicenseForInstall(installId)), req);
  }

  const strict = ['1', 'true', 'yes'].includes(
    String(process.env.LICENSE_GATE_STRICT || '').trim().toLowerCase(),
  );
  if (!strict && config.isDesktopApp && !installId) {
    // First paint before account modal — allow until UI sets install id.
    return withLocalPolicy(
      { allowed: true, plan: 'pending', status: 'pending_account', reason: null, trialEndsAt: null },
      req,
    );
  }

  return withLocalPolicy(
    { allowed: false, plan: 'none', status: 'missing', reason: 'account_required', trialEndsAt: null },
    req,
  );
}

/** Copy for 402 responses. `product` is `search` (classic AI search) or `gpt`. */
export function paywallErrorMessage(reason, product = 'search') {
  if (reason === 'account_locked') {
    return 'This Searchable account has been locked. Contact support if you think this is a mistake.';
  }
  if (reason === 'update_required') {
    return 'Please update Searchable to continue using Pro features.';
  }
  const expired = reason === 'trial_expired';
  if (product === 'gpt') {
    return expired
      ? 'Your Pro trial has ended — subscribe to continue WhatsApp GPT'
      : 'WhatsApp GPT requires a Searchable account';
  }
  return expired
    ? 'Your Pro trial has ended — subscribe to continue AI search'
    : 'AI search requires a Searchable account';
}

export function paywallResponse(res, entitlement, store, installId, { product = 'search' } = {}) {
  store?.logProductEvent?.({
    event: 'paywall_shown',
    installId: installId || null,
    props: { reason: entitlement.reason, product },
  });
  void capturePostHog('paywall_shown', {
    distinctId: installId || 'anonymous',
    properties: { reason: entitlement.reason, product },
  });
  return res.status(402).json({
    error: paywallErrorMessage(entitlement.reason, product),
    code: entitlement.reason || 'not_entitled',
    entitlement,
  });
}
