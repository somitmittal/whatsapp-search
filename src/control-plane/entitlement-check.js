import config from '../config.js';
import { evaluateEntitlement, entitlementFromTokenPayload, verifyLicenseToken } from './license.js';
import { getServerSecret } from '../auth/jwt-util.js';
import { isLicenseGateEnabled } from './license-gate.js';
import { capturePostHog } from './posthog.js';

/**
 * Resolve AI-search entitlement for a request (local store and/or remote control plane).
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

  if (licenseHeader && secret) {
    const payload = verifyLicenseToken(licenseHeader, secret);
    const fromToken = entitlementFromTokenPayload(payload);
    if (fromToken.allowed) return fromToken;
  }

  const remote = (config.controlPlaneUrl || '').replace(/\/$/, '');
  if (remote && installId) {
    try {
      const url = `${remote}/api/control/license/status?installId=${encodeURIComponent(installId)}`;
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
    const license = store.getLicenseForInstall(installId);
    return evaluateEntitlement(license);
  }

  const strict = ['1', 'true', 'yes'].includes(
    String(process.env.LICENSE_GATE_STRICT || '').trim().toLowerCase(),
  );
  if (!strict && config.isDesktopApp && !installId) {
    // First paint before account modal — allow until UI sets install id.
    return { allowed: true, plan: 'pending', status: 'pending_account', reason: null };
  }

  return { allowed: false, plan: 'none', status: 'missing', reason: 'account_required' };
}

export function paywallResponse(res, entitlement, store, installId) {
  store?.logProductEvent?.({
    event: 'paywall_shown',
    installId: installId || null,
    props: { reason: entitlement.reason },
  });
  void capturePostHog('paywall_shown', {
    distinctId: installId || 'anonymous',
    properties: { reason: entitlement.reason },
  });
  return res.status(402).json({
    error: entitlement.reason === 'trial_expired'
      ? 'Your Pro trial has ended — subscribe to continue AI search'
      : 'AI search requires a Searchable account',
    code: entitlement.reason || 'not_entitled',
    entitlement,
  });
}
