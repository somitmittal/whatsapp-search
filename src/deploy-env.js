/**
 * Hosted deploy detection (Render, Vercel, or explicit public URL).
 * Desktop / local leave these unset.
 */

export function isPublicInternetDeploy() {
  return process.env.RENDER === 'true'
    || process.env.VERCEL === '1'
    || Boolean(String(process.env.RENDER_EXTERNAL_URL || '').trim())
    || Boolean(String(process.env.VERCEL_URL || '').trim());
}

/** Canonical https origin for magic links, CORS, download redirects. */
export function publicDeployBaseUrl() {
  const explicit = (
    process.env.CONTROL_PLANE_PUBLIC_URL
    || process.env.PUBLIC_WEB_URL
    || process.env.RENDER_EXTERNAL_URL
    || ''
  ).trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const vercel = String(process.env.VERCEL_URL || '').trim();
  if (vercel) {
    const withProto = vercel.startsWith('http://') || vercel.startsWith('https://')
      ? vercel
      : `https://${vercel}`;
    return withProto.replace(/\/$/, '');
  }
  return '';
}
