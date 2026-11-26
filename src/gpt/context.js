import { GROUNDING_PROMPT_RULES } from '../search/grounding.js';
import { getSmbProfileFromDb, synthesisSystemAddon } from '../smb/profiles.js';
import { memoryPromptBlock } from './user-memory.js';
import { budgetsForProvider, GPT_LIMITS, estimateTokens } from './limits.js';
import {
  detectTimeRange,
  formatSummaryLine,
  hybridSearch,
  isBroadQuery,
  packMessages,
} from './retrieval.js';
import { decomposeQuery, heuristicDecompose } from './query-decomposer.js';
import { TOOL_SPECS } from './tools.js';

export function isFollowUpTransformQuery(query) {
  const q = String(query || '').trim();
  if (!q || q.length > 100) return false;
  return /^(?:summarize|summarise|condense|shorten|reformat|format|rewrite|list|extract|give\s+me)\b.*\b(?:key\s*points?|bullets?|bullet\s*points?|summary|table|points?|above|that|it|this)\b/i.test(q)
    || /^(?:in\s+\d+\s+(?:bullets?|points?|lines?|sentences?)|make\s+it\s+(?:shorter|concise|a\s+table|bullets?)|tldr|tl;dr)[.!?\s]*$/i.test(q);
}

export function buildSystemPrompt({ db, businessContext = false, now = new Date(), includeReconcileHint = false, compact = false }) {
  const smb = businessContext ? synthesisSystemAddon(getSmbProfileFromDb(db)) : '';
  const businessName = businessContext ? String(db.getSetting?.('smb_business_name') || '').trim() : '';
  const memory = memoryPromptBlock(db, now);
  const today = now.toLocaleDateString('en-CA');
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' });
  const tools = TOOL_SPECS.map((t) => `- ${t.name} ${t.args} — ${t.about}`).join('\n');
  if (compact) {
    return [
      'You are WhatsApp GPT, an assistant over the user\'s WhatsApp archive.',
      `Today is ${weekday} ${today}. Messages from the user have sender "You".`,
      smb ? `${smb}${businessName ? ` Business: ${businessName}.` : ''}` : '',
      memory,
      GROUNDING_PROMPT_RULES,
      [
        'Messages appear as "[m123] date · sender: text" under "## Chat name". Media includes OCR text/filenames.',
        'Cite supporting messages with [m123] right after each claim. Never invent [m...] handles.',
        'For PDFs/menus/documents in context, CALL inspect_document on the message handle to read full text.',
        'When scoped to a chat, stay strictly within that chat. Honor exact user format requests (e.g. "3 bullets", "table").',
        ...(includeReconcileHint || businessContext ? [
          'For expense reconciliation, CALL reconcile (never invent numbers).',
        ] : []),
        'TOOLS: only if context is insufficient, reply with ONLY CALL lines: CALL {"tool":"search","args":{"query":"...","chat":"..."}}',
        tools,
        'STYLE: direct answer first, concise bullets/short paragraphs, **bold** key facts.',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');
  }
  return [
    'You are WhatsApp GPT: a sharp assistant over the user\'s own WhatsApp archive.',
    `Today is ${weekday} ${today}. Messages from the user appear with sender "You".`,
    smb ? `${smb}${businessName ? `\nBusiness name: ${businessName}.` : ''}` : '',
    memory,
    GROUNDING_PROMPT_RULES,
    [
      'CONTEXT: WhatsApp messages are given as lines "[m123] date · sender: text" grouped under "## Chat name".',
      'Media messages (images, screenshots, UPI receipts, bills, PDFs) include offline OCR text, filenames, and tags such as [image] or [document].',
      'ARCHIVE & FILE ACCESS: You have complete, direct access to the user\'s WhatsApp archive, including all messages, media, photos, documents, and PDFs. When messages or media are present in context, use them directly. NEVER state that you cannot access files, browse attachments, or read PDFs.',
      'DOCUMENT INSPECTION & MENUS: When messages in context or search results contain PDFs, brochures, menus, rate cards, or documents (e.g. `[m123] ... .pdf`), use `inspect_document` (e.g. CALL {"tool":"inspect_document","args":{"message":"m123"}}) to read their full text, pricing tables, and service lists directly rather than telling the user to open the document manually.',
      'When the user asks to find or search for images, receipts, payment screenshots, bills, or documents (e.g. "search for the image where I sent 100Rs", "find latest pdf", "find payment screenshot"), use `search` to look for keywords, filenames, amounts, names, or UPI details if not already in context.',
      'MEDIA & CITATIONS: When an answer is supported by media (photos, menus, posters, documents, PDFs) or when a sender posted both text and media, cite both the message and the media handle (e.g. [m123]) so the user can see and open the media card directly in their results.',
      'Cite the messages you rely on with their handle, e.g. [m123], right after the claim. Never invent handles.',
      'PAYMENT RECEIPTS & AMOUNTS: In Indian UPI payment screenshots (PhonePe, GPay, Paytm, BHIM, Bank transfers), OCR text sometimes misreads the rupee symbol `₹` as "F", "2", or "{" (for example "F284" or "2284" for ₹284). When you see "F<digits>" or a leading "2" that duplicates a smaller amount on a UPI receipt, recognize that the true amount is the actual amount without the OCR-misread rupee symbol (e.g. ₹284, not ₹2284). Always state the exact confirmed amount with ₹.',
      'CLEAN OUTPUT: Never output bare file extensions like "jpg" or "png" as standalone lines or sentences in your response. When referencing an image or receipt, refer to it naturally (e.g. "the payment receipt [m123]").',
      'SITUATIONAL CONVERSATION GROUNDING: When an "# Active conversation in <Chat>" section is present, it contains the most recent messages in the current thread. Questions about current plans, destinations, meeting spots, departures, arrivals, confirmations, or recent statements (e.g. "where are we heading?", "where are we meeting?", "did you leave?", "what time?", "what did they say?") MUST be answered directly from this active conversation horizon. Do NOT execute keyword searches across the archive for conversational verbs like "heading", "leaving", "meeting", or "going" when the answer is in the recent discussion.',
      'When scoped to a chat, stay strictly within that conversation and do not cite or bring in messages from unrelated contacts.',
      '@mentions on the current user message set which chats are in scope for this turn only.',
      'When no chat is @mentioned, the thread\'s home chat (see "Pinned chats") is the default.',
      ...(includeReconcileHint || businessContext ? [
        'Expense comparisons in context are labelled with their site — use the matching site; do not mix sites.',
      ] : []),
      '',
      'TOOLS: if the context is not enough, reply with ONLY tool calls, one per line, nothing else:',
      'CALL {"tool":"search","args":{"query":"cement delivery","chat":"Site 2"}}',
      'You may issue several CALL lines at once; they run in parallel. Results come back and you continue.',
      'Prefer answering straight away when the context already answers the question.',
      ...(includeReconcileHint || businessContext ? [
        'For expense reconciliation or other sites, CALL reconcile.',
        'When several chats are @mentioned this turn, CALL reconcile once with no chat arg (it runs each mentioned site).',
        'When only one site is needed, CALL reconcile with that chat name.',
        'If the user named a day (e.g. 10th Oct, yesterday), pass it as date in reconcile args so the skill picks that day\'s sheet.',
        'Do not invent reconciliation numbers — always CALL reconcile (or use a labelled comparison already in context for that same site).',
      ] : []),
      'When you need public facts, documentation, current events, or world knowledge outside WhatsApp, CALL web_search with concise public keywords.',
      'PRIVACY GUARDRAIL: You are STRICTLY FORBIDDEN from passing private names, phone numbers, contact info, personal addresses, or private chat quotes to web_search.',
      'Never send personal details to the internet. Web search is exclusively for open public knowledge; internal WhatsApp information must ONLY be queried using search or read tools.',
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
  constructor({ db, embeddings, directory, mediaIndexService = null }) {
    this.db = db;
    this.embeddings = embeddings;
    this.directory = directory;
    this.mediaIndexService = mediaIndexService;
  }

  async prefetch({ query, scopeJids = [], provider = null, intent = null, skipSearch = false, priorSourceJids = [], priorCitedMessages = [], focusPriorOnly = false }) {
    const budget = budgetsForProvider(provider, this.db).contextTokens;
    const range = detectTimeRange(query);
    const broad = isBroadQuery(query);
    const isSituationalRecent = /\b(?:where\s+(?:are|r)\s+we|where\s+we\s+(?:heading|meeting|going)|did\s+(?:you|they)\s+leave|what\s+did\s+(?:he|she|they)\s+(?:just\s+)?say)\b/i.test(String(query || ''));
    // Broad questions such as "what is this group about?" have no meaningful
    // search terms. FTS/vector search turns those generic words into noisy hits;
    // use the scoped timeline and its indexed summaries instead.
    const overview = broad && !range;
    const scoped = [...new Set(scopeJids.filter(Boolean))];
    const anchoredJids = [...new Set((priorSourceJids || []).filter(Boolean))].filter((j) => !scoped.includes(j));
    const optsDirectPriorOnly = Boolean(focusPriorOnly);

    const currentChatName = scoped.length === 1 ? this.directory.name(scoped[0]) : null;
    const resolvedIntent = intent || heuristicDecompose(query);

    const candidateJids = [];
    if (!skipSearch && Array.isArray(resolvedIntent?.candidateEntities)) {
      for (const ent of resolvedIntent.candidateEntities) {
        const resolved = this.directory.resolve(ent);
        if (resolved?.chatJid && !scoped.includes(resolved.chatJid) && !candidateJids.includes(resolved.chatJid)) {
          candidateJids.push(resolved.chatJid);
        } else if (!resolved && /\s/.test(String(ent || ''))) {
          for (const part of String(ent).split(/\s+/).reverse()) {
            if (part.length < 4) continue;
            const partMatch = this.directory.resolve(part);
            if (partMatch?.chatJid && !scoped.includes(partMatch.chatJid) && !candidateJids.includes(partMatch.chatJid)) {
              candidateJids.push(partMatch.chatJid);
              if (candidateJids.length >= 3) break;
            }
          }
        }
      }
    }

    const pinnedPrior = [];
    const seenPriorIds = new Set();
    for (const m of (priorCitedMessages || [])) {
      if (!m || seenPriorIds.has(m.id)) continue;
      seenPriorIds.add(m.id);
      pinnedPrior.push({ ...m, chatName: m.chatName || this.directory.name(m.chatJid) });
      if (typeof this.db.getChatNeighbors === 'function') {
        try {
          for (const nb of this.db.getChatNeighbors(m.chatJid, m.timestamp, m.id, 1) || []) {
            if (nb && !seenPriorIds.has(nb.id)) {
              seenPriorIds.add(nb.id);
              pinnedPrior.push({ ...nb, chatName: nb.chatName || this.directory.name(nb.chatJid) });
            }
          }
        } catch { /* ignore */ }
      }
    }

    // Direct attribute follow-ups ("when was that shared?", "where is the job located?") when
    // prior cited evidence is already pinned should focus tightly on that evidence instead of
    // drowning small models with 15+ unrelated matches from the same group chat.
    const skipSearchForFocusedPrior = Boolean(
      skipSearch
      || (pinnedPrior.length > 0 && optsDirectPriorOnly),
    );

    const chatsToSearch = scoped.length
      ? [...scoped]
      : (anchoredJids.length
          ? (pinnedPrior.length ? [...anchoredJids.slice(0, 2)] : [...anchoredJids.slice(0, 2), null])
          : [null]);
    for (const jid of candidateJids) {
      if (!chatsToSearch.includes(jid)) chatsToSearch.push(jid);
    }

    const searches = (overview || skipSearchForFocusedPrior)
      ? []
      : chatsToSearch.map((jid) => hybridSearch({
        db: this.db,
        embeddings: this.embeddings,
        query: resolvedIntent?.cleanedQuery || query,
        chatJid: jid,
        startTs: range?.startTs ?? null,
        endTs: range?.endTs ?? null,
        limit: pinnedPrior.length ? 5 : 20,
        mediaIndexService: this.mediaIndexService,
        intent: resolvedIntent,
      }));
    const searchResults = await Promise.all(searches.map((p) => p.catch(() => ({ messages: [] }))));

    const timeline = [];
    const timelineJids = scoped.length
      ? scoped
      : (pinnedPrior.length ? [] : anchoredJids.slice(0, 2));
    if (timelineJids.length) {
      const perChat = Math.max(1, Math.floor((range || broad ? GPT_LIMITS.maxMessagesInContext : (scoped.length ? 25 : 10)) / timelineJids.length));
      for (const jid of timelineJids) {
        const linkedJids = typeof this.db.getLinkedJids === 'function' ? this.db.getLinkedJids(jid) : [jid];
        const rows = range
          ? this.db.getMessagesInRange({ chatJid: jid, startTs: range.startTs, endTs: range.endTs, limit: perChat, newestFirst: true })
          : (typeof this.db.getMessagesPaginatedForJids === 'function'
              ? this.db.getMessagesPaginatedForJids(linkedJids, perChat, 0)
              : this.db.getMessagesPaginated(jid, perChat, 0));
        const name = this.directory.name(jid);
        timeline.push(...rows.map((m) => ({ ...m, chatName: m.chatName || name })));
      }
    }

    // Interleave hits across chats so a single chat cannot starve other relevant chats
    const hitsByChat = searchResults.map((r) => (r.messages || []).map((m) => ({
      ...m,
      chatName: m.chatName || this.directory.name(m.chatJid),
    })));

    const hits = [];
    const maxLen = Math.max(0, ...hitsByChat.map((arr) => arr.length));
    for (let i = 0; i < maxLen; i++) {
      for (const arr of hitsByChat) {
        if (i < arr.length) hits.push(arr[i]);
      }
    }

    const seen = new Set();
    const sections = [];
    const all = [];
    let remaining = budget;

    if (pinnedPrior.length && remaining > 0) {
      const priorBudget = Math.floor(budget * 0.45);
      const packedPrior = packMessages(pinnedPrior, priorBudget, seen);
      if (packedPrior.count) {
        sections.push(`# Messages referenced in the previous answer (Check these first)\n${packedPrior.text}`);
        remaining -= packedPrior.tokens;
        all.push(...pinnedPrior);
      }
    }

    const searchFirst = hits.length > 0 && !overview && !isSituationalRecent;

    const packTimelineSection = (maxBudget, maxRows = timeline.length) => {
      if (!timeline.length || maxBudget <= 0) return;
      const slice = timeline.slice(0, maxRows);
      const packed = packMessages(slice, maxBudget, seen);
      if (packed.count) {
        const heading = scoped.length === 1 && currentChatName
          ? `# Active conversation in ${currentChatName} (Most recent messages)`
          : `# Recent messages${range ? ` (${range.label})` : ''}`;
        sections.push(`${heading}\n${packed.text}`);
        remaining -= packed.tokens;
        all.push(...slice);
      }
    };

    const packHitsSection = (maxBudget) => {
      if (!hits.length || maxBudget <= 0) return;
      const packed = packMessages(hits, maxBudget, seen);
      if (packed.count) {
        sections.push(`# Search results for the question\n${packed.text}`);
        remaining -= packed.tokens;
        all.push(...hits);
      }
    };

    if (searchFirst) {
      const hitShare = timeline.length ? Math.floor(budget * 0.68) : budget;
      packHitsSection(hitShare);
      packTimelineSection(remaining, 12);
    } else {
      const timelineShare = hits.length ? Math.floor(budget * 0.6) : budget;
      packTimelineSection(timelineShare);
      packHitsSection(remaining);
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
export function buildHistory(prior, memory, historyTokens = GPT_LIMITS.historyTokens) {
  const turns = prior.slice(memory.memoryUpto || 0);
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const m = turns[i];
    const cost = estimateTokens(m.content);
    if (used + cost > historyTokens && kept.length) break;
    used += cost;
    kept.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  const overflow = turns.length - kept.length;
  const messages = memory.memory
    ? [{ role: 'user', content: `# Earlier in this conversation (memory)\n${memory.memory}` }, { role: 'assistant', content: 'Noted.' }, ...kept]
    : kept;
  return { messages, overflow };
}
