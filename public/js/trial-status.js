const DAY_MS = 86400000;

/**
 * Whole days remaining until trialEndsAt (ceil). 0 when expired. null when unknown.
 * `now` is injectable so tests do not depend on the clock.
 */
export function daysLeftInTrial(trialEndsAt, now = Date.now()) {
  if (!trialEndsAt) return null;
  const ends = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(ends)) return null;
  const ms = ends - now;
  if (ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

/** True when the entitlement says the trial is over (or days left is already 0). */
export function isTrialExpired(entitlement, now = Date.now()) {
  if (!entitlement) return false;
  if (entitlement.reason === 'trial_expired') return true;
  if (entitlement.plan === 'trial' || entitlement.status === 'trialing' || entitlement.status === 'expired') {
    const left = daysLeftInTrial(entitlement.trialEndsAt, now);
    return left === 0;
  }
  return false;
}

export function shouldAutoLogout(entitlement, now = Date.now()) {
  return isTrialExpired(entitlement, now);
}

/**
 * Short label for settings / topbar.
 * @returns {{ kind: 'none'|'trial'|'pro'|'expired'|'other', daysLeft: number|null, text: string }}
 */
export function accountPlanSummary(entitlement, { email = null } = {}, now = Date.now()) {
  if (!entitlement || entitlement.plan === 'none' || entitlement.reason === 'account_required') {
    return { kind: 'none', daysLeft: null, text: email ? 'Signed out of Pro features' : 'Not signed in' };
  }
  if (entitlement.plan === 'pro' && entitlement.allowed) {
    return { kind: 'pro', daysLeft: null, text: 'Pro' };
  }
  if (isTrialExpired(entitlement, now)) {
    return { kind: 'expired', daysLeft: 0, text: 'Trial ended' };
  }
  if (entitlement.plan === 'trial' || entitlement.status === 'trialing') {
    const daysLeft = daysLeftInTrial(entitlement.trialEndsAt, now);
    if (daysLeft == null) return { kind: 'trial', daysLeft: null, text: 'Pro trial' };
    if (daysLeft === 1) return { kind: 'trial', daysLeft: 1, text: '1 day left in trial' };
    return { kind: 'trial', daysLeft, text: `${daysLeft} days left in trial` };
  }
  return {
    kind: 'other',
    daysLeft: daysLeftInTrial(entitlement.trialEndsAt, now),
    text: entitlement.plan || 'Account',
  };
}

/** Ms until trialEndsAt, or 0 if already past. null if unknown. */
export function msUntilTrialEnds(trialEndsAt, now = Date.now()) {
  if (!trialEndsAt) return null;
  const ends = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(ends)) return null;
  return Math.max(0, ends - now);
}
