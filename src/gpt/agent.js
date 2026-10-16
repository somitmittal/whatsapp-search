import { streamChat } from '../llm/stream-chat.js';
import { enforceGroundedAnswer, UNGROUNDED_NOTICE, NO_GROUNDED_ANSWER } from '../search/grounding.js';
import { GPT_LIMITS } from './limits.js';
import { messageBody } from './retrieval.js';

const CALL_RE = /^\s*CALL\s+(\{.*\})\s*$/;
const REF_RE = /\[m(\d+)\]/g;

export class AbortedError extends Error {
  constructor() { super('aborted'); this.name = 'AbortedError'; }
}

export function parseToolCalls(text) {
  const calls = [];
  for (const line of String(text || '').replace(/```(?:json)?/g, '').split('\n')) {
    const m = line.match(CALL_RE);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]);
      const name = String(obj.tool || obj.name || '').trim();
      if (name) calls.push({ name, args: obj.args && typeof obj.args === 'object' ? obj.args : {} });
    } catch { /* model wrote a malformed call; ignore that line */ }
  }
  return calls;
}

function describeCall({ name, args }) {
  const where = args.chat ? ` in ${args.chat}` : '';
  switch (name) {
    case 'search': return `Searching “${args.query || ''}”${where}…`;
    case 'read': return `Reading ${args.chat || 'chat'}${args.date ? ` on ${args.date}` : ''}…`;
    case 'chats': return `Looking up chats${args.query ? ` matching “${args.query}”` : ''}…`;
    case 'summaries': return `Scanning summaries${where}…`;
    case 'reconcile': return `Reconciling expenses${where}…`;
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
    if (head.length < 4 && !head.includes('\n')) return;
    mode = /^(CALL|```)/.test(head) ? 'tool' : 'text';
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
      content: `${contextText ? `${contextText}\n\n---\n` : '# No matching messages were found up front — use tools.\n\n---\n'}Question: ${query}`,
    },
  ];

  let payload = {};
  let answer = '';
  for (let step = 0; step <= GPT_LIMITS.maxSteps; step++) {
    if (signal?.aborted) throw new AbortedError();
    const last = step === GPT_LIMITS.maxSteps;
    if (last) messages.push({ role: 'user', content: 'Tool budget used up. Answer now from what you have — no CALL lines.' });
    if (step > 0) emit?.({ type: 'status', text: 'Writing the answer…' });

    const { text, streamed } = await streamStep(provider, messages, { emit, signal });
    const calls = last ? [] : parseToolCalls(text);
    if (!calls.length) {
      answer = text.split('\n').filter((l) => !CALL_RE.test(l)).join('\n').trim();
      if (!streamed && answer) emit?.({ type: 'delta', text: answer });
      break;
    }
    if (streamed) emit?.({ type: 'reset' });

    messages.push({ role: 'assistant', content: calls.map((c) => `CALL ${JSON.stringify({ tool: c.name, args: c.args })}`).join('\n') });
    const budget = Math.floor(GPT_LIMITS.contextTokens / calls.length);
    const results = await Promise.all(calls.map(async (call) => {
      const fn = toolbox[call.name];
      emit?.({ type: 'tool', name: call.name, args: call.args, text: describeCall(call) });
      emit?.({ type: 'status', text: describeCall(call) });
      if (!fn) return `## ${call.name}\nUnknown tool.`;
      try {
        const out = await fn(call.args, budget, ctx);
        register(out.messages);
        if (out.payload) payload = { ...payload, ...out.payload };
        transcriptParts.push(out.text);
        return `## ${call.name} ${JSON.stringify(call.args)}\n${out.text}`;
      } catch (err) {
        return `## ${call.name}\nFailed: ${err.message}`;
      }
    }));
    messages.push({ role: 'user', content: `Tool results:\n\n${results.join('\n\n')}\n\nAnswer the question now, or CALL more tools if truly needed.` });
  }

  const historyText = history.map((m) => m.content).join('\n');
  const sourceText = [...transcriptParts, historyText, ...[...sources.values()].map(messageBody)].join('\n');
  const grounded = enforceGroundedAnswer(answer, sourceText);
  if (grounded.removed.length) {
    console.log(`[GPT] Dropped ${grounded.removed.length} ungrounded fragment(s): ${grounded.removed.slice(0, 5).join(' | ')}`);
  }
  let finalAnswer = grounded.text;
  if (!/[\p{L}\p{N}]/u.test(finalAnswer)) finalAnswer = NO_GROUNDED_ANSWER;
  else if (grounded.removed.length) finalAnswer = `${finalAnswer}\n\n${UNGROUNDED_NOTICE}`;

  const cited = [...finalAnswer.matchAll(REF_RE)].map((m) => Number(m[1]));
  const unknown = cited.filter((id) => !sources.has(id));
  if (unknown.length) {
    finalAnswer = finalAnswer.replace(REF_RE, (full, id) => (sources.has(Number(id)) ? full : ''));
  }
  const citedIds = [...new Set(cited.filter((id) => sources.has(id)))];
  return {
    answer: finalAnswer,
    sources: citedIds.map((id) => toSource(sources.get(id))),
    refs: Object.fromEntries(citedIds.map((id) => [id, toSource(sources.get(id))])),
    payload,
  };
}

function toSource(m) {
  return {
    ref: `m${m.id}`,
    text: messageBody(m),
    chatName: m.chatName || m.chatJid,
    chatJid: m.chatJid || null,
    messageId: m.messageId || null,
    sender: m.sender || 'Unknown',
    timestamp: m.timestamp,
    mediaType: m.mediaType || null,
  };
}
