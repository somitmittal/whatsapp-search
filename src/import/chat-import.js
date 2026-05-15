import { createRequire } from 'module';

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

/**
 * @param {string} dateStr
 * @param {string} timeStr
 * @returns {number} unix timestamp in seconds
 */
function parseTimestamp(dateStr, timeStr) {
  const parts = String(dateStr)
    .split(/[/.\-]/)
    .map((p) => Number(String(p).trim()));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return 0;

  const [a, b, c] = parts;
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
    } else {
      month = a;
      day = b;
    }
    if (year < 100) year += 2000;
  }

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
        timestamp: parseTimestamp(dateStr, timeStr),
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
 * @returns {{ inserted: number, total: number, parsedCount?: number, parseFailed?: boolean, parseHead?: string }}
 */
export function importExportedChat(db, content, chatName) {
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

  const rows = messages.map((m, i) => ({
    messageId: `imp_${chatJid}_${m.timestamp}_${i}`,
    chatJid,
    chatName,
    sender: m.sender,
    senderJid: `${m.sender.replace(/\s+/g, '_').toLowerCase()}@imported`,
    text: m.text,
    mediaType: null,
    mediaPath: null,
    mediaCaption: null,
    timestamp: m.timestamp,
  }));

  const { count: inserted } = db.insertMessageBatch(rows);
  return { inserted, total: messages.length, parsedCount: messages.length };
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
