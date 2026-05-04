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
 * Searchable text when vision/transcription APIs are unavailable or return nothing.
 * Uses WhatsApp caption, non-placeholder message text, filename, and media type.
 */
export function buildFallbackMediaIndex(job) {
  const fn = basename(job.mediaPath || '');
  const cap = String(job.mediaCaption || '').trim();
  const rawText = String(job.text || '').trim();
  const txt = rawText && !/^\[[\w\s]+\]$/.test(rawText) ? rawText : '';
  const type = job.mediaType ? String(job.mediaType) : '';
  const parts = [cap, txt, fn].filter(Boolean);
  let s = parts.join(' ').trim();
  if (!s && fn) s = `${type ? `${type} ` : ''}${fn}`.trim();
  if (!s && type) s = `[${type}]`;
  return s.slice(0, 8000);
}

/** Providers where raw video bytes work with the same multimodal endpoint as images. */
function providerSupportsInlineVideoCaption(provider) {
  return provider?.name === 'gemini';
}

/**
 * Background caption + transcription + PDF text extraction so FTS / fuzzy search can find
 * images, video, audio, stickers, and documents (PDF body + filenames).
 */
export default class MediaIndexService {
  constructor({ db, getProvider, getPriorityChatJid = null }) {
    this._db = db;
    this._getProvider = getProvider;
    /** @type {(() => string|null)|null} */
    this._getPriorityChatJid = typeof getPriorityChatJid === 'function' ? getPriorityChatJid : null;
    /** Set from WebServer when `/api/settings` updates the search LLM (same as SmartSearch). */
    this._overrideProvider = null;
    this._scheduled = null;
    this._running = false;
    /** Exit current batch early so the next run picks jobs for the user’s priority chat first. */
    this._preemptRequested = false;
  }

  /** Call when the user picks a priority chat (same as thread-summary priority). */
  notePriorityChange() {
    this._preemptRequested = true;
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

  async processPending(limit = 12) {
    if (this._running) {
      this._preemptRequested = true;
      return 0;
    }

    this._running = true;
    let done = 0;
    let brokeEarly = false;
    try {
      const prio = this._getPriorityChatJid?.() ?? null;
      const jobs = this._db.getPendingMediaIndexJobs(limit, prio);
      for (const job of jobs) {
        if (this._preemptRequested) {
          brokeEarly = true;
          break;
        }
        const ok = await this._indexOne(job);
        if (ok) done += 1;
      }
    } finally {
      this._preemptRequested = false;
      this._running = false;
    }
    if (done > 0) {
      console.log(`[MediaIndex] Indexed ${done} media item(s)`);
    }
    if (brokeEarly) {
      this.scheduleProcess();
    }
    return done;
  }

  /**
   * PDF and non-PDF docs: extract text where possible; always include basename + caption for FTS.
   */
  async _indexDocument(messageId, mediaPath, buffer, mediaCaption = '') {
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
    const cap = String(mediaCaption || '').trim();
    const combined = [cap, fn, body].filter(Boolean).join('\n').trim().slice(0, 12000);
    this._db.updateMediaAiIndex(messageId, combined || fn || cap || '');
    return true;
  }

  async _indexOne(job) {
    const provider = this._activeProvider();
    const { messageId, mediaType, mediaPath } = job;
    const fallback = buildFallbackMediaIndex(job);

    if (!messageId || !mediaPath) {
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }

    let buffer;
    try {
      buffer = readFileSync(mediaPath);
    } catch (e) {
      console.warn(`[MediaIndex] read ${mediaPath}:`, e.message);
      if (fallback) {
        this._db.updateMediaAiIndex(messageId, fallback);
        return true;
      }
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }

    if (mediaType === 'document') {
      return this._indexDocument(messageId, mediaPath, buffer, job.mediaCaption);
    }

    const b64 = buffer.toString('base64');
    const mime = guessMimeForFile(mediaType, mediaPath);

    let aiText = '';

    try {
      if (mediaType === 'audio') {
        if (provider && typeof provider.transcribeAudio === 'function') {
          aiText = await provider.transcribeAudio(b64, mime);
        }
      } else if (mediaType === 'video') {
        if (providerSupportsInlineVideoCaption(provider) && typeof provider.caption === 'function') {
          aiText = await provider.caption(b64, mime);
        }
      } else if ((mediaType === 'image' || mediaType === 'sticker') && provider && typeof provider.caption === 'function') {
        aiText = await provider.caption(b64, mime);
      }
    } catch (e) {
      console.warn(`[MediaIndex] LLM ${messageId}:`, e.message);
    }

    if (isUnsupportedProviderOutput(aiText)) {
      aiText = '';
    } else {
      aiText = String(aiText || '').trim();
    }

    let finalText = (aiText || '').trim();
    const fb = (fallback || '').trim();
    if (fb && !finalText.includes(fb.slice(0, Math.min(80, fb.length)))) {
      finalText = finalText ? `${finalText}\n${fb}` : fb;
    }
    finalText = finalText.trim().slice(0, 12000);

    if (!finalText) {
      this._db.updateMediaAiIndex(messageId, '');
      return false;
    }

    this._db.updateMediaAiIndex(messageId, finalText);
    return true;
  }
}
