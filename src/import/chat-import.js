import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

/**
 * Parses a WhatsApp exported chat .txt file and returns structured messages.
 *
 * Supports common export formats:
 *   [M/D/YY, H:MM:SS AM] Sender: text
 *   [DD/MM/YYYY, HH:MM:SS] Sender: text
 *   M/D/YY, H:MM:SS AM - Sender: text
 *   DD/MM/YYYY, HH:MM:SS - Sender: text
 */

const LINE_REGEX =
  /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]?\s*[-–]?\s*(.+?):\s([\s\S]*)$/;

/**
 * @param {string} dateStr  e.g. "3/15/24" or "15/03/2024"
 * @param {string} timeStr  e.g. "4:23:56 PM" or "16:23:56"
 * @returns {number} unix timestamp in seconds
 */
function parseTimestamp(dateStr, timeStr) {
  const dateParts = dateStr.split('/').map(Number);
  let month, day, year;

  if (dateParts[0] > 12) {
    [day, month, year] = dateParts;
  } else if (dateParts[1] > 12) {
    [month, day, year] = dateParts;
  } else {
    [month, day, year] = dateParts;
  }

  if (year < 100) year += 2000;

  let timeToParse = timeStr.trim();
  const isPM = /pm/i.test(timeToParse);
  const isAM = /am/i.test(timeToParse);
  timeToParse = timeToParse.replace(/\s*[APap][Mm]\s*/g, '').trim();

  const timeParts = timeToParse.split(':').map(Number);
  let hours = timeParts[0];
  const minutes = timeParts[1] || 0;
  const seconds = timeParts[2] || 0;

  if (isPM && hours < 12) hours += 12;
  if (isAM && hours === 12) hours = 0;

  const date = new Date(year, month - 1, day, hours, minutes, seconds);
  return Math.floor(date.getTime() / 1000);
}

/**
 * @param {string} content  raw text content of the exported .txt file
 * @param {string} chatName  name to assign to this chat
 * @returns {{ messages: Array<{ sender: string, text: string, timestamp: number }>, chatName: string }}
 */
export function parseExportedChat(content, chatName) {
  const lines = content.split('\n');
  const messages = [];
  /** @type {{ sender: string, text: string, timestamp: number } | null} */
  let current = null;

  for (const line of lines) {
    const match = line.match(LINE_REGEX);
    if (match) {
      if (current && current.text.trim()) {
        messages.push(current);
      }
      const [, dateStr, timeStr, sender, text] = match;
      current = {
        sender: sender.trim(),
        text: text.trim(),
        timestamp: parseTimestamp(dateStr, timeStr),
      };
    } else if (current) {
      current.text += '\n' + line;
    }
  }

  if (current && current.text.trim()) {
    messages.push(current);
  }

  return { messages, chatName };
}

/**
 * @param {import('../storage/database.js').default} db
 * @param {string} content    raw .txt file content
 * @param {string} chatName   human-readable chat name
 * @returns {{ inserted: number, total: number }}
 */
export function importExportedChat(db, content, chatName) {
  const { messages } = parseExportedChat(content, chatName);
  if (messages.length === 0) return { inserted: 0, total: 0 };

  const chatJid = `import_${chatName.replace(/\s+/g, '_').toLowerCase()}@imported`;

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
  return { inserted, total: messages.length };
}

/**
 * Extracts the chat .txt content from a WhatsApp exported .zip file.
 * WhatsApp zips contain a single _chat.txt (or .txt) plus optional media.
 *
 * @param {Buffer} zipBuffer
 * @returns {string | null} text content of the chat file, or null if not found
 */
export function extractTextFromZip(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  const chatEntry = entries.find((e) => {
    const name = e.entryName.toLowerCase();
    return name.endsWith('.txt') && !name.startsWith('__macosx');
  });

  if (!chatEntry) return null;
  return chatEntry.getData().toString('utf-8');
}
