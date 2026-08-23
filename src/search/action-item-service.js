/**
 * Suggests follow-up action items for incoming WhatsApp messages (heuristic gate + LLM).
 * Not run for every message — only candidates that look like requests, deadlines, or open loops.
 */

import { actionItemAddon, getSmbProfileFromDb } from '../smb/profiles.js';
import { GROUNDING_PROMPT_RULES } from './grounding.js';

function combinedText(row) {
  const t = (row.text || '').trim();
  const c = (row.mediaCaption || '').trim();
  if (t && c) return `${t}\n${c}`;
  return t || c || '';
}

/** Fast filter before any LLM call */
export function isActionSuggestionCandidate(row) {
  if (!row || row.sender === 'You') return false;
  const text = combinedText(row);
  if (text.length < 14) return false;
  if (/^(ok|okay|thanks|thank you|lol|haha|yes|no|yep|nope|👍|❤️)\s*$/i.test(text)) return false;

  return /[?]|\b(please|pls|can you|could you|would you|remind|follow up|follow-up|send (me |the )|by (mon|tue|wed|thu|fri|sat|sun)|tomorrow|today|asap|eod|deadline|need you to|let\'?s sync|action item|todo|fyi|heads up|don\'?t forget|book|schedule|call me|ping me)\b/i.test(text);
}

function extractJsonObject(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const inner = fence ? fence[1].trim() : s;
  const start = inner.indexOf('{');
  const end = inner.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(inner.slice(start, end + 1));
  } catch {
    return null;
  }
}

export default class ActionItemService {
  constructor({ db, getProvider, onSuggestionsUpdated }) {
    this.db = db;
    this.getProvider = getProvider;
    this._onSuggestionsUpdated = typeof onSuggestionsUpdated === 'function' ? onSuggestionsUpdated : null;
    /** @type {Set<string>} */
    this._pending = new Set();
    this._timer = null;
  }

  /** Call with newly inserted message ids only (from insertMessageBatch). */
  enqueueByMessageIds(messageIds) {
    for (const id of messageIds || []) {
      if (id) this._pending.add(id);
    }
    this._schedule();
  }

  _schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._flush();
    }, 2200);
  }

  async _flush() {
    const ids = [...this._pending];
    this._pending.clear();
    if (!ids.length) return;

    const provider = this.getProvider?.();
    if (!provider || typeof provider.chat !== 'function') return;

    const batch = ids.slice(0, 12);
    for (const messageId of batch) {
      try {
        await this._processOne(provider, messageId);
      } catch (e) {
        console.warn(`[ActionItems] ${messageId}:`, e.message);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async _processOne(provider, messageId) {
    const row = this.db.getMessageRowByMessageId(messageId);
    if (!row) return;
    if (!isActionSuggestionCandidate(row)) {
      this.db.upsertChatActionItems(row.chatJid, messageId, []);
      return;
    }

    const body = combinedText(row);
    const profile = getSmbProfileFromDb(this.db);
    const verticalLine = actionItemAddon(profile);
    const prompt = `You analyze ONE WhatsApp message. Decide if the recipient should follow up with concrete actions.

${GROUNDING_PROMPT_RULES}

Reply with ONLY a compact JSON object (no markdown), shape:
{"followUp":boolean,"items":["max 3 short imperative action items for the reader, e.g. Confirm date with Alice","empty array if none"]}

Rules:
- followUp true only when there are clear tasks, unanswered questions, commitments, deadlines, or things the reader should do.
- false for pure thanks, greetings, jokes, reactions, or statements with no implied task.
- items must be actionable (verb-first), <= 90 chars each.
- Use neutral professional tone.
${verticalLine ? `- ${verticalLine}` : ''}

Sender name: ${row.sender || 'Unknown'}
Message:
${body.slice(0, 1800)}`;

    const raw = await provider.chat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.15, maxTokens: 400 },
    );
    const parsed = extractJsonObject(raw);
    const items = Array.isArray(parsed?.items)
      ? parsed.items.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3)
      : [];
    const followUp = parsed?.followUp !== false;
    const out = followUp ? items : [];
    this.db.upsertChatActionItems(row.chatJid, messageId, out);
    if (out.length) {
      console.log(`[ActionItems] ${messageId}: ${out.length} suggestion(s)`);
      this._onSuggestionsUpdated?.({ messageId, chatJid: row.chatJid });
    }
  }
}
