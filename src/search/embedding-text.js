import { createHash } from 'crypto';

/** Same placeholder pattern as media-index fallback (`[image]`, `[audio]`). */
const PLACEHOLDER = /^\[[\w\s]+\]$/;

/**
 * Text actually sent to the encoder. Empty string means skip (no retry until source changes).
 */
export function embeddableText(row) {
  const body = String(row?.text || '').trim();
  const caption = String(row?.mediaCaption || '').trim();
  const ai = String(row?.mediaAiIndex || '').trim();
  const parts = [];
  if (body && !PLACEHOLDER.test(body)) parts.push(body);
  if (caption) parts.push(caption);
  if (ai) parts.push(ai);
  return parts.join('\n').trim();
}

export function embeddingSourceHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}
