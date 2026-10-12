import { isJwtAuthEnabled } from '../auth/jwt-util.js';

export function isLicenseGateEnabled() {
  if (['0', 'false', 'no'].includes(String(process.env.LICENSE_GATE || '').trim().toLowerCase())) {
    return false;
  }
  if (['1', 'true', 'yes'].includes(String(process.env.LICENSE_GATE || '').trim().toLowerCase())) {
    return true;
  }
  return isJwtAuthEnabled() || Boolean((process.env.CONTROL_PLANE_PUBLIC_URL || process.env.CONTROL_PLANE_URL || '').trim());
}
