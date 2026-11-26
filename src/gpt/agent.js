import { streamChat } from '../llm/stream-chat.js';
import { enforceGroundedAnswer, UNGROUNDED_NOTICE, NO_GROUNDED_ANSWER } from '../search/grounding.js';
import { GPT_LIMITS } from './limits.js';
import { messageBody } from './retrieval.js';

const CALL_RE = /^\s*(?:Tools\s+)?CALL\s+(\{.*\})\s*$/i;
const REF_RE = /\[m(\d+)\]/g;
const KNOWN_TOOLS = new Set(['search', 'read', 'chats', 'summaries', 'reconcile', 'web_search', 'inspect_document']);

function stripToolCallLines(text) {
  return String(text || '')
    .replace(/<(?:dots_function_call|tool_call|function_call)[\s\S]*?>/gi, '')
    .split('\n')
    .filter((l) => !CALL_RE.test(l) && !/^\s*Tools\s+CALL\b/i.test(l))
    .join('\n')
    .trim();
}

export class AbortedError extends Error {
  constructor() { super('aborted'); this.name = 'AbortedError'; }
}

function normalizeCallObj(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const name = String(obj.tool || obj.name || obj.function || '').trim();
  if (!name) return null;
  const rawArgs = obj.args || obj.arguments || obj.parameters || {};
  let args = rawArgs;
  if (typeof rawArgs === 'string') {
    try { args = JSON.parse(rawArgs); } catch { args = {}; }
  }
  return { name, args: args && typeof args === 'object' ? args : {} };
}

/**
 * Robust tool-call parser (Runtime Harness).
 * Handles single-line CALL {...}, multi-line CALL {...}, markdown-wrapped JSON,
 * and direct JSON function calls from small local models (Ollama).
 */
export function parseToolCalls(text) {
  const str = String(text || '').trim();
  if (!str) return [];

  const calls = [];

  // 1. Line-by-line CALL_RE check (fast path & legacy format)
  const lines = str.replace(/```(?:json)?/g, '').split('\n');
  for (const line of lines) {
    const m = line.match(CALL_RE);
    if (!m) continue;
    try {
      const call = normalizeCallObj(JSON.parse(m[1]));
      if (call) calls.push(call);
    } catch { /* model wrote a malformed call; ignore that line */ }
  }
  if (calls.length > 0) return calls;

  // 2. Multi-line CALL { ... } blocks
  const multiCallRe = /CALL\s*(\{[\s\S]*?\})(?=\s*(?:CALL|$))/g;
  let match;
  while ((match = multiCallRe.exec(str)) !== null) {
    try {
      const call = normalizeCallObj(JSON.parse(match[1]));
      if (call) calls.push(call);
    } catch { /* ignore malformed segment */ }
  }
  if (calls.length > 0) return calls;

  // 3. Markdown code blocks ```(?:json)? ... ```
  const codeBlockRe = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  while ((match = codeBlockRe.exec(str)) !== null) {
    const blockContent = match[1].trim();
    try {
      const parsed = JSON.parse(blockContent);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const call = normalizeCallObj(item);
          if (call) calls.push(call);
        }
      } else {
        const call = normalizeCallObj(parsed);
        if (call && (KNOWN_TOOLS.has(call.name) || parsed.tool)) calls.push(call);
      }
    } catch {
      // Check if code block contains CALL lines
      for (const line of blockContent.split('\n')) {
        const m = line.match(CALL_RE);
        if (m) {
          try {
            const call = normalizeCallObj(JSON.parse(m[1]));
            if (call) calls.push(call);
          } catch { /* ignore */ }
        }
      }
    }
  }
  if (calls.length > 0) return calls;

  // 3b. XML / pseudo-token tags: <dots_function_call> ... </dots_function_call>
  const xmlRe = /<(?:dots_function_call|tool_call|function_call)>\s*(\{[\s\S]*?\})\s*<\/(?:dots_function_call|tool_call|function_call)>/gi;
  while ((match = xmlRe.exec(str)) !== null) {
    try {
      const call = normalizeCallObj(JSON.parse(match[1]));
      if (call) calls.push(call);
    } catch { /* ignore */ }
  }
  if (calls.length > 0) return calls;

  // 4. Standalone JSON tool calls (common in Ollama outputs)
  if (str.startsWith('{') || str.startsWith('[') || str.includes('{"tool"') || str.includes('{"name"')) {
    try {
      const jsonStart = str.indexOf('{');
      const jsonEnd = str.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const candidate = str.slice(jsonStart, jsonEnd + 1);
        const obj = JSON.parse(candidate);
        const call = normalizeCallObj(obj);
        if (call && (KNOWN_TOOLS.has(call.name) || obj.tool)) {
          calls.push(call);
          return calls;
        }
      }
    } catch { /* not valid JSON */ }
  }

  return calls;
}

function describeCall({ name, args }) {
  const where = args.chat ? ` in ${args.chat}` : ' across all chats';
  switch (name) {
    case 'search': return `Searching “${args.query || ''}”${where}…`;
    case 'read': return `Reading ${args.chat || 'chat'}${args.date ? ` on ${args.date}` : ''}…`;
    case 'chats': return `Looking up chats${args.query ? ` matching “${args.query}”` : ''}…`;
    case 'summaries': return `Scanning summaries${where}…`;
    case 'reconcile': return `Reconciling expenses${where}…`;
    case 'web_search': return `Searching the web for “${args.query || ''}”…`;
    case 'inspect_document': return `Inspecting document ${args.file || args.message || ''}${where}…`;
    default: return `Running ${name}…`;
  }
}

/**
 * Streams one model step. Text that starts like a tool call is held back so the user
 * never sees raw CALL lines; ordinary prose streams token by token.
 */
async function streamStep(provider, messages, { emit, signal }) {
  let buf = '';
  let mode = null;
  const text = await streamChat(provider, messages, {
    maxTokens: GPT_LIMITS.answerTokens,
    temperature: 0.2,
  }, (delta) => {
    if (signal?.aborted) throw new AbortedError();
    buf += delta;
    if (mode === 'text') {
      emit?.({ type: 'delta', text: delta });
      return;
    }
    if (mode === 'tool') return;
    const head = buf.trimStart();
    if (head.length < 10 && !head.includes('\n')) return;
    mode = /^((?:Tools\s+)?CALL\b|```|<(?:dots_function_call|tool_call|function_call)|\{\s*"(?:tool|name)")/i.test(head) ? 'tool' : 'text';
    if (mode === 'text') emit?.({ type: 'delta', text: buf });
  });
  return { text: String(text || buf).trim(), streamed: mode === 'text' };
}

/**
 * Agent loop: the model either answers or asks for tools; tool calls in one step run in
 * parallel; results are appended and the loop continues until an answer or the step cap.
 */
export async function runAgent({
  provider, system, history, contextText, query, toolbox, ctx, emit, signal,
}) {
  const sources = new Map();
  const transcriptParts = [contextText];
  const register = (rows) => { for (const m of rows || []) if (m?.id != null) sources.set(m.id, m); };
  register(ctx.prefetched);

  const messages = [
    { role: 'system', content: system },
    ...history,
    {
      role: 'user',
      content: `${contextText ? `${contextText}\n\n---\n` : '# No matching WhatsApp messages were found up front — use search/read/chats for archive questions, or web_search for live/public info.\n\n---\n'}Question: ${query}`,
    },
  ];

  let payload = {};
  let answer = '';
  let prevCallSig = '';
  const seenCallSigs = new Set();
  for (let step = 0; step <= GPT_LIMITS.maxSteps; step++) {
    if (signal?.aborted) throw new AbortedError();
    const last = step === GPT_LIMITS.maxSteps;
    if (last) messages.push({ role: 'user', content: 'Tool budget used up. Answer now from what you have — no CALL lines.' });
    if (step > 0) emit?.({ type: 'status', text: 'Writing the answer…' });

    const { text, streamed } = await streamStep(provider, messages, { emit, signal });
    const calls = (last || ctx?.isFollowUpTransform) ? [] : parseToolCalls(text);
    const callSig = JSON.stringify(calls);
    if (calls.length && (callSig === prevCallSig || seenCallSigs.has(callSig))) {
      messages.push({ role: 'user', content: 'You repeated tool calls you already ran. Answer now from what you already have.' });
      const finalStep = await streamStep(provider, messages, { emit, signal });
      answer = stripToolCallLines(finalStep.text);
      if (!finalStep.streamed && answer) emit?.({ type: 'delta', text: answer });
      break;
    }
    prevCallSig = callSig;
    if (calls.length) seenCallSigs.add(callSig);

    if (!calls.length) {
      answer = stripToolCallLines(text);
      if (!streamed && answer) emit?.({ type: 'delta', text: answer });
      break;
    }
    if (streamed) emit?.({ type: 'reset' });

    messages.push({ role: 'assistant', content: calls.map((c) => `CALL ${JSON.stringify({ tool: c.name, args: c.args })}`).join('\n') });
    const budget = Math.floor((ctx?.contextTokens || GPT_LIMITS.contextTokens) / calls.length);
    const results = await Promise.all(calls.map(async (call) => {
      if (ctx?.scopeChatName && (call.name === 'search' || call.name === 'read' || call.name === 'summaries')) {
        if (!call.args) call.args = {};
        const allowedNames = (ctx.turnMentions || []).map((p) => String(p.chatName || '').toLowerCase()).filter(Boolean);
        const requested = String(call.args.chat || '').trim().toLowerCase();
        // Hard-enforce scope on single-chat threads so small models cannot drift to unrelated chats.
        if (!requested || (allowedNames.length <= 1 && requested !== ctx.scopeChatName.toLowerCase())) {
          call.args.chat = ctx.scopeChatName;
        }
      }
      const fn = toolbox[call.name];
      emit?.({ type: 'tool', name: call.name, args: call.args, text: describeCall(call) });
      emit?.({ type: 'status', text: describeCall(call) });
      if (!fn) return `## ${call.name}\nUnknown tool.`;
      try {
        const out = await fn(call.args, budget, ctx);
        register(out.messages);
        if (out.payload) payload = { ...payload, ...out.payload };
        transcriptParts.push(out.text);

        let outText = out.text;
        if (GPT_LIMITS.supervisorNudge && call.name === 'search' && (!out.messages || out.messages.length === 0)) {
          outText += '\n[Supervisor note: 0 messages matched this query. If looking for a person or group, call `chats` to check exact chat names or search with broader keywords.]';
        }
        return `## ${call.name} ${JSON.stringify(call.args)}\n${outText}`;
      } catch (err) {
        return `## ${call.name}\nFailed: ${err.message}`;
      }
    }));
    messages.push({ role: 'user', content: `Tool results:\n\n${results.join('\n\n')}\n\nAnswer the question now, or CALL more tools if truly needed.` });
  }

  const historyText = history.map((m) => m.content).join('\n');
  const userQueries = [query, ...history.filter((m) => m.role === 'user').map((m) => m.content)].join('\n');
  const chatNames = [...new Set([...sources.values()].map((m) => m.chatName).concat(ctx?.scopeChatName || []))].filter(Boolean).join(' ');
  const sourceText = [userQueries, chatNames, ...transcriptParts, historyText, ...[...sources.values()].map(messageBody)].join('\n');
  const grounded = enforceGroundedAnswer(answer, sourceText, userQueries);
  if (grounded.removed.length) {
    console.log(`[GPT] Dropped ${grounded.removed.length} ungrounded fragment(s): ${grounded.removed.slice(0, 5).join(' | ')}`);
  }
  let finalAnswer = grounded.text;
  if (!/[\p{L}\p{N}]/u.test(finalAnswer)) {
    finalAnswer = NO_GROUNDED_ANSWER;
  } else if (grounded.removed.length) {
    const isNegativeOrMeta = /\b(?:no\s+messages?|zero\s+matches|not\s+found|could\s+not\s+find|none\s+found|does\s+not\s+exist|if\s+you\s+need|you'd\s+need|you\s+would\s+need)\b/i.test(finalAnswer);
    if (!isNegativeOrMeta) {
      finalAnswer = `${finalAnswer}\n\n${UNGROUNDED_NOTICE}`;
    }
  }

  const cited = [...finalAnswer.matchAll(REF_RE)].map((m) => Number(m[1]));
  const unknown = cited.filter((id) => !sources.has(id));
  if (unknown.length) {
    finalAnswer = finalAnswer.replace(REF_RE, (full, id) => (sources.has(Number(id)) ? full : ''));
  }
  let citedIds = [...new Set(cited.filter((id) => sources.has(id)))];

  // If the model answered from context but omitted explicit [m...] citation tags,
  // score sources by token overlap against answer + query so we cite the true supporting message(s).
  if (citedIds.length === 0 && finalAnswer !== NO_GROUNDED_ANSWER && sources.size > 0) {
    const lowerAnswer = finalAnswer.toLowerCase();
    const tokenizeForMatch = (s) => [...new Set(
      String(s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    )];
    const targetTokens = tokenizeForMatch(`${finalAnswer} ${query}`);
    let bestId = null;
    let bestScore = 0;
    for (const [id, s] of sources.entries()) {
      const fn = s.mediaPath ? s.mediaPath.split('/').pop().toLowerCase() : '';
      const bodyStr = `${messageBody(s)} ${s.chatName || ''} ${s.sender || ''}`.toLowerCase();
      const textSample = String(s.text || s.mediaCaption || '').trim().toLowerCase();
      if ((fn && lowerAnswer.includes(fn)) || (textSample && textSample.length >= 10 && lowerAnswer.includes(textSample.slice(0, 40)))) {
        citedIds.push(id);
        continue;
      }
      let overlap = 0;
      for (const tok of targetTokens) {
        if (bodyStr.includes(tok)) overlap += 1;
      }
      if (overlap > bestScore) {
        bestScore = overlap;
        bestId = id;
      }
    }
    if (citedIds.length === 0) {
      if (bestId != null && bestScore >= 2) {
        citedIds.push(bestId);
      } else if (Array.isArray(ctx?.prefetched) && ctx.prefetched.length > 0) {
        const top = ctx.prefetched.find((m) => m && sources.has(m.id));
        if (top) citedIds.push(top.id);
      }
    }
  }

  // Accompanying media discovery: if a message is cited, and its sender sent accompanying media
  // (photo, document, menu, receipt) in the same chat segment within 5 minutes, include that media in sources
  // so the media card is rendered directly for the user.
  const extraMedia = [];
  for (const id of citedIds) {
    const citedMsg = sources.get(id);
    if (!citedMsg) continue;
    for (const other of sources.values()) {
      if (other && other.id !== id && (other.mediaType || other.hasMediaFile || other.mediaPath) &&
          other.chatJid === citedMsg.chatJid &&
          (other.sender === citedMsg.sender || Math.abs(other.timestamp - citedMsg.timestamp) <= 300)) {
        if (!citedIds.includes(other.id) && !extraMedia.some((m) => m.id === other.id)) {
          extraMedia.push(other);
        }
      }
    }
  }

  const allSourceRows = [...citedIds.map((id) => sources.get(id)), ...extraMedia];
  return {
    answer: finalAnswer,
    sources: allSourceRows.map((m) => toSource(m, ctx)),
    refs: Object.fromEntries(allSourceRows.map((m) => [m.id, toSource(m, ctx)])),
    payload,
  };
}

function toSource(m, ctx = null) {
  const dirName = m.chatJid && ctx?.directory?.name ? ctx.directory.name(m.chatJid) : null;
  const resolvedName = (m.chatName && !String(m.chatName).includes('@'))
    ? m.chatName
    : (dirName && !String(dirName).includes('@') ? dirName : (m.chatName || m.chatJid));
  return {
    ref: `m${m.id}`,
    text: messageBody(m),
    chatName: resolvedName,
    chatJid: m.chatJid || null,
    messageId: m.messageId || null,
    sender: m.sender || 'Unknown',
    timestamp: m.timestamp,
    mediaType: m.mediaType || null,
    hasMediaFile: Boolean(m.hasMediaFile || m.mediaPath),
    mediaCaption: m.mediaCaption || null,
    mediaAiIndex: m.mediaAiIndex || null,
  };
}
