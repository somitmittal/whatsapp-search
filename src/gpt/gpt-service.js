import { randomUUID } from 'node:crypto';
import { getCurrentTenantId, runWithTenant } from '../storage/tenant-context.js';
import ChatDirectory from './chat-directory.js';
import { ContextEngine, buildChatOverview, buildHistory, buildSystemPrompt, expenseDiffBlock } from './context.js';
import { isBroadQuery } from './retrieval.js';
import { runAgent } from './agent.js';
import { createToolbox } from './tools.js';
import { GPT_LIMITS, estimateTokens } from './limits.js';
import { listModelCatalog, providerForSelection, setProviderKey } from './model-registry.js';
import {
  listManagedSkills,
  normalizeSkillIdentity,
  skillFromUserRow,
  skillKey,
} from '../skills/catalog.js';
import { createSkillRunner } from '../skills/skill-runner.js';
import { parseSkillInvocation } from '../skills/parse-invocation.js';
import { SYSTEM_SKILLS } from '../skills/system-skills.js';

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
 * Ask AI threads start scoped to their own chat; explicit @mentions add chats on top.
 * The scope chat always stays first so single-chat tools keep targeting it.
 */
function threadPins(scopeChatJid, scopeChatName, memoryPins, mentions) {
  const merged = mergePins(memoryPins, mentions);
  if (!scopeChatJid) return merged;
  return mergePins(
    [{ type: 'chat', chatJid: scopeChatJid, chatName: scopeChatName }],
    merged.filter((p) => p.chatJid !== scopeChatJid),
  );
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
    this.expenseService = expenseService;
    this.skills = createSkillRunner({ db, directory: this.directory, expenseService });
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

  skillCandidates(query, limit = 12) {
    return this.skills.list(query, limit);
  }

  listManagedSkills() {
    return listManagedSkills(this.db);
  }

  saveUserSkill({
    namespace, slug, name, description = '', body = '', version,
    needsCompleteness = false, inputs = undefined,
  }) {
    const id = normalizeSkillIdentity(namespace, slug);
    const title = String(name || '').trim() || id.slug;
    const builtin = SYSTEM_SKILLS.find((s) => skillKey(s) === skillKey(id));
    const existing = this.db.listUserSkills()
      .map(skillFromUserRow)
      .find((s) => s && skillKey(s) === skillKey(id));
    let nextVersion = Number(version);
    if (!(nextVersion > 0)) {
      nextVersion = existing ? (Number(existing.version) || 1) + 1 : (Number(builtin?.version) || 1);
    }
    const frontmatter = {
      name: title,
      description: String(description || '').trim(),
      needsCompleteness: needsCompleteness != null
        ? !!needsCompleteness
        : !!(existing?.needsCompleteness ?? builtin?.needsCompleteness),
      inputs: inputs && typeof inputs === 'object'
        ? inputs
        : (existing?.inputs || builtin?.inputs || {}),
    };
    const row = this.db.upsertUserSkill({
      namespace: id.namespace,
      slug: id.slug,
      version: nextVersion,
      frontmatter,
      body: String(body || ''),
    });
    return listManagedSkills(this.db).find((s) => s.path === skillKey(id))
      || skillFromUserRow(row);
  }

  deleteUserSkill(namespace, slug) {
    const id = normalizeSkillIdentity(namespace, slug);
    if (!this.db.deleteUserSkill(id.namespace, id.slug)) {
      throw new Error('No custom skill to remove at that path');
    }
    return { ok: true, path: skillKey(id), restored: SYSTEM_SKILLS.some((s) => skillKey(s) === skillKey(id)) };
  }

  mentionCandidates(query, limit = 12) {
    return this.directory.search(query, limit).map((c) => ({
      type: 'chat', chatJid: c.chatJid, chatName: c.chatName, messageCount: c.messageCount, lastMessageTs: c.lastMessageTs,
    }));
  }

  async handleTurn({
    conversationId = null, createConversationIfMissing = false, message, scopeChatJid = null, mentions = [], businessContext = false, model = undefined,
    emit = null, signal = null,
  }) {
    const text = String(message || '').trim();
    if (!text) throw new Error('message is required');
    if (parseSkillInvocation(text)) {
      return this._handleSkillTurn({
        conversationId, createConversationIfMissing, message: text, scopeChatJid, mentions, model, emit,
      });
    }
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
    if (conversationId && !conversation && !createConversationIfMissing) throw new Error('Conversation not found');
    if (!conversation) {
      conversation = this.db.createSearchConversation({ id: conversationId || randomUUID(), title: titleFrom(text), chatJid: scopeChatJid });
    }
    const effectiveScopeChatJid = scopeChatJid || conversation.chatJid || null;
    // Let the tab persist the conversation before context gathering or a skill run
    // starts. The user may switch tabs while that work is still in progress.
    emit?.({ type: 'conversation', conversationId: conversation.id, newConversation: !conversationId || createConversationIfMissing });
    if (model !== undefined && JSON.stringify(existingModel) !== JSON.stringify(resolved.selection)) {
      this.db.setConversationModel(conversation.id, resolved.selection);
    }
    const memory = this.db.getConversationMemory(conversation.id);
    const resolvedMentions = (mentions || []).map((p) => (p?.chatJid
      ? { type: 'chat', chatJid: p.chatJid, chatName: p.chatName || this.directory.name(p.chatJid) }
      : null)).filter(Boolean);
    const pins = threadPins(
      effectiveScopeChatJid,
      effectiveScopeChatJid ? this.directory.name(effectiveScopeChatJid) : null,
      memory.pins,
      resolvedMentions,
    );
    if (JSON.stringify(pins) !== JSON.stringify(memory.pins)) this.db.setConversationPins(conversation.id, pins);

    const prior = this.db.listSearchMessages(conversation.id);
    this.db.addSearchMessage({
      id: randomUUID(), conversationId: conversation.id, role: 'user', content: text,
      payload: { scopeChatJid: effectiveScopeChatJid, mentions: resolvedMentions },
    });

    const scopeJids = pins.map((p) => p.chatJid);
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
    const overview = provider.name === 'ollama'
      && /\b1b\b/i.test(String(provider.model || ''))
      && isBroadQuery(text) && scopeJids.length === 1 && !pre.range
      ? buildChatOverview(pins.find((p) => p.chatJid === scopeJids[0])?.chatName || this.directory.name(scopeJids[0]), pre.messages)
      : null;
    const result = overview || await runAgent({
      provider,
      system: buildSystemPrompt({ db: this.db, businessContext }),
      history,
      contextText,
      query: text,
      toolbox: this.toolbox,
      ctx: { status, scopeChatJid: effectiveScopeChatJid || scopeJids[0] || null, prefetched: pre.messages },
      emit,
      signal,
    });
    if (overview) emit?.({ type: 'delta', text: overview.answer });

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

  /**
   * Slash command. Resolved from the skill catalog before any model call, then executed
   * as a dry run. Sending the report is a separate confirm.
   */
  async _handleSkillTurn({ conversationId = null, createConversationIfMissing = false, message, scopeChatJid = null, mentions = [], model = undefined, emit = null }) {
    const text = String(message || '').trim();
    const status = (line) => emit?.({ type: 'status', text: line });
    let conversation = conversationId ? this.db.getSearchConversation(conversationId) : null;
    if (conversationId && !conversation && !createConversationIfMissing) throw new Error('Conversation not found');
    if (!conversation) {
      conversation = this.db.createSearchConversation({ id: conversationId || randomUUID(), title: titleFrom(text), chatJid: scopeChatJid });
    }
    const effectiveScopeChatJid = scopeChatJid || conversation.chatJid || null;
    // Slash commands can take long enough for the user to navigate away. Publish
    // the durable ID first so the draft tab is recoverable even if its stream closes.
    emit?.({ type: 'conversation', conversationId: conversation.id, newConversation: !conversationId || createConversationIfMissing });
    const existingModel = this.db.getConversationModel(conversation.id);
    const selection = model === undefined ? existingModel : model;
    const resolveExpenseProvider = async () => {
      const resolved = await this._resolveProvider(this.db, selection, this.getProvider());
      if (model !== undefined && JSON.stringify(existingModel) !== JSON.stringify(resolved.selection)) {
        this.db.setConversationModel(conversation.id, resolved.selection);
      }
      return resolved.provider;
    };
    const memory = this.db.getConversationMemory(conversation.id);
    const resolvedMentions = (mentions || []).map((p) => (p?.chatJid
      ? { type: 'chat', chatJid: p.chatJid, chatName: p.chatName || this.directory.name(p.chatJid) }
      : null)).filter(Boolean);
    const pins = threadPins(
      effectiveScopeChatJid,
      effectiveScopeChatJid ? this.directory.name(effectiveScopeChatJid) : null,
      memory.pins,
      resolvedMentions,
    );
    if (JSON.stringify(pins) !== JSON.stringify(memory.pins)) this.db.setConversationPins(conversation.id, pins);

    this.db.addSearchMessage({
      id: randomUUID(), conversationId: conversation.id, role: 'user', content: text,
      payload: { scopeChatJid: effectiveScopeChatJid, mentions: resolvedMentions, skill: true },
    });

    const outcome = await this.skills.run({
      text,
      mentions: pins,
      scopeChatJid: effectiveScopeChatJid || pins.find((p) => String(p.chatJid).endsWith('@g.us'))?.chatJid || null,
      conversationId: conversation.id,
      status,
      resolveProvider: resolveExpenseProvider,
    });
    const assistant = this.db.addSearchMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: outcome.answer,
      payload: {
        kind: outcome.expenseDiff ? 'expense_diff' : 'skill',
        steps: outcome.steps || [],
        choices: outcome.choices || [],
        ...(outcome.skillRun ? { skillRun: outcome.skillRun } : {}),
        ...(outcome.expenseDiff ? { expenseDiff: outcome.expenseDiff } : {}),
      },
    });
    if (outcome.skillRun?.id) this.db.updateSkillRun(outcome.skillRun.id, { messageId: assistant.id });

    const fresh = this.getConversation(conversation.id);
    return {
      conversationId: conversation.id,
      conversation: fresh.conversation,
      messages: fresh.messages,
      message: assistant,
      answer: outcome.answer,
      sources: [],
      expenseDiff: outcome.expenseDiff || null,
      model: null,
    };
  }

  /** Confirm a dry run: post the report that was already written. */
  async sendSkillReport(skillRunId) {
    const run = this.db.getSkillRun(skillRunId);
    if (!run) throw new Error('Skill run not found');
    if (run.status === 'sent') return { skillRun: run, alreadySent: true };
    if (run.status !== 'dry_run' || !run.expenseRunId) throw new Error('This run has no report to send');
    if (!this.expenseService?.sendCompletedReport) throw new Error('Expense reconciliation is not enabled on this install.');
    await this.expenseService.sendCompletedReport(run.expenseRunId);
    const updated = this.db.updateSkillRun(run.id, { status: 'sent' });
    if (run.messageId) {
      const msg = this.db.getSearchMessage(run.messageId);
      if (msg?.payload?.skillRun) {
        msg.payload.skillRun = { ...msg.payload.skillRun, status: 'sent', canSend: false };
        this.db.updateSearchMessagePayload(run.messageId, msg.payload);
      }
    }
    return { skillRun: updated };
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
