/**
 * Speech → text provider selection for voice input (Ask AI dictation).
 *
 * Only some providers have real ASR (Gemini inline audio, Groq Whisper,
 * OpenAI Whisper). The others implement `transcribeAudio` but return a
 * "[Audio transcription not supported …]" placeholder. Tries configured
 * providers in cheapest-first order and returns the first usable one.
 */

export const TRANSCRIBE_PROVIDER_ORDER = ['gemini', 'groq', 'openai'];

/** Detects the placeholder string non-ASR providers return. */
export function isUsableTranscription(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return !/^\[.*(not\s+.*supported|un\s?supported)/i.test(t);
}

/**
 * Walk the provider list, skipping ones without a configured key.
 * @param {(id: string) => Promise<{ provider: object }>} factory async (id) => provider instance
 * @returns {Promise<{ provider: object, id: string } | null>}
 */
export async function findTranscriptionProvider(factory) {
  for (const id of TRANSCRIBE_PROVIDER_ORDER) {
    let instance;
    try {
      const created = await factory(id);
      instance = created && typeof created === 'object' && 'provider' in created ? created.provider : created;
    } catch {
      continue; // no key / provider unavailable — try the next one
    }
    if (instance && typeof instance.transcribeAudio === 'function') {
      return { provider: instance, id };
    }
  }
  return null;
}
