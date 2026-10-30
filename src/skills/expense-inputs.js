import { dayBoundsFromTimestamp } from '../expenses/chat-expense-extractor.js';

const MONTH_INDEX = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};
const MONTH_ALT = Object.keys(MONTH_INDEX).join('|');

function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yearFromDigits(raw, fallbackYear) {
  if (raw == null || String(raw).trim() === '') return fallbackYear;
  const s = String(raw).trim();
  if (s.length === 4) return Number(s);
  const n = Number(s);
  if (!Number.isFinite(n)) return fallbackYear;
  return n >= 70 ? 1900 + n : 2000 + n;
}

function validLocalDay(year, monthIndex, day) {
  if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const dt = new Date(year, monthIndex, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== monthIndex || dt.getDate() !== day) return null;
  return localDate(dt);
}

/** Calendar day named in the command, if any. `now` is injectable so tests do not depend on the clock. */
export function dateHintFromRest(rest, now = new Date()) {
  const text = String(rest || '');
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\btoday\b/i.test(text)) return localDate(now);
  if (/\byesterday\b/i.test(text)) {
    return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  }

  // "12 oct", "12th October", "12 Oct 2026"
  const dayMonth = text.match(new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})(?:\\s+(\\d{2,4}))?\\b`,
    'i',
  ));
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const monthIndex = MONTH_INDEX[dayMonth[2].toLowerCase()];
    const year = yearFromDigits(dayMonth[3], now.getFullYear());
    const hit = validLocalDay(year, monthIndex, day);
    if (hit) return hit;
  }

  // "Oct 12", "October 12, 2026"
  const monthDay = text.match(new RegExp(
    `\\b(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{2,4}))?\\b`,
    'i',
  ));
  if (monthDay) {
    const monthIndex = MONTH_INDEX[monthDay[1].toLowerCase()];
    const day = Number(monthDay[2]);
    const year = yearFromDigits(monthDay[3], now.getFullYear());
    const hit = validLocalDay(year, monthIndex, day);
    if (hit) return hit;
  }

  // Indian-style numeric dates: 12.10.26 / 12/10/2026 / 12-10-26 (day/month/year).
  const numeric = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/);
  if (numeric) {
    const day = Number(numeric[1]);
    const monthIndex = Number(numeric[2]) - 1;
    const year = yearFromDigits(numeric[3], now.getFullYear());
    const hit = validLocalDay(year, monthIndex, day);
    if (hit) return hit;
  }

  return null;
}

export function fileHintFromRest(rest) {
  const text = String(rest || '');
  const attached = text.match(/<attached:\s*([^>]+)>/i);
  if (attached && /\.(xlsx|xlsm|csv|tsv|txt|pdf|docx)$/i.test(attached[1].trim())) {
    return attached[1].trim().split(/[/\\]/).pop();
  }
  // Compact names first (16-oct.xlsx) so "Site A 16-oct.xlsx" does not swallow the chat name.
  const compact = text.match(/\b[A-Za-z0-9._()-]+\.(?:xlsx|xlsm|csv|tsv|txt|pdf|docx)\b/gi);
  if (compact?.length) return compact[compact.length - 1];
  // Spaced Phone-pay PDF titles: "Phone pay - 14.10.26.pdf"
  const phonePay = text.match(/\b(?:phone|phn|phon)\s+pay\b[^.]*\.(?:pdf)\b/i);
  return phonePay ? phonePay[0].trim() : null;
}

export function chatQueryFromRest(rest) {
  let text = String(rest || '');
  const file = fileHintFromRest(text);
  if (file) text = text.replace(file, ' ');
  return text
    .replace(/#[^\s#]+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:today|yesterday)\b/gi, ' ')
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALT})(?:\\s+\\d{2,4})?\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b(?:${MONTH_ALT})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{2,4})?\\b`, 'gi'), ' ')
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDocumentSheet(sheet) {
  return /\.(xlsx|xlsm|csv|tsv|txt|pdf|docx)$/i.test(String(sheet?.fileName || ''));
}

/** Prefer Phone-pay / Excel sheets over PhonePe payment photos in the picker. */
export function preferSheetsForPicker(candidates, { fileHint = null } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (fileHint || !list.length) return list;
  const docs = list.filter(isDocumentSheet);
  return docs.length ? docs : list;
}

function isExpenseChatJid(jid) {
  const s = String(jid || '');
  return s.endsWith('@g.us') || s.endsWith('@imported');
}

function groupMentions(mentions) {
  return (mentions || []).filter((pin) => isExpenseChatJid(pin?.chatJid));
}

function ask(answer, choices = []) {
  return { status: 'needs_input', answer, choices };
}

function mentionsChat(chat, query) {
  const name = String(chat?.chatName || '').trim().toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  if (!q || !chat?.chatJid) return false;
  if (q === String(chat.chatJid).toLowerCase()) return true;
  if (!name || name === String(chat.chatJid).toLowerCase()) return false;
  return name === q || name.includes(q) || q.includes(name);
}

/** A pin, or the open group tab. Extra sentence text does not count as a missing name. */
function attachedGroup({ mentions = [], scopeChatJid = null, scopeChatName = null, command }) {
  const groups = groupMentions(mentions);
  if (groups.length === 1) return { status: 'ready', chat: groups[0] };
  if (groups.length > 1) {
    return ask(
      'Which site should I reconcile? Send one of these:',
      groups.map((pin) => ({
        label: pin.chatName || pin.chatJid,
        message: `${command} ${pin.chatName || pin.chatJid}`,
      })),
    );
  }
  if (isExpenseChatJid(scopeChatJid)) {
    return { status: 'ready', chat: { chatJid: scopeChatJid, chatName: scopeChatName || scopeChatJid } };
  }
  return null;
}

/**
 * Which site group the command refers to.
 * An explicit chat name in the command wins. Other words ("please do it for this chat")
 * are instructions: the @mention or the open chat is already the site.
 */
export function resolveExpenseChat({
  rest = '',
  mentions = [],
  scopeChatJid = null,
  scopeChatName = null,
  resolveChat = () => null,
  command = '/accountant/expense-reconciliation',
} = {}) {
  const attached = attachedGroup({ mentions, scopeChatJid, scopeChatName, command });
  const chatQuery = chatQueryFromRest(rest);
  if (chatQuery) {
    const named = resolveChat(chatQuery);
    if (named?.chatJid && mentionsChat(named, chatQuery)) {
      if (!isExpenseChatJid(named.chatJid)) {
        return ask(`${named.chatName || chatQuery} is not a site chat. Expense reconciliation runs on a group or imported archive.`);
      }
      return { status: 'ready', chat: named };
    }
    if (attached) return attached;
    return ask(`No chat matches "${chatQuery}". Name the site group, or @mention it, then run \`${command}\` again.`);
  }
  if (attached) return attached;
  return ask(`Which site chat? @mention the group or send \`${command}\` with its name.`);
}

/** Optional `#messageId` token from a prior picker chip — uniquely selects one sheet. */
export function messageIdHintFromRest(rest) {
  const m = String(rest || '').match(/#([^\s#]+)/);
  return m ? m[1].trim() : null;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Human label for an ISO day — `2026-10-12` → `12 Oct`. */
export function formatExpenseDayLabel(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso || '');
  const month = SHORT_MONTHS[Number(m[2]) - 1];
  if (!month) return String(iso);
  return `${Number(m[3])} ${month}`;
}

/**
 * Distinct calendar days that have a reconcile sheet (docs preferred), newest first.
 * `sheets` must already be newest-first.
 */
export function listExpenseSheetDates(sheets = []) {
  const preferred = preferSheetsForPicker(sheets);
  const seen = new Set();
  const dates = [];
  for (const sheet of preferred) {
    const day = dayBoundsFromTimestamp(sheet.timestamp).date;
    if (!day || seen.has(day)) continue;
    seen.add(day);
    dates.push(day);
  }
  return dates;
}

function sheetsForChatList(sheets, chatJid) {
  return (sheets || []).filter((sheet) => !sheet.chatJid || sheet.chatJid === chatJid);
}

function dateChoice(command, chat, day) {
  return {
    label: formatExpenseDayLabel(day),
    message: `${command} ${chat.chatName || ''} ${day}`.replace(/\s+/g, ' ').trim(),
  };
}

/** Ask which day to reconcile when the command has no date yet. */
export function askExpenseDate({
  chat,
  sheets = [],
  command = '/accountant/expense-reconciliation',
} = {}) {
  const dates = listExpenseSheetDates(sheetsForChatList(sheets, chat?.chatJid));
  if (!dates.length) {
    return ask(`No expense sheet in ${chat?.chatName || 'that chat'} yet. Post an Excel, CSV, or Phone-pay PDF, then run \`${command}\` again.`);
  }
  return ask(
    `Which date should I check in ${chat?.chatName || 'that chat'}?`,
    dates.slice(0, 10).map((day) => dateChoice(command, chat, day)),
  );
}

/**
 * After a dry-run, offer other days that still have sheets.
 * Prefer nearby days first (next/prev), then remaining newest-first.
 */
export function otherExpenseDateChoices({
  sheets = [],
  currentDate = null,
  chat,
  command = '/accountant/expense-reconciliation',
  limit = 5,
} = {}) {
  const dates = listExpenseSheetDates(sheetsForChatList(sheets, chat?.chatJid))
    .filter((day) => day !== currentDate);
  if (!dates.length || !chat) return [];
  const ranked = [...dates].sort((a, b) => {
    if (!currentDate) return 0;
    return Math.abs(Date.parse(a) - Date.parse(currentDate)) - Math.abs(Date.parse(b) - Date.parse(currentDate));
  });
  return ranked.slice(0, limit).map((day) => dateChoice(command, chat, day));
}

/**
 * Guided expense inputs: date → file for that date → ready to reconcile.
 * `sheets` must already be newest-first.
 */
export function resolveExpenseSheet({
  rest = '',
  chat,
  sheets = [],
  now = new Date(),
  command = '/accountant/expense-reconciliation',
} = {}) {
  const dateHint = dateHintFromRest(rest, now);
  const fileHint = fileHintFromRest(rest);
  const messageIdHint = messageIdHintFromRest(rest);
  let candidates = sheetsForChatList(sheets, chat.chatJid);

  // Step 1 — ask for a date before listing files (unless a chip already pinned a message).
  if (!dateHint && !messageIdHint) {
    const dates = listExpenseSheetDates(candidates);
    if (!dates.length) {
      return ask(`No expense sheet in ${chat.chatName || 'that chat'} yet. Post an Excel, CSV, or Phone-pay PDF, then run \`${command}\` again.`);
    }
    if (dates.length > 1) return askExpenseDate({ chat, sheets: candidates, command });
    // Only one day in the archive — skip the date question and continue with it.
    candidates = candidates.filter((sheet) => dayBoundsFromTimestamp(sheet.timestamp).date === dates[0]);
  }

  if (messageIdHint) {
    candidates = candidates.filter((sheet) => sheet.messageId === messageIdHint);
  }
  const effectiveDate = dateHint || (
    candidates.length
      ? dayBoundsFromTimestamp(candidates[0].timestamp).date
      : null
  );
  if (dateHint) {
    candidates = candidates.filter((sheet) => dayBoundsFromTimestamp(sheet.timestamp).date === dateHint);
  }
  if (fileHint) {
    const needle = fileHint.toLowerCase();
    candidates = candidates.filter((sheet) => {
      const name = String(sheet.fileName || '').toLowerCase();
      return name === needle || name.includes(needle) || needle.includes(name);
    });
  }

  // Prefer PDFs/Excel over PhonePe payment photos for the file step.
  const forPicker = preferSheetsForPicker(candidates, { fileHint });
  if (forPicker.length === 1) {
    const sheet = forPicker[0];
    return {
      status: 'ready',
      chat,
      messageId: sheet.messageId,
      fileName: sheet.fileName,
      dateHint: effectiveDate || dayBoundsFromTimestamp(sheet.timestamp).date,
    };
  }
  if (forPicker.length > 1) {
    const dayLabel = effectiveDate ? formatExpenseDayLabel(effectiveDate) : 'that day';
    return ask(
      `Which file should I reconcile for ${dayLabel} in ${chat.chatName || 'that chat'}?`,
      forPicker.slice(0, 8).map((sheet) => {
        const day = dayBoundsFromTimestamp(sheet.timestamp).date;
        return {
          label: sheet.fileName,
          message: `${command} ${chat.chatName || ''} ${day} ${sheet.fileName} #${sheet.messageId}`
            .replace(/\s+/g, ' ')
            .trim(),
        };
      }),
    );
  }
  const when = effectiveDate ? ` on ${formatExpenseDayLabel(effectiveDate)}` : '';
  const named = fileHint ? ` named ${fileHint}` : '';
  return ask(`No expense sheet${named} in ${chat.chatName || 'that chat'}${when}. Post the Excel or CSV in the group, then run \`${command}\` again.`);
}
