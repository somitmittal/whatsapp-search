/**
 * Audio send payloads — shared by file attach and WhatsApp voice notes.
 *
 * A voice note is WhatsApp's push-to-talk (PTT) message: rendered with a play
 * button and waveform. It needs `ptt: true` on the Baileys audio content.
 * Browser MediaRecorder produces `audio/mp4` (AAC — accepted by WhatsApp on all
 * clients) or `audio/webm` (opus) as a fallback; both are fine to upload as a
 * plain audio attachment even though webm may not render as PTT everywhere.
 */

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // WhatsApp audio media limit

export const VOICE_RECORDING_MIME_CANDIDATES = [
  'audio/mp4', // AAC — preferred: WhatsApp voice notes accept m4a/aac everywhere
  'audio/webm;codecs=opus',
  'audio/webm',
];

export function isAudioMime(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  return m.startsWith('audio/') || m === 'application/ogg';
}

/** Small filename extension for an audio URL/blob name (not a security check). */
export function audioFileExt(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('amr')) return 'amr';
  if (m.includes('flac')) return 'flac';
  return 'webm';
}

/**
 * Build the Baileys audio message content.
 * @param {Buffer} buffer
 * @param {{ mimeType?: string, ptt?: boolean }} options
 * @returns {{ content?: object, error?: string }}
 */
export function audioSendContent(buffer, { mimeType = '', ptt = false } = {}) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length === 0) {
    return { error: 'File is empty' };
  }
  const mime = String(mimeType || '').toLowerCase();
  if (!isAudioMime(mime)) return { error: 'Not an audio file' };
  if (buffer.length > MAX_AUDIO_BYTES) {
    return { error: 'Audio is too large (max 16 MB for WhatsApp audio)' };
  }
  return {
    content: {
      audio: buffer,
      // WhatsApp renders webm unreliably on some clients — carry the truth but
      // default to an accepted container when the mime is missing.
      mimetype: mime.includes('webm') ? mime : (mime || 'audio/mp4'),
      ...(ptt ? { ptt: true } : {}),
    },
  };
}
