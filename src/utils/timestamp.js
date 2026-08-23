/** Normalize timestamps at system boundaries; internally we use Unix seconds. */
export function normalizeUnixSeconds(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n > 1e12 ? n / 1000 : n);
}

export function dateFromUnix(value) {
  const seconds = normalizeUnixSeconds(value);
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}
