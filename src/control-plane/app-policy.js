/**
 * Hosted control-plane policy: force-update floor + lock messaging.
 * Set APP_MIN_VERSION on the Render control plane (e.g. 1.0.11).
 */

export function getAppMinVersion() {
  return String(process.env.APP_MIN_VERSION || '').trim().replace(/^v/i, '');
}

export function getUpdateDownloadUrl(req) {
  const fromEnv = (process.env.APP_UPDATE_DOWNLOAD_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const base = (
    process.env.CONTROL_PLANE_PUBLIC_URL
    || process.env.PUBLIC_WEB_URL
    || process.env.RENDER_EXTERNAL_URL
    || ''
  ).trim().replace(/\/$/, '');
  return base ? `${base}/download` : '/download';
}

/** Compare semver-ish strings (1.0.10 vs 1.0.9). Non-numeric parts ignored. */
export function compareAppVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isAppBelowMin(appVersion, minVersion = getAppMinVersion()) {
  const min = String(minVersion || '').trim();
  if (!min) return false;
  const cur = String(appVersion || '').trim();
  if (!cur) return true;
  return compareAppVersions(cur, min) < 0;
}

/**
 * Overlay force-update / lock onto an entitlement object.
 * @returns {{ entitlement: object, policy: object }}
 */
export function applyControlPlanePolicy(entitlement, {
  appVersion = '',
  downloadUrl = '/download',
  message = null,
} = {}) {
  const minAppVersion = getAppMinVersion() || null;
  const updateRequired = isAppBelowMin(appVersion, minAppVersion || '');
  const policy = {
    minAppVersion,
    updateRequired,
    downloadUrl,
    message: message || (updateRequired
      ? `Please update Searchable to version ${minAppVersion} or newer to continue.`
      : null),
  };
  let next = entitlement || {
    allowed: false,
    plan: 'none',
    status: 'missing',
    reason: 'account_required',
    trialEndsAt: null,
  };
  if (updateRequired) {
    next = {
      ...next,
      allowed: false,
      reason: 'update_required',
      minAppVersion,
      message: policy.message,
      downloadUrl,
    };
  }
  return { entitlement: next, policy };
}
