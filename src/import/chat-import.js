import { createRequire } from 'module';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import config from '../config.js';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

/**
 * Decodes raw bytes from a WhatsApp export (.txt inside .zip or plain .txt upload).
 * Handles UTF-8, UTF-8 BOM, UTF-16 LE (with or without BOM), and UTF-16-like null-heavy buffers.
 */
export function decodeExportBuffer(buf) {
  if (!buf) return '';
  if (!Buffer.isBuffer(buf)) {
    if (buf instanceof Uint8Array) return decodeExportBuffer(Buffer.from(buf));
    return String(buf);
  }
  if (buf.length === 0) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  const sampleLen = Math.min(buf.length, 16000);
  let nuls = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) nuls += 1;
  }
  if (sampleLen > 80 && nuls / sampleLen > 0.08) {
    let s = buf.toString('utf16le');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }
  return buf.toString('utf8');
}

/** Between calendar date and clock time (locale variants). */
const DATE_TIME_GAP =
  String.raw`(?:,\s*|\s+at\s+|\s+às\s+|\s+à\s+|\s*[-–\u2013\u2014\u2212]\s*|\s+)`;

/**
 * Clock: 14:30, 14:30:22, 14:30 PM, 2:30PM, 14.30, 14.30.22 (EU-style dots)
 */
const TIME_CORE =
  String.raw`\d{1,2}(?:[:.])\d{2}(?:(?:[:.])\d{2})?(?:\s*(?:[APap]\.?[Mm]\.?|(?<=[0-9])(?:[APap][Mm])))?`;

const EXPORT_LINE_PATTERNS = [
  new RegExp(
    String.raw`^(\d{4}[/.-]\d{1,2}[/.-]\d{1,2})${DATE_TIME_GAP}(${TIME_CORE})\]?\s*(?:[-–\u2013\u2014\u2212]\s*)?(.+?):\s(.*)$`,
    'iu',
  ),
  new RegExp(
    String.raw`^\[?(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})${DATE_TIME_GAP}(${TIME_CORE})\]?\s*(?:[-–\u2013\u2014\u2212]\s*)?(.+?):\s(.*)$`,
    'iu',
  ),
];

const WA_LAUNCH_TS = Math.floor(new Date('2009-01-09T00:00:00Z').getTime() / 1000);

/**
 * @param {number[]} timestamps unix seconds
 */
function scoreParsedTimestamps(timestamps) {
  const now = Math.floor(Date.now() / 1000);
  let score = 0;
  for (const ts of timestamps) {
    if (!ts) continue;
    if (ts > now + 86400 * 2) score -= 5;
    else if (ts < WA_LAUNCH_TS) score -= 2;
    else score += 1;
  }
  return score;
}

function applyDateParts(a, b, c, order) {
  let year;
  let month;
  let day;

  if (a >= 100 && a < 10000) {
    year = a;
    month = b;
    day = c;
  } else if (c >= 100) {
    year = c;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else if (order === 'DMY') {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
  } else {
    year = c;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else if (order === 'DMY') {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
    if (year < 100) year += 2000;
  }

  return { year, month, day };
}

/**
 * @param {string} dateStr
 * @param {string} timeStr
 * @param {'DMY' | 'MDY'} [order='DMY']
 * @returns {number} unix timestamp in seconds
 */
export function parseTimestamp(dateStr, timeStr, order = 'DMY') {
  const parts = String(dateStr)
    .split(/[/.\-]/)
    .map((p) => Number(String(p).trim()));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 0;

  const [a, b, c] = parts;
  const { year, month, day } = applyDateParts(a, b, c, order);

  let timeToParse = String(timeStr || '')
    .trim()
    .replace(/\u202f/g, ' ')
    .replace(/\u00a0/g, ' ');
  const isPM = /\bpm\b|p\.?\s*m\b/i.test(timeToParse);
  const isAM = /\bam\b|a\.?\s*m\b/i.test(timeToParse);
  timeToParse = timeToParse.replace(/\b[APap]\.?\s*[Mm]\.?/gi, '').trim();

  const sep = timeToParse.includes(':') ? ':' : timeToParse.includes('.') ? '.' : ':';
  const timeParts = timeToParse.split(sep).map(Number);
  let hours = timeParts[0];
  const minutes = timeParts[1] || 0;
  const seconds = timeParts[2] || 0;

  if (!Number.isFinite(hours)) return 0;

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  const date = new Date(year, month - 1, day, hours, minutes, seconds);
  const t = Math.floor(date.getTime() / 1000);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pick DD/MM vs MM/DD for ambiguous dates (e.g. 01/12/2025).
 * @param {string} content
 * @returns {'DMY' | 'MDY'}
 */
export function detectImportDateOrder(content) {
  const forced = config.importDateOrder;
  if (forced === 'DMY' || forced === 'MDY') return forced;

  const lines = String(content || '').split(/\r?\n/);
  const ambiguous = [];
  for (const rawLine of lines) {
    const m = matchExportLine(normalizeExportLine(rawLine));
    if (!m) continue;
    const dateStr = m[1];
    const parts = dateStr.split(/[/.\-]/).map((p) => Number(String(p).trim()));
    if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) continue;
    const [a, b] = parts;
    if (a > 12 || b > 12) continue;
    ambiguous.push(dateStr);
    if (ambiguous.length >= 100) break;
  }

  if (ambiguous.length < 2) return 'DMY';

  const dmy = ambiguous.map((d) => parseTimestamp(d, '12:00', 'DMY'));
  const mdy = ambiguous.map((d) => parseTimestamp(d, '12:00', 'MDY'));
  return scoreParsedTimestamps(dmy) >= scoreParsedTimestamps(mdy) ? 'DMY' : 'MDY';
}

function normalizeExportLine(raw) {
  return String(raw || '')
    .replace(/\u200e|\u200f/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u202f/g, ' ');
}

function matchExportLine(line) {
  for (const re of EXPORT_LINE_PATTERNS) {
    const m = line.match(re);
    if (m) return m;
  }
  return null;
}

/**
 * First non-empty lines for troubleshooting when parse yields 0 messages (no PII beyond export).
 */
export function summarizeExportHead(text, maxLen = 480) {
  const body = String(text || '').replace(/\u200e|\u200f/g, '');
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(0, 8);
  const joined = lines.join('\n').slice(0, maxLen);
  return joined || '(file empty or only blank lines)';
}

/**
 * @param {string} content  raw text content of the exported .txt file
 * @param {string} chatName  name to assign to this chat
 * @returns {{ messages: Array<{ sender: string, text: string, timestamp: number }>, chatName: string }}
 */
export function parseExportedChat(content, chatName) {
  let body = String(content || '');
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);

  const dateOrder = detectImportDateOrder(body);
  const lines = body.split(/\r?\n/);
  const messages = [];
  /** @type {{ sender: string, text: string, timestamp: number } | null} */
  let current = null;

  for (const rawLine of lines) {
    const line = normalizeExportLine(rawLine);
    const match = matchExportLine(line);
    if (match) {
      if (current && current.text.trim()) {
        messages.push(current);
      }
      const [, dateStr, timeStr, sender, text] = match;
      current = {
        sender: sender.trim(),
        text: (text || '').trim(),
        timestamp: parseTimestamp(dateStr, timeStr, dateOrder),
      };
    } else if (current) {
      current.text += '\n' + rawLine;
    }
  }

  if (current && current.text.trim()) {
    messages.push(current);
  }

  return { messages, chatName };
}

// ── Media helpers ──────────────────────────────────────────────────────────────

const MEDIA_EXTS = {
  image: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']),
  video: new Set(['mp4', 'mov', 'avi', 'mkv', '3gp']),
  audio: new Set(['opus', 'ogg', 'mp3', 'm4a', 'aac', 'wav', 'amr']),
  sticker: new Set(['webp']),
  document: new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip']),
};

function mediaTypeFromExt(ext) {
  const e = (ext || '').toLowerCase().replace(/^\./, '');
  if (MEDIA_EXTS.image.has(e)) return 'image';
  if (MEDIA_EXTS.video.has(e)) return 'video';
  if (MEDIA_EXTS.audio.has(e)) return 'audio';
  if (MEDIA_EXTS.document.has(e)) return 'document';
  return null;
}

function mediaTypeFromFilename(name) {
  const n = (name || '').toUpperCase();
  if (n.startsWith('IMG-') || n.startsWith('PHOTO-')) return 'image';
  if (n.startsWith('VID-') || n.startsWith('VIDEO-')) return 'video';
  if (n.startsWith('PTT-') || n.startsWith('AUD-')) return 'audio';
  if (n.startsWith('STK-')) return 'sticker';
  if (n.startsWith('DOC-')) return 'document';
  return mediaTypeFromExt(extname(name));
}

/**
 * Patterns WhatsApp uses to reference attached media in the chat .txt:
 *   "IMG-20240101-WA0001.jpg (file attached)"
 *   "<attached: 00000012-PHOTO.jpg>"
 *   "‎image omitted"  (no media file present)
 */
const ATTACHED_FILE_RE = /(\S+)\s*\(file attached\)/i;
const ATTACHED_TAG_RE = /<attached:\s*(.+?)>/i;
const MEDIA_EXT_RE = /\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|avi|mkv|3gp|opus|ogg|mp3|m4a|aac|wav|amr|pdf|doc[x]?|xls[x]?|ppt[x]?)$/i;

function extractAttachedFilename(text) {
  const t = (text || '').trim().replace(/\u200e|\u200f/g, '');
  let m = t.match(ATTACHED_TAG_RE);
  if (m) return m[1].trim();
  m = t.match(ATTACHED_FILE_RE);
  if (m) return m[1].trim();
  // Bare filename with a known media extension (some exports omit the wrapper text).
  if (MEDIA_EXT_RE.test(t) && !t.includes(' ')) return t;
  return null;
}

function safeJidDir(jid) {
  return String(jid || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/**
 * Extracts all non-txt files from a WhatsApp export ZIP and saves them to disk.
 * Returns a Map<lowercaseFilename, absolutePath> for matching against messages.
 */
export function extractMediaFromZip(zipBuffer, chatJid) {
  const zip = new AdmZip(zipBuffer);
  const mediaMap = new Map();
  const dir = join(config.mediaDir, safeJidDir(chatJid));

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;
    const lower = name.toLowerCase();
    if (lower.endsWith('.txt') || lower.includes('__macosx')) continue;

    const ext = extname(name).toLowerCase().replace(/^\./, '');
    const mtype = mediaTypeFromExt(ext);
    if (!mtype) continue;

    try {
      const buf = entry.getData();
      if (!buf || buf.length === 0) continue;
      mkdirSync(dir, { recursive: true });
      const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
      const fullPath = join(dir, safeName);
      if (!existsSync(fullPath)) writeFileSync(fullPath, buf);
      mediaMap.set(basename(name).toLowerCase(), { path: fullPath, type: mtype });
    } catch { /* skip corrupt entries */ }
  }

  return mediaMap;
}

/** Safe local part for synthetic import JID (WhatsApp-style @domain). */
export function slugForImportChatJid(name) {
  const s = String(name || 'chat')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s.-]/g, '_')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase();
  return (s || 'chat').slice(0, 120);
}

/**
 * @param {import('../storage/database.js').default} db
 * @param {string} content    raw .txt file content
 * @param {string} chatName   human-readable chat name
 * @param {Map<string, {path: string, type: string}>} [mediaMap]  filename→{path,type} from extractMediaFromZip
 * @returns {{ inserted: number, total: number, parsedCount?: number, parseFailed?: boolean, parseHead?: string, mediaCount?: number }}
 */
export function importExportedChat(db, content, chatName, mediaMap) {
  const { messages } = parseExportedChat(content, chatName);
  const trimmed = String(content || '').trim();
  if (messages.length === 0) {
    return {
      inserted: 0,
      total: 0,
      parsedCount: 0,
      parseFailed: trimmed.length > 0,
      parseHead: trimmed.length > 0 ? summarizeExportHead(content) : undefined,
    };
  }

  const slug = slugForImportChatJid(chatName);
  const chatJid = `import_${slug}@imported`;

  // Re-import replaces existing rows so date-parser fixes apply cleanly.
  if (typeof db.deleteChat === 'function') {
    db.deleteChat(chatJid);
  }

  let mediaCount = 0;

  // Build a set of media filenames for fast reverse-lookup in message text.
  const mediaFilenames = mediaMap && mediaMap.size > 0
    ? [...mediaMap.keys()]
    : [];

  const rows = messages.map((m, i) => {
    let mediaType = null;
    let mediaPath = null;

    if (mediaMap && mediaMap.size > 0) {
      const text = (m.text || '').trim();

      // 1. Try explicit attachment patterns first.
      const attachedFile = extractAttachedFilename(text);
      if (attachedFile) {
        const hit = mediaMap.get(attachedFile.toLowerCase());
        if (hit) {
          mediaType = hit.type;
          mediaPath = hit.path;
          mediaCount++;
        }
      }

      // 2. Reverse lookup: check if any media filename appears in the message text.
      if (!mediaPath) {
        const lower = text.toLowerCase();
        for (const fn of mediaFilenames) {
          if (lower.includes(fn)) {
            const hit = mediaMap.get(fn);
            mediaType = hit.type;
            mediaPath = hit.path;
            mediaCount++;
            break;
          }
        }
      }

      // 3. Detect media type from text even without a matching file (shows as pending).
      if (!mediaType && attachedFile) {
        mediaType = mediaTypeFromFilename(attachedFile);
      }
    }

    return {
      messageId: `imp_${chatJid}_${m.timestamp}_${i}`,
      chatJid,
      chatName,
      sender: m.sender,
      senderJid: `${m.sender.replace(/\s+/g, '_').toLowerCase()}@imported`,
      text: m.text,
      mediaType,
      mediaPath,
      mediaCaption: null,
      timestamp: m.timestamp,
    };
  });

  const touchedAt = Math.floor(Date.now() / 1000);
  if (typeof db.recordChatImportTouch === 'function') {
    db.recordChatImportTouch(chatJid, touchedAt);
  }
  const { count: inserted } = db.insertMessageBatch(rows);

  const lastMsgTs = rows.reduce((max, r) => Math.max(max, Number(r.timestamp) || 0), 0);

  // For re-imports: update media fields on rows that were skipped by INSERT OR IGNORE.
  let mediaLinked = 0;
  if (mediaMap && mediaMap.size > 0 && typeof db.updateMessageMedia === 'function') {
    for (const row of rows) {
      if (row.mediaPath) {
        const updated = db.updateMessageMedia(row.messageId, row.mediaType, row.mediaPath);
        if (updated) mediaLinked++;
      }
    }
  }

  return {
    inserted,
    total: messages.length,
    parsedCount: messages.length,
    chatJid,
    alreadyInDb: inserted === 0,
    lastMessageTs: lastMsgTs || touchedAt,
    mediaCount: mediaCount + mediaLinked,
  };
}

/**
 * Score .txt entries inside a WhatsApp export zip so we pick the real chat transcript,
 * not readme/small sidecar files (entry order in zips is not guaranteed).
 * @param {import('adm-zip').IZipEntry} e
 */
function scoreZipTxtEntry(e) {
  const name = (e.entryName || '').toLowerCase();
  let s = 0;
  if (name.includes('readme')) s -= 200;
  if (/_chat\.txt$/i.test(name) || name.endsWith('_chat.txt')) s += 120;
  if (name.includes('whatsapp chat')) s += 80;
  if (name.includes('chat with') || name.includes('chat -')) s += 40;
  const sz = typeof e.header?.size === 'number' ? e.header.size : 0;
  s += Math.min(60, Math.floor(sz / 50_000));
  return s;
}

/**
 * Extracts the chat .txt content from a WhatsApp exported .zip file.
 * Tries every .txt (decoded); picks the body that parses into the most messages (fixes wrong file / encoding).
 *
 * @param {Buffer} zipBuffer
 * @returns {string | null} text content of the chat file, or null if not found
 */
export function extractTextFromZip(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => {
    if (e.isDirectory) return false;
    const name = e.entryName.toLowerCase();
    return name.endsWith('.txt') && !name.includes('__macosx');
  });
  if (!entries.length) return null;

  let bestText = null;
  let bestCount = -1;
  for (const e of entries) {
    let text = '';
    try {
      text = decodeExportBuffer(e.getData());
    } catch {
      continue;
    }
    const n = parseExportedChat(text, '').messages.length;
    if (n > bestCount) {
      bestCount = n;
      bestText = text;
    }
  }

  if (bestCount > 0 && bestText) return bestText;

  entries.sort((a, b) => scoreZipTxtEntry(b) - scoreZipTxtEntry(a));
  try {
    return decodeExportBuffer(entries[0].getData());
  } catch {
    return null;
  }
}
