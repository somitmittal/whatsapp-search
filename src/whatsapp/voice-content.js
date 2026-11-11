/**
 * Audio send payloads — shared by file attach, message forward, and WhatsApp voice notes.
 *
 * A voice note is WhatsApp's push-to-talk (PTT) message (`ptt: true`): phones expect
 * mono Ogg Opus (`audio/ogg; codecs=opus`) with duration (`seconds`) and `waveform`.
 * Non-PTT audio attachments expect MP3 (`audio/mpeg`) or AAC M4A (`audio/mp4`).
 * Browser `MediaRecorder` on Chromium/macOS produces Opus inside `audio/mp4` or
 * `audio/webm`, which `prepareOutboundAudioForWhatsApp` normalizes before send.
 */

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // WhatsApp audio media limit

export const VOICE_RECORDING_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

const AUDIO_EXT_MIMES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  m4r: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wave: 'audio/wav',
  flac: 'audio/flac',
  amr: 'audio/amr',
  weba: 'audio/webm',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  caf: 'audio/x-caf',
  wma: 'audio/x-ms-wma',
  '3ga': 'audio/3gpp',
};

export function isAudioMime(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  return m.startsWith('audio/') || m === 'application/ogg';
}

/** Normalize browser-specific audio MIME variants to standard WhatsApp-compatible MIMEs. */
export function normalizeAudioMime(mimeType) {
  const raw = String(mimeType || '').trim();
  const m = raw.toLowerCase();
  if (!m) return '';
  if (m === 'audio/x-m4a' || m === 'audio/m4a' || m === 'audio/mp4a-latm' || m === 'audio/x-mp4') {
    return 'audio/mp4';
  }
  if (m === 'audio/mp3' || m === 'audio/x-mp3' || m === 'audio/x-mpeg' || m === 'audio/mpeg3') {
    return 'audio/mpeg';
  }
  if (m === 'audio/x-wav' || m === 'audio/wave' || m === 'audio/vnd.wave') {
    return 'audio/wav';
  }
  if (m === 'audio/x-flac') return 'audio/flac';
  if (m === 'audio/x-aac') return 'audio/aac';
  if (m === 'application/ogg') return 'audio/ogg';
  return m;
}

/** Infer audio MIME from unambiguous audio-only file extensions when upload MIME is missing/generic. */
export function inferAudioMimeFromFilename(fileName) {
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
  return AUDIO_EXT_MIMES[ext] || '';
}

/** Small filename extension for an audio URL/blob name (not a security check). */
export function audioFileExt(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg') || (m.includes('opus') && !m.includes('webm'))) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('amr')) return 'amr';
  if (m.includes('flac')) return 'flac';
  if (m.includes('aiff')) return 'aiff';
  if (m.includes('caf')) return 'caf';
  return 'webm';
}

/**
 * Build the Baileys audio message content.
 * @param {Buffer} buffer
 * @param {{ mimeType?: string, ptt?: boolean, seconds?: number, waveform?: Uint8Array }} options
 * @returns {{ content?: object, error?: string }}
 */
export function audioSendContent(buffer, { mimeType = '', ptt = false, seconds, waveform } = {}) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length === 0) {
    return { error: 'File is empty' };
  }
  const mime = normalizeAudioMime(mimeType);
  if (!isAudioMime(mime)) return { error: 'Not an audio file' };
  if (buffer.length > MAX_AUDIO_BYTES) {
    return { error: 'Audio is too large (max 16 MB for WhatsApp audio)' };
  }
  const dur = Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds)) : undefined;
  const wf = ptt && waveform instanceof Uint8Array && waveform.length > 0 ? waveform : undefined;
  return {
    content: {
      audio: buffer,
      mimetype: mime.includes('webm') ? mime : (mime || 'audio/mp4'),
      ...(ptt ? { ptt: true } : {}),
      ...(dur ? { seconds: dur } : {}),
      ...(wf ? { waveform: wf } : {}),
    },
  };
}
