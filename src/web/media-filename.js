/**
 * Content-Type + download filename helpers for `/api/message-media`.
 * Phones pick the handler from the filename extension — it must match the bytes served.
 */
import { basename } from 'path';

const EXT_CONTENT_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};

/** Filename extensions we recognize in captions / message text for downloads. */
const HINT_FILENAME_RE =
  /([^/\\\s][^/\\]*\.(?:xlsx|xls|csv|pdf|docx?|png|jpe?g|webp|gif|mp4|m4a|mp3|ogg|oga|opus|aac|wav|flac|webm|mov|bin))\b/i;

export function contentTypeForMediaFile(filePath) {
  const ext = (String(filePath).split('.').pop() || '').toLowerCase();
  return EXT_CONTENT_TYPES[ext] || 'application/octet-stream';
}

/** Prefer a human filename from caption/text when the on-disk name is a Baileys `.bin`. */
export function attachmentFilenameFromMessage(absPath, messageId, hintText = '') {
  const fromHint = String(hintText || '').match(HINT_FILENAME_RE)?.[1];
  let base = basename(String(fromHint || absPath || ''));
  if (!base || base === '.' || base === '..' || /\.bin$/i.test(base)) {
    const labeled = String(hintText || '').trim().split(/[\n\r]/)[0].slice(0, 120);
    if (labeled && !/^\[/.test(labeled)) {
      base = labeled.replace(/[^\x20-\x7E]/g, '_').replace(/["\\/]/g, '_') || base;
    }
  }
  if (!base || base === '.' || base === '..') {
    base = `whatsapp-media-${String(messageId || 'file').slice(0, 40)}`;
  }
  return base.replace(/[^\x20-\x7E]/g, '_').replace(/["\\\r\n]/g, '_').slice(0, 180) || 'download.bin';
}

/**
 * Download name for the bytes actually streamed. Voice notes often live on disk as
 * `.mp4` (audio in an MP4 container) or as a cached `.play.m4a` — phones need an
 * audio extension or they refuse to open the file.
 */
export function downloadFilenameForServedMedia({
  fname,
  servePath,
  originalPath,
  mediaType,
  contentType,
} = {}) {
  let dlName = String(fname || 'download.bin');
  const serve = String(servePath || '');
  const original = String(originalPath || '');
  if (serve && original && serve !== original) {
    const serveExt = (serve.split('.').pop() || 'bin').toLowerCase();
    const dot = dlName.lastIndexOf('.');
    dlName = dot > 0 ? `${dlName.slice(0, dot)}.${serveExt}` : `${dlName}.${serveExt}`;
  }
  const isAudio = mediaType === 'audio' || mediaType === 'ptt';
  const type = String(contentType || '').toLowerCase();
  if (isAudio && (/\.mp4$/i.test(dlName) || type === 'audio/mp4' || type.startsWith('audio/'))) {
    // Never leave voice notes with a .mp4 name — iOS/Android treat that as video.
    if (/\.mp4$/i.test(dlName) || !/\.(m4a|mp3|ogg|oga|opus|aac|wav|flac|webm)$/i.test(dlName)) {
      const dot = dlName.lastIndexOf('.');
      const stem = dot > 0 ? dlName.slice(0, dot) : dlName;
      if (type.includes('mpeg') || type.includes('mp3')) dlName = `${stem}.mp3`;
      else if (type.includes('ogg') || type.includes('opus')) dlName = `${stem}.ogg`;
      else if (type.includes('wav')) dlName = `${stem}.wav`;
      else if (type.includes('webm')) dlName = `${stem}.webm`;
      else dlName = `${stem}.m4a`;
    }
  }
  return dlName;
}
