/**
 * Optional PostHog capture for product funnel events.
 * Set POSTHOG_API_KEY (+ optional POSTHOG_HOST). Failures are logged, never thrown to callers.
 */

const DEFAULT_HOST = 'https://us.i.posthog.com';

export function isPostHogEnabled() {
  return Boolean((process.env.POSTHOG_API_KEY || '').trim());
}

/**
 * @param {string} event
 * @param {{ distinctId?: string, properties?: Record<string, unknown> }} [opts]
 */
export async function capturePostHog(event, opts = {}) {
  const apiKey = (process.env.POSTHOG_API_KEY || '').trim();
  if (!apiKey) return { ok: false, skipped: true };
  const host = (process.env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/$/, '');
  const distinctId = opts.distinctId || opts.properties?.installId || opts.properties?.email || 'anonymous';
  try {
    const res = await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        distinct_id: distinctId,
        properties: {
          ...(opts.properties || {}),
          $lib: 'searchable-control-plane',
        },
        timestamp: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[posthog] ${event} failed: ${res.status} ${text.slice(0, 120)}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[posthog] ${event}:`, err.message);
    return { ok: false };
  }
}
