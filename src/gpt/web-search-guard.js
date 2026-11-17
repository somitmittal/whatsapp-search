/**
 * src/gpt/web-search-guard.js — Privacy Guardrail for External Web Search
 *
 * Ensures that private WhatsApp chats, contact details, phone numbers, WhatsApp JIDs,
 * payment identifiers, or verbatim message text NEVER leak to the public internet.
 */

// Common generic words that should not trigger false positives if someone names a chat/contact this
const GENERIC_COMMON_WORDS = new Set([
  'the', 'and', 'for', 'you', 'that', 'with', 'have', 'this', 'from', 'they',
  'here', 'home', 'work', 'office', 'test', 'help', 'info', 'news', 'family',
  'group', 'team', 'chat', 'daily', 'today', 'general', 'personal', 'misc',
  'project', 'admin', 'user', 'site', 'notes', 'links', 'status', 'update',
  'market', 'store', 'shop', 'school', 'college', 'class', 'bank', 'doctor',
  'hospital', 'hotel', 'trip', 'travel', 'food', 'dinner', 'lunch', 'taxi',
  'car', 'bus', 'flight', 'order', 'support', 'sales', 'service', 'me', 'my',
  'you', 'self', 'bot', 'status', 'everyone', 'all', 'announcement', 'announcements',
]);

const PATTERNS = {
  // WhatsApp JIDs: e.g. 12345@s.whatsapp.net, 123-456@g.us, 123@lid
  jid: /[\w.-]+@(s\.whatsapp\.net|g\.us|lid|hosted|broadcast)/i,

  // Email addresses
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,

  // Phone numbers (formatted or consecutive digits 7-15)
  // Structured phone numbers: +1 (555) 123-4567, +91 98765 43210, 98765-43210
  phoneStructured: /(?:(?:\+|00)\d{1,4}[-.\s]*)?(?:\(?\d{2,5}\)?[-.\s]*){2,4}\d{2,5}/,
  // Raw consecutive digits 7-15 (phone numbers, account numbers, Aadhaar)
  phoneDigits: /\b\d{7,15}\b/,

  // UPI IDs: e.g. name@okhdfcbank, name@paytm, 9876543210@upi
  upi: /\b[a-zA-Z0-9.\-_]{2,256}@(okhdfcbank|okaxis|oksbi|okicici|paytm|ybl|ibl|upi|apl|axl|federal|icici|hdfcbank|sbi|kotak)\b/i,

  // Credit/Debit Card numbers (13-19 digits or 4x4)
  creditCard: /\b(?:\d{4}[ -]?){3}\d{1,4}\b/,

  // Indian PAN (5 letters, 4 digits, 1 letter)
  pan: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/i,

  // US SSN
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,

  // Explicit internal WhatsApp chat intent
  internalIntent: /\b(?:my\s+chats?|my\s+messages?|in\s+(?:this|our|my)\s+chat|whatsapp\s+messages?|sent\s+me\s+a\s+message|who\s+messaged\s+me|who\s+texted\s+me)\b/i,
};

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates whether a proposed web search query is safe to send to the public internet.
 *
 * @param {string} query - The proposed search query string
 * @param {object} options
 * @param {object} [options.directory] - ChatDirectory instance
 * @param {Array<object|string>} [options.contextMessages] - Messages in context/turn
 * @returns {{ allowed: boolean, reason?: string, cleanQuery?: string }}
 */
export function validateWebSearchQuery(query, { directory = null, contextMessages = [] } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { allowed: false, reason: 'Search query is empty.' };
  }

  if (q.length > 200) {
    return {
      allowed: false,
      reason: 'Search query is too long (maximum 200 characters). Web search queries must be concise public terms.',
    };
  }

  // 1. Check PII patterns
  if (PATTERNS.jid.test(q)) {
    return { allowed: false, reason: 'Query contains a private WhatsApp identifier (JID).' };
  }
  if (PATTERNS.email.test(q)) {
    return { allowed: false, reason: 'Query contains an email address.' };
  }
  if (PATTERNS.upi.test(q)) {
    return { allowed: false, reason: 'Query contains a payment / UPI identifier.' };
  }
  if (PATTERNS.creditCard.test(q)) {
    return { allowed: false, reason: 'Query contains a card number.' };
  }
  if (PATTERNS.pan.test(q)) {
    return { allowed: false, reason: 'Query contains a government identity / tax ID number.' };
  }
  if (PATTERNS.ssn.test(q)) {
    return { allowed: false, reason: 'Query contains a social security number.' };
  }
  if (PATTERNS.phoneStructured.test(q) || PATTERNS.phoneDigits.test(q)) {
    return { allowed: false, reason: 'Query contains a phone number or numeric contact identifier.' };
  }
  if (PATTERNS.internalIntent.test(q)) {
    return {
      allowed: false,
      reason: 'Web search cannot search internal WhatsApp messages. Use the internal "search" or "read" tools instead.',
    };
  }

  // 2. Check Contact & Chat Names from Directory
  if (directory && typeof directory.list === 'function') {
    try {
      const dir = directory.list();
      const chats = dir?.chats || [];
      for (const chat of chats) {
        const rawName = String(chat.chatName || '').trim();
        if (!rawName || rawName.includes('@')) continue;
        const cleanName = rawName.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
        if (cleanName.length < 3) continue;

        const words = cleanName.toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length === 1 && GENERIC_COMMON_WORDS.has(words[0])) continue;

        const pattern = new RegExp(`(^|[^a-zA-Z0-9])${escapeRegex(cleanName)}([^a-zA-Z0-9]|$)`, 'i');
        if (pattern.test(q)) {
          return {
            allowed: false,
            reason: `Query contains private contact or chat name "${cleanName}". Remove private names before searching the public web.`,
          };
        }
      }
    } catch {
      // Ignore directory enumeration error; proceed to next checks
    }
  }

  // 3. Check Sender Names and Verbatim Leak from Messages in Context
  if (Array.isArray(contextMessages) && contextMessages.length > 0) {
    // 3a. Sender names
    for (const m of contextMessages) {
      const sender = String(m?.sender || '').trim();
      if (!sender || sender.includes('@') || sender.toLowerCase() === 'you') continue;
      const cleanSender = sender.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
      if (cleanSender.length < 3) continue;

      const words = cleanSender.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 1 && GENERIC_COMMON_WORDS.has(words[0])) continue;

      const pattern = new RegExp(`(^|[^a-zA-Z0-9])${escapeRegex(cleanSender)}([^a-zA-Z0-9]|$)`, 'i');
      if (pattern.test(q)) {
        return {
          allowed: false,
          reason: `Query contains sender name "${cleanSender}" from your private WhatsApp messages. Remove private names before searching the public web.`,
        };
      }
    }

    // 3b. Verbatim 4-word message shingles
    const qTokens = q.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (qTokens.length >= 4) {
      const normalizedMessages = contextMessages.map((m) => {
        const text = typeof m === 'string' ? m : (m.text || m.content || '');
        return text.toLowerCase().replace(/[^\w\s]/g, ' ');
      });

      for (let i = 0; i <= qTokens.length - 4; i++) {
        const shingle = ` ${qTokens.slice(i, i + 4).join(' ')} `;
        for (const msg of normalizedMessages) {
          if (` ${msg} `.includes(shingle)) {
            return {
              allowed: false,
              reason: 'Query contains verbatim private message text from your chat context.',
            };
          }
        }
      }
    }
  }

  return { allowed: true, cleanQuery: q };
}
