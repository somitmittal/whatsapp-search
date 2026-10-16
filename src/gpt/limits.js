/**
 * Budgets for the WhatsApp GPT harness. Values that mirror SmartSearch reuse its constants
 * (synthesis caps were already tuned for small local models); the rest are env-overridable
 * starting points until we have latency / token telemetry per provider.
 */
function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const GPT_LIMITS = Object.freeze({
  /** SmartSearch MAX_MSGS_FOR_SYNTHESIS */
  maxMessagesInContext: envNum('GPT_MAX_CONTEXT_MESSAGES', 50),
  /** SmartSearch MAX_SYNTH_MESSAGE_CHARS */
  messageChars: envNum('GPT_MESSAGE_CHARS', 420),
  /** SmartSearch synthesis maxTokens */
  answerTokens: envNum('GPT_ANSWER_TOKENS', 1500),
  /** SmartSearch MAX_SUMMARY_LINE_CHARS */
  summaryChars: envNum('GPT_SUMMARY_CHARS', 400),
  /** SmartSearch MAX_CANDIDATES_FOR_LLM */
  maxSummaries: envNum('GPT_MAX_SUMMARIES', 36),

  /** Agent loop: tool rounds before forcing a final answer. */
  maxSteps: envNum('GPT_MAX_STEPS', 4),
  /** Retrieved WhatsApp context per LLM call (≈ maxMessagesInContext × messageChars / 4). */
  contextTokens: envNum('GPT_CONTEXT_TOKENS', 6000),
  /** Verbatim conversation history before older turns fold into memory. */
  historyTokens: envNum('GPT_HISTORY_TOKENS', 2500),
  /** Messages on each side of a search hit, so replies like "ok done" keep their question. */
  neighborRadius: envNum('GPT_NEIGHBOR_RADIUS', 2),
  /** Chat directory cache for name → chat resolution. */
  directoryTtlMs: envNum('GPT_DIRECTORY_TTL_MS', 60_000),
});

/** ~4 chars per token (OpenAI rule of thumb); good enough for budget packing. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
