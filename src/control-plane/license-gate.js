import { isJwtAuthEnabled } from '../auth/jwt-util.js';

export function isLicenseGateEnabled() {
  const raw = String(process.env.LICENSE_GATE || '').trim().toLowerCase();
  if (['0', 'false', 'no'].includes(raw)) {
    return false;
  }
  const hasHostedPlane = Boolean(
    (process.env.CONTROL_PLANE_PUBLIC_URL || process.env.CONTROL_PLANE_URL || '').trim(),
  );
  // Explicit on only sticks when a hosted control plane exists. Desktop builds with an
  // empty CONTROL_PLANE_URL used to bake LICENSE_GATE=1 and block GPT with no signup host.
  if (['1', 'true', 'yes'].includes(raw)) {
    return hasHostedPlane || String(process.env.DESKTOP_APP || '').trim() !== '1';
  }
  return isJwtAuthEnabled() || hasHostedPlane;
}
