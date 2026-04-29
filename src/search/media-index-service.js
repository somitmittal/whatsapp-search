import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { basename, extname } from 'path';

const require = createRequire(import.meta.url);
/** Lazy-load pdf-parse (CommonJS) for PDF text extraction — searchable without vision LLM. */
function parsePdf(buffer) {
  const fn = require('pdf-parse');
  return fn(buffer);
}

function guessMimeForFile(mediaType, filePath) {
  const ext = extname(filePath || '').toLowerCase();
  if (mediaType === 'audio') {
    if (ext === '.mp3' || ext === '.mpeg') return 'audio/mpeg';
    if (ext === '.wav') return 'audio/wav';
    if (ext === '.m4a') return 'audio/mp4';
    return 'audio/ogg';
  }
  if (mediaType === 'sticker' || ext === '.webp') return 'image/webp';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.pdf') return 'application/pdf';
  return 'image/jpeg';
}

function isUnsupportedProviderOutput(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.startsWith('[') && /not supported|not available|use .* for media/i.test(t)) return true;
  return false;
}

/**
 * Background caption + transcription + PDF text extraction so FTS / fuzzy search can find
 * images, audio, stickers, and document contents (PDF body + filenames).
 */
export default class MediaIndexService {
  constructor({ db, getProvider }) {
    this._db = db;
    this._getProvider = getProvider;
    /** Set from WebServer when `/api/settings` updates the search LLM (same as SmartSearch). */
    this._overrideProvider = null;
    this._scheduled = null;
    this._running = false;
  }

  setProvider(provider) {
    this._overrideProvider = provider || null;
  }

  _activeProvider() {
    return this._overrideProvider ?? this._getProvider?.() ?? null;
  }

  /** Debounced kick after new rows or path updates. */
  scheduleProcess() {
    if (this._scheduled) clearTimeout(this._scheduled);
    this._scheduled = setTimeout(() => {
      this._scheduled = null;
      this.processPending().catch((e) => console.warn('[MediaIndex]', e.message));
    }, 1500);
  }

  async processPending(limit = 8) {
    if (this._running) return 0;

    this._running = true;
    let done = 0;
    try {
      const jobs = this._db.getPendingMediaIndexJobs(limit);
      for (const job of jobs) {
        const ok = await this._indexOne(job);
        if (ok) done += 1;
      }
    } finally {
      this._running = false;
    }
    if (done > 0) {
      console.log(`[MediaIndex] Indexed ${done} media item(s)`);
    }
    return done;
  }

  /**
   * PDF and non-PDF docs: extract text where possible; always include basename for FTS.
   */
  async _indexDocument(messageId, mediaPath, buffer) {
    const fn = basename(mediaPath || '');
    const ext = extname(mediaPath || '').toLowerCase();
    let body = '';
    if (ext === '.pdf' && buffer?.length) {
      try {
        const data = await parsePdf(buffer);
        body = String(data?.text || '').replace(/\s+/g, ' ').trim();
      } catch (e) {
        console.warn(`[MediaIndex] PDF parse ${messageId}:`, e.message);
      }
    }
    const combined = [fn, body].filter(Boolean).join('\n').trim().slice(0, 12000);
    this._db.updateMediaAiIndex(messageId, combined || fn || '');
    return true;
  }

  async _indexOne(job) {
    const provider = this._activeProvider();
    const { messageId, mediaType, mediaPath } = job;
    if (!messageId || !mediaPath) {
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }

    if (mediaType === 'video') {
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }

    let buffer;
    try {
      buffer = readFileSync(mediaPath);
    } catch (e) {
      console.warn(`[MediaIndex] read ${mediaPath}:`, e.message);
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }

    if (mediaType === 'document') {
      return this._indexDocument(messageId, mediaPath, buffer);
    }

    if (!provider || typeof provider.caption !== 'function') {
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }

    const b64 = buffer.toString('base64');
    const mime = guessMimeForFile(mediaType, mediaPath);

    try {
      let text = '';
      if (mediaType === 'audio') {
        if (typeof provider.transcribeAudio === 'function') {
          text = await provider.transcribeAudio(b64, mime);
        }
      } else {
        text = await provider.caption(b64, mime);
      }

      if (isUnsupportedProviderOutput(text)) {
        this._db.updateMediaAiIndex(messageId, '');
        return false;
      }

      const cleaned = String(text).trim().slice(0, 8000);
      this._db.updateMediaAiIndex(messageId, cleaned);
      return true;
    } catch (e) {
      console.warn(`[MediaIndex] LLM ${messageId}:`, e.message);
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }
  }
}
