import { randomUUID } from 'node:crypto';
import { getCurrentTenantId, runWithTenant } from '../storage/tenant-context.js';
import ChatDirectory from './chat-directory.js';
import { ContextEngine, buildHistory, buildSystemPrompt, expenseDiffBlock } from './context.js';
import { runAgent } from './agent.js';
import { createToolbox } from './tools.js';
import { GPT_LIMITS, estimateTokens } from './limits.js';
import { listModelCatalog, providerForSelection, setProviderKey } from './model-registry.js';

function titleFrom(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  return t.length <= 72 ? t : `${t.slice(0, 69)}…`;
}

function mergePins(existing, incoming) {
  const out = [...(existing || [])];
  for (const p of incoming || []) {
    if (p?.type === 'chat' && p.chatJid && !out.some((x) => x.type === 'chat' && x.chatJid === p.chatJid)) {
      out.push({ type: 'chat', chatJid: p.chatJid, chatName: p.chatName || null });
    }
  }
  return out;
}

/**
 * WhatsApp GPT turn orchestration: pins (@chat mentions), auto-context, agent loop with tools,
 * persistence, and background memory compaction of older turns.
 */
export default class GptService {
  constructor({ db, getProvider, embeddings = null, expenseService = null, resolveProvider = providerForSelection }) {
    this.db = db;
    this.getProvider = getProvider;
    this._resolveProvider = resolveProvider;
    this.directory = new ChatDirectory(db);
    this.context = new ContextEngine({ db, embeddings, directory: this.directory });
    this.toolbox = createToolbox({ db, embeddings, directory: this.directory, expenseService });
    this._compacting = new Set();
  }

  listConversations(limit = 50) {
    return this.db.listSearchConversations(limit);
  }

  getConversation(id) {
    const conversation = this.db.getSearchConversation(id);
    if (!conversation) return null;
    const memory = this.db.getConversationMemory(id);
    return {
      conversation: { ...conversation, pins: memory?.pins || [], model: this.db.getConversationModel(id) },
      messages: this.db.listSearchMessages(id),
    };
  }

  listModels() {
    return listModelCatalog(this.db);
  }

  setProviderKey(provider, apiKey) {
    setProviderKey(this.db, provider, apiKey);
  }

  deleteConversation(id) {
    return this.db.deleteSearchConversation(id);
  }

  setPins(id, pins) {
    if (!this.db.getSearchConversation(id)) return null;
    this.db.setConversationPins(id, mergePins([], pins));
    return this.db.getConversationMemory(id).pins;
  }

  mentionCandidates(query, limit = 12) {
    return this.directory.search(query, limit).map((c) => ({
      type: 'chat', chatJid: c.chatJid, chatName: c.chatName, messageCount: c.messageCount, lastMessageTs: c.lastMessageTs,
    }));
  }

  async handleTurn({
    conversationId = null, message, scopeChatJid = null, mentions = [], businessContext = false, model = undefined,
    emit = null, signal = null,
  }) {
    const text = String(message || '').trim();
    if (!text) throw new Error('message is required');
    // `model` undefined → keep the thread's choice; null → back to Auto; object → explicit pick.
    const existingModel = conversationId ? this.db.getConversationModel(conversationId) : null;
    const selection = model === undefined ? existingModel : model;
    const resolved = await this._resolveProvider(this.db, selection, this.getProvider());
    const provider = resolved.provider;
    if (!provider) throw new Error('No AI provider configured — pick a model from the picker or Settings.');
    const steps = [];
    const sink = emit;
    emit = (event) => {
      if (event?.type === 'tool') steps.push(event.text);
      sink?.(event);
    };
    const status = (line) => emit?.({ type: 'status', text: line });
    status('Gathering context…');

    let conversation = conversationId ? this.db.getSearchConversation(conversationId) : null;
    if (conversationId && !conversation) throw new Error('Conversation not found');
    if (!conversation) {
      conversation = this.db.createSearchConversation({ id: randomUUID(), title: titleFrom(text), chatJid: scopeChatJid });
    }
    if (model !== undefined && JSON.stringify(existingModel) !== JSON.stringify(resolved.selection)) {
      this.db.setConversationModel(conversation.id, resolved.selection);
    }
    const memory = this.db.getConversationMemory(conversation.id);
    const resolvedMentions = (mentions || []).map((p) => (p?.chatJid
      ? { type: 'chat', chatJid: p.chatJid, chatName: p.chatName || this.directory.name(p.chatJid) }
      : null)).filter(Boolean);
    const pins = mergePins(memory.pins, resolvedMentions);
    if (pins.length !== memory.pins.length) this.db.setConversationPins(conversation.id, pins);

    const prior = this.db.listSearchMessages(conversation.id);
    this.db.addSearchMessage({
      id: randomUUID(), conversationId: conversation.id, role: 'user', content: text,
      payload: { scopeChatJid, mentions: resolvedMentions },
    });

    const scopeJids = [...pins.map((p) => p.chatJid), scopeChatJid].filter(Boolean);
    const lastExpense = [...prior].reverse().find((m) => m.role === 'assistant' && m.payload?.expenseDiff);
    const [pre] = await Promise.all([this.context.prefetch({ query: text, scopeJids })]);
    const contextText = [
      pins.length ? `# Pinned chats: ${pins.map((p) => p.chatName || p.chatJid).join(', ')}` : '',
      lastExpense ? expenseDiffBlock(lastExpense.payload.expenseDiff) : '',
      pre.text,
    ].filter(Boolean).join('\n\n');
    if (pre.messages.length) {
      const chats = new Set(pre.messages.map((m) => m.chatJid)).size;
      emit({ type: 'tool', text: `Pulled ${pre.messages.length} relevant messages from ${chats} chat${chats === 1 ? '' : 's'}${pre.range ? ` (${pre.range.label})` : ''}` });
    }
    status('Thinking…');

    const { messages: history } = buildHistory(prior, memory);
    const result = await runAgent({
      provider,
      system: buildSystemPrompt({ db: this.db, businessContext }),
      history,
      contextText,
      query: text,
      toolbox: this.toolbox,
      ctx: { status, scopeChatJid: scopeJids[0] || null, prefetched: pre.messages },
      emit,
      signal,
    });

    const expenseDiff = result.payload.expenseDiff || null;
    const assistant = this.db.addSearchMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: result.answer,
      payload: {
        kind: expenseDiff ? 'expense_diff' : 'gpt',
        sources: result.sources,
        refs: result.refs,
        steps,
        model: { provider: provider.name, model: provider.model },
        ...(expenseDiff ? { expenseDiff } : {}),
      },
    });

    this._scheduleCompaction(conversation.id, provider);
    const fresh = this.getConversation(conversation.id);
    return {
      conversationId: conversation.id,
      conversation: fresh.conversation,
      messages: fresh.messages,
      message: assistant,
      answer: result.answer,
      sources: result.sources,
      expenseDiff,
      model: { provider: provider.name, model: provider.model },
    };
  }

  /** Folds turns that no longer fit the history budget into the rolling memory, off the hot path. */
  _scheduleCompaction(conversationId, provider) {
    if (this._compacting.has(conversationId)) return;
    const tenant = getCurrentTenantId();
    this._compacting.add(conversationId);
    setImmediate(() => runWithTenant(tenant, async () => {
      try {
        const memory = this.db.getConversationMemory(conversationId);
        const prior = this.db.listSearchMessages(conversationId);
        const { overflow } = buildHistory(prior, memory);
        if (overflow <= 0) return;
        const start = memory.memoryUpto || 0;
        const fold = prior.slice(start, start + overflow);
        const transcript = fold.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n\n');
        const budgetChars = GPT_LIMITS.historyTokens * 2;
        const next = await provider.chat([
          {
            role: 'system',
            content: 'Maintain a compact memory of a conversation about the user\'s WhatsApp chats. Keep: what was asked, '
              + 'conclusions reached, exact names/amounts/dates and [m123] handles, open threads. Drop pleasantries. Plain bullets.',
          },
          {
            role: 'user',
            content: `${memory.memory ? `Current memory:\n${memory.memory}\n\n` : ''}New turns to fold in:\n${transcript}\n\nReturn the updated memory only.`,
          },
        ], { maxTokens: Math.ceil(budgetChars / 4), temperature: 0 });
        const trimmed = String(next || '').trim();
        if (trimmed && estimateTokens(trimmed) <= GPT_LIMITS.historyTokens) {
          this.db.setConversationMemory(conversationId, { memory: trimmed, memoryUpto: start + overflow });
        }
      } catch (err) {
        console.warn('[GPT] memory compaction:', err.message);
      } finally {
        this._compacting.delete(conversationId);
      }
    }));
  }
}
