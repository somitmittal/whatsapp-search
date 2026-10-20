import { GROUNDING_PROMPT_RULES } from '../search/grounding.js';
import { getSmbProfileFromDb, synthesisSystemAddon } from '../smb/profiles.js';
import { GPT_LIMITS, estimateTokens } from './limits.js';
import {
  detectTimeRange,
  formatSummaryLine,
  hybridSearch,
  isBroadQuery,
  packMessages,
} from './retrieval.js';
import { TOOL_SPECS } from './tools.js';

export function buildSystemPrompt({ db, businessContext = false, now = new Date() }) {
  const smb = businessContext ? synthesisSystemAddon(getSmbProfileFromDb(db)) : '';
  const businessName = businessContext ? String(db.getSetting?.('smb_business_name') || '').trim() : '';
  const today = now.toLocaleDateString('en-CA');
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const tools = TOOL_SPECS.map((t) => `- ${t.name} ${t.args} — ${t.about}`).join('\n');
  return [
    'You are WhatsApp GPT: a sharp assistant over the user\'s own WhatsApp archive.',
    `Today is ${weekday} ${today}. Messages from the user appear with sender "You".`,
    smb ? `${smb}${businessName ? `\nBusiness name: ${businessName}.` : ''}` : '',
    GROUNDING_PROMPT_RULES,
    [
      'CONTEXT: WhatsApp messages are given as lines "[m123] date · sender: text" grouped under "## Chat name".',
      'Cite the messages you rely on with their handle, e.g. [m123], right after the claim. Never invent handles.',
      '@mentions on the current user message set which chats are in scope for this turn only.',
      'When no chat is @mentioned, the thread\'s home chat (see "Pinned chats") is the default.',
      'Expense comparisons in context are labelled with their site — use the matching site; do not mix sites.',
      '',
      'TOOLS: if the context is not enough, reply with ONLY tool calls, one per line, nothing else:',
      'CALL {"tool":"search","args":{"query":"cement delivery","chat":"Site 2"}}',
      'You may issue several CALL lines at once; they run in parallel. Results come back and you continue.',
      'Prefer answering straight away when the context already answers the question.',
      'For expense reconciliation, retries ("try again"), or other sites, CALL reconcile.',
      'When several chats are @mentioned this turn, CALL reconcile once with no chat arg (it runs each mentioned site).',
      'When only one site is needed, CALL reconcile with that chat name.',
      'Do not invent reconciliation numbers — always CALL reconcile (or use a labelled comparison already in context for that same site).',
      tools,
      '',
      'ANSWER STYLE: lead with the direct answer, then supporting detail. Use short paragraphs or bullets,',
      '**bold** key names/amounts/dates. For "what happened" questions give a tight chronological recap.',
      'If nothing relevant exists, say so in one line and suggest what to ask instead.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}

export function expenseDiffBlock(diff) {
  if (!diff) return '';
  const site = diff.chatName || diff.chatJid || 'site';
  const rows = (diff.sheetRows || diff.discrepancies || []).slice(0, GPT_LIMITS.maxMessagesInContext);
  const lines = rows.map((r) => `- ${r.rowTone || r.type}: ${r.category || r.payee || r.description || 'row'} · chat ${r.chatAmount || '—'} · sheet ${r.sheetAmount || '—'}`);
  return [
    `# Expense comparison — site: ${site} · ${diff.businessDate || ''} · ${diff.sourceFileName || ''}`,
    `chatJid: ${diff.chatJid || 'unknown'}`,
    'Tones: match = green, extra-sheet = red (on sheet, not in chat), missing-sheet = yellow (in chat, not on sheet), mismatch = amber.',
    ...lines,
  ].join('\n');
}

/**
 * Prior reconciliation results for the model, newest first, packed into the history token budget.
 * Each block is labelled with its site so follow-ups can pick the right one.
 * When `chatJids` is set, only comparisons for those sites are included (avoids leaking
 * Site 1's result into a Site 2 / Site 3 turn).
 */
export function expenseHistoryBlocks(prior = [], { chatJids = null } = {}) {
  const allow = Array.isArray(chatJids) && chatJids.length
    ? new Set(chatJids.filter(Boolean))
    : null;
  const blocks = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    const diff = m?.payload?.expenseDiff;
    if (m?.role !== 'assistant' || !diff) continue;
    if (allow && diff.chatJid && !allow.has(diff.chatJid)) continue;
    if (allow && !diff.chatJid) continue;
    blocks.push(expenseDiffBlock(diff));
  }
  const kept = [];
  let used = 0;
  for (const block of blocks) {
    const cost = estimateTokens(block);
    if (used + cost > GPT_LIMITS.historyTokens && kept.length) break;
    used += cost;
    kept.push(block);
  }
  return kept.reverse().join('\n\n');
}

/**
 * A small model can invent a topic when a broad overview mostly contains
 * uncaptioned media or noisy one-word replies. Return a source-backed inventory
 * instead of asking it to infer what those messages depict.
 */
export function buildChatOverview(chatName, messages = []) {
  const rows = (messages || []).filter((m) => m?.id != null);
  if (rows.length < 12) return null;

  const opaqueMedia = rows.filter((m) => m.mediaType
    && !String(m.text || '').trim()
    && !String(m.mediaCaption || '').trim()
    && !String(m.mediaAiIndex || '').trim());
  const visibleRows = rows.map((m) => ({
    message: m,
    text: String(m.text || m.mediaCaption || m.mediaAiIndex || '').replace(/\s+/g, ' ').trim(),
  })).filter(({ text }) => text
    && !/^(?:ok(?:ay)?|k|hmm|yes|no|👍|🙏|👌|😂|❤️)+[.! ]*$/i.test(text));
  const selected = [];
  const add = (row) => {
    if (row && !selected.some((item) => item.message.id === row.message.id)) selected.push(row);
  };

  // Include different kinds of readable evidence when present: a shared link,
  // a concrete activity/update, and one substantive text message.
  add(visibleRows.find((row) => /https?:\/\//i.test(row.text)));
  add(visibleRows.find((row) => /\b(?:left from|reached|arrived|on the way|heading to|coming to)\b/i.test(row.text)));
  add(visibleRows.filter((row) => row.text.length >= 30)
    .sort((a, b) => b.text.length - a.text.length)[0]);
  for (const row of visibleRows) {
    if (selected.length >= 3) break;
    add(row);
  }

  const sources = selected.map(({ message }) => ({
    ref: `m${message.id}`,
    text: String(message.text || message.mediaCaption || message.mediaAiIndex || '').trim(),
    chatName: message.chatName || chatName,
    chatJid: message.chatJid || null,
    messageId: message.messageId || null,
    sender: message.sender || 'Unknown',
    timestamp: message.timestamp,
    mediaType: message.mediaType || null,
  }));
  const excerpts = selected.map(({ message, text }) => {
    const clipped = text.length > 150 ? `${text.slice(0, 149)}…` : text;
    return `“${clipped}” [m${message.id}]`;
  });
  const label = chatName ? ` in “${chatName}”` : '';
  const mediaNote = opaqueMedia.length
    ? `${opaqueMedia.length} of ${rows.length} recent messages are images/videos with no caption or indexed description. `
    : `I checked ${rows.length} recent messages. `;
  const evidenceNote = excerpts.length
    ? `Readable examples include ${excerpts.join('; ')}. `
    : 'The recent messages contain no readable text. ';
  const answer = `The recent messages${label} look mixed rather than centered on one topic. ${mediaNote}${evidenceNote}The text shows links, updates, and forwarded content, but I can’t infer what the undescribed media contains or claim a broader theme from it.`;

  return {
    answer,
    sources,
    refs: Object.fromEntries(sources.map((source) => [source.ref.slice(1), source])),
    payload: {},
  };
}

/**
 * Builds what the model sees before its first token — the Cursor-style "auto context":
 * pinned chats, the chat the user launched from, a hybrid search for the question,
 * and summaries for broad questions. Packed into a fixed token budget, deduped by message.
 */
export class ContextEngine {
  constructor({ db, embeddings, directory }) {
    this.db = db;
    this.embeddings = embeddings;
    this.directory = directory;
  }

  async prefetch({ query, scopeJids = [] }) {
    const budget = GPT_LIMITS.contextTokens;
    const range = detectTimeRange(query);
    const broad = isBroadQuery(query);
    // Broad questions such as "what is this group about?" have no meaningful
    // search terms. FTS/vector search turns those generic words into noisy hits;
    // use the scoped timeline and its indexed summaries instead.
    const overview = broad && !range;
    const scoped = [...new Set(scopeJids.filter(Boolean))];

    const searches = overview
      ? []
      : scoped.length
      ? scoped.map((jid) => hybridSearch({
        db: this.db, embeddings: this.embeddings, query, chatJid: jid,
        startTs: range?.startTs ?? null, endTs: range?.endTs ?? null,
      }))
      : [hybridSearch({
        db: this.db, embeddings: this.embeddings, query,
        startTs: range?.startTs ?? null, endTs: range?.endTs ?? null,
      })];
    const searchResults = await Promise.all(searches.map((p) => p.catch(() => ({ messages: [] }))));

    const timeline = [];
    if (scoped.length && (range || broad)) {
      const perChat = Math.max(1, Math.floor(GPT_LIMITS.maxMessagesInContext / scoped.length));
      for (const jid of scoped) {
        const rows = range
          ? this.db.getMessagesInRange({ chatJid: jid, startTs: range.startTs, endTs: range.endTs, limit: perChat, newestFirst: true })
          : this.db.getMessagesPaginated(jid, perChat, 0);
        const name = this.directory.name(jid);
        timeline.push(...rows.map((m) => ({ ...m, chatName: m.chatName || name })));
      }
    }

    const seen = new Set();
    const sections = [];
    const all = [];
    let remaining = budget;

    if (timeline.length) {
      const share = searchResults.some((r) => r.messages.length) ? Math.floor(budget / 2) : budget;
      const packed = packMessages(timeline, share, seen);
      if (packed.count) {
        sections.push(`# Recent messages${range ? ` (${range.label})` : ''}\n${packed.text}`);
        remaining -= packed.tokens;
        all.push(...timeline);
      }
    }

    const hits = searchResults.flatMap((r) => r.messages);
    if (hits.length && remaining > 0) {
      const packed = packMessages(hits, remaining, seen);
      if (packed.count) {
        sections.push(`# Search results for the question\n${packed.text}`);
        remaining -= packed.tokens;
        all.push(...hits);
      }
    }

    if (broad && !range && remaining > 0) {
      const jid = scoped.length === 1 ? scoped[0] : null;
      const rows = this.db.getRecentThreadSummaries(jid, GPT_LIMITS.maxSummaries);
      const lines = [];
      for (const s of rows.reverse()) {
        const line = formatSummaryLine(s);
        const cost = estimateTokens(line);
        if (cost > remaining) break;
        remaining -= cost;
        lines.push(line);
      }
      if (lines.length) sections.push(`# Recent thread summaries\n${lines.reverse().join('\n')}`);
    }

    return {
      text: sections.join('\n\n'),
      messages: [...new Map(all.filter((m) => seen.has(m.id)).map((m) => [m.id, m])).values()],
      range,
    };
  }
}

/**
 * Conversation history in Cursor style: a rolling memory of older turns plus as many
 * recent turns verbatim as fit. Returns the split point so older turns can be folded later.
 */
export function buildHistory(prior, memory) {
  const turns = prior.slice(memory.memoryUpto || 0);
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    const cost = estimateTokens(m.content);
    if (used + cost > GPT_LIMITS.historyTokens && kept.length) break;
    used += cost;
    kept.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  const overflow = turns.length - kept.length;
  const messages = memory.memory
    ? [{ role: 'user', content: `# Earlier in this conversation (memory)\n${memory.memory}` }, { role: 'assistant', content: 'Noted.' }, ...kept]
    : kept;
  return { messages, overflow };
}
