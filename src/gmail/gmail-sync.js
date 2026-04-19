import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { google } = require('googleapis');

import { importExportedChat, extractTextFromZip } from '../import/chat-import.js';

const SETTINGS_IMPORTED = 'gmail_imported_keys';
const MAX_IMPORTED_KEYS = 2000;
const MAX_MESSAGES_PER_SYNC = 35;

/**
 * @param {string} filename
 * @returns {boolean}
 */
export function isLikelyWhatsAppExportFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  const lower = filename.toLowerCase();
  if (!lower.endsWith('.txt') && !lower.endsWith('.zip')) return false;
  if (/whatsapp/i.test(filename)) return true;
  return false;
}

/**
 * @param {string} fileName
 * @returns {string}
 */
export function chatNameFromFilename(fileName) {
  return fileName.replace(/\.(zip|txt)$/i, '').replace(/^WhatsApp Chat with /i, '');
}

/**
 * @param {object | undefined} payload Gmail API message payload
 * @param {Array<{ filename: string, attachmentId: string }>} out
 */
export function collectAttachmentsFromPayload(payload, out) {
  if (!payload) return;
  const fn = payload.filename;
  const aid = payload.body?.attachmentId;
  if (fn && aid && (fn.toLowerCase().endsWith('.txt') || fn.toLowerCase().endsWith('.zip'))) {
    out.push({ filename: fn, attachmentId: aid });
  }
  if (payload.parts) {
    for (const p of payload.parts) collectAttachmentsFromPayload(p, out);
  }
}

/**
 * @param {import('../storage/database.js').default} db
 * @param {object} oauth2Client google-auth-library OAuth2Client
 * @returns {Promise<{ results: Array<Record<string, unknown>>, skipped: number, errors: string[] }>}
 */
export async function syncWhatsAppExportsFromGmail(db, oauth2Client) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  let importedKeys = [];
  try {
    importedKeys = JSON.parse(db.getSetting(SETTINGS_IMPORTED) || '[]');
  } catch {
    importedKeys = [];
  }
  if (!Array.isArray(importedKeys)) importedKeys = [];
  const importedSet = new Set(importedKeys);

  /** Attachment filenames from WhatsApp are always like `WhatsApp Chat with ….txt/.zip`. */
  const q = 'has:attachment (filename:txt OR filename:zip)';
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: MAX_MESSAGES_PER_SYNC,
  });

  const messages = listRes.data.messages || [];
  const results = [];
  const errors = [];
  let skipped = 0;

  for (const { id: messageId } of messages) {
    if (!messageId) continue;
    let full;
    try {
      full = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    } catch (e) {
      errors.push(`${messageId}: ${e.message}`);
      continue;
    }

    const attachments = [];
    collectAttachmentsFromPayload(full.data.payload, attachments);

    for (const att of attachments) {
      if (!isLikelyWhatsAppExportFilename(att.filename)) continue;
      const key = `${messageId}:${att.attachmentId}`;
      if (importedSet.has(key)) {
        skipped++;
        continue;
      }

      try {
        const attRes = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: att.attachmentId,
        });
        const raw = attRes.data.data;
        if (!raw) {
          errors.push(`${att.filename}: empty attachment`);
          continue;
        }
        const buf = Buffer.from(raw, 'base64url');
        const lower = att.filename.toLowerCase();
        let textContent;
        if (lower.endsWith('.zip')) {
          textContent = extractTextFromZip(buf);
          if (!textContent) {
            errors.push(`${att.filename}: no chat .txt in zip`);
            continue;
          }
        } else {
          textContent = buf.toString('utf-8');
        }

        const chatName = chatNameFromFilename(att.filename);
        const result = importExportedChat(db, textContent, chatName);
        results.push({ chatName, filename: att.filename, messageId, ...result });
        importedSet.add(key);
      } catch (e) {
        errors.push(`${att.filename}: ${e.message}`);
      }
    }
  }

  const nextKeys = [...importedSet];
  if (nextKeys.length > MAX_IMPORTED_KEYS) {
    nextKeys.splice(0, nextKeys.length - MAX_IMPORTED_KEYS);
  }
  db.setSetting(SETTINGS_IMPORTED, JSON.stringify(nextKeys));

  return { results, skipped, errors };
}
