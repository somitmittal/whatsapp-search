/**
 * License entitlement helpers + HMAC license tokens for offline grace.
 * Chats never leave the device — this only encodes plan status.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const TRIAL_DAYS = 14;
const OFFLINE_GRACE_MS = 7 * 86400000;

export function trialDays() {
  return TRIAL_DAYS;
}

export function offlineGraceMs() {
  return OFFLINE_GRACE_MS;
}

/**
 * @param {{ plan?: string, status?: string, trial_ends_at?: string|null }} license
 */
export function evaluateEntitlement(license, now = Date.now()) {
  if (!license) {
    return {
      allowed: false,
      plan: 'none',
      status: 'missing',
      reason: 'account_required',
      trialEndsAt: null,
    };
  }
  const plan = license.plan || 'trial';
  const status = license.status || 'active';
  const trialEndsAt = license.trial_ends_at || null;

  // Remote lock from control-plane admin (or Stripe-driven disable).
  if (status === 'disabled' || status === 'revoked' || status === 'locked') {
    return {
      allowed: false,
      plan,
      status,
      reason: 'account_locked',
      trialEndsAt,
      message: license.lock_message || null,
    };
  }

  if (status === 'active' && (plan === 'pro' || plan === 'paid')) {
    return { allowed: true, plan: 'pro', status: 'active', reason: null, trialEndsAt };
  }
  if (status === 'trialing' || plan === 'trial') {
    const ends = trialEndsAt ? new Date(trialEndsAt).getTime() : 0;
    if (ends && ends >= now) {
      return { allowed: true, plan: 'trial', status: 'trialing', reason: null, trialEndsAt };
    }
    return {
      allowed: false,
      plan: 'trial',
      status: 'expired',
      reason: 'trial_expired',
      trialEndsAt,
    };
  }
  if (status === 'canceled' || status === 'past_due') {
    return { allowed: false, plan, status, reason: 'subscription_inactive', trialEndsAt };
  }
  return { allowed: false, plan, status, reason: 'not_entitled', trialEndsAt };
}

export function signLicenseToken(payload, secret) {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
  }), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyLicenseToken(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const issuedMs = (payload.iat || 0) * 1000;
  if (issuedMs && now - issuedMs > OFFLINE_GRACE_MS) {
    payload._stale = true;
  }
  return payload;
}

export function entitlementFromTokenPayload(payload, now = Date.now()) {
  if (!payload) {
    return evaluateEntitlement(null, now);
  }
  if (payload._stale) {
    return {
      allowed: false,
      plan: payload.plan || 'none',
      status: 'stale',
      reason: 'offline_grace_expired',
      trialEndsAt: payload.trialEndsAt || null,
    };
  }
  return evaluateEntitlement({
    plan: payload.plan,
    status: payload.status,
    trial_ends_at: payload.trialEndsAt,
  }, now);
}
