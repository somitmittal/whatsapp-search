import { initFetchShim } from '/js/fetch-shim.js';
import { esc, escAttr } from '/js/util.js';
import { renderExpenseDiff } from '/js/expense-sheet-view.js';

initFetchShim();

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#gpt-app'),
  threads: $('#gpt-threads'),
  filter: $('#gpt-thread-filter'),
  thread: $('#gpt-thread'),
  scroll: $('#gpt-scroll'),
  empty: $('#gpt-empty'),
  suggest: $('#gpt-suggest'),
  input: $('#gpt-input'),
  send: $('#gpt-send'),
  pills: $('#gpt-pills'),
  mention: $('#gpt-mention'),
  title: $('#gpt-title'),
  model: $('#gpt-model'),
  modelBtn: $('#gpt-model-btn'),
  modelLabel: $('#gpt-model-label'),
  modelMenu: $('#gpt-model-menu'),
  modelFilter: $('#gpt-model-filter'),
  modelList: $('#gpt-model-list'),
  modelManage: $('#gpt-model-manage'),
};

const HIDDEN_MODELS_KEY = 'wgpt.hiddenModels';

const state = {
  conversationId: null,
  pins: [],
  conversations: [],
  streaming: null,
  mention: { open: false, items: [], index: 0, ctrl: null },
  /** null = Auto (app default); { provider, model } = explicit pick for this thread. */
  model: null,
  /** True once the user changed the picker since the thread loaded, so the next send carries it. */
  modelDirty: false,
  catalog: null,
  manageModels: false,
  hiddenModels: new Set(JSON.parse(localStorage.getItem(HIDDEN_MODELS_KEY) || '[]')),
};

const SUGGESTIONS = [
  'Catch me up on everything important from today',
  'What did I promise to do for people this week?',
  'Who is waiting on a reply from me?',
  'Summarize the last week in my busiest group',
];

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (window.SearchableAccount) Object.assign(h, window.SearchableAccount.authHeaders());
  return h;
}

/* ── Markdown (small, escape-first) ───────────────────────────────── */

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
}

function renderMarkdown(src, refs = {}) {
  const order = [];
  const cite = (id) => {
    let n = order.indexOf(id);
    if (n < 0) { order.push(id); n = order.length - 1; }
    const r = refs[id];
    const tip = r ? `${r.sender} · ${r.chatName}: ${String(r.text || '').slice(0, 140)}` : `Message m${id}`;
    return `<button type="button" class="cite" data-ref="${escAttr(id)}" title="${escAttr(tip)}">${n + 1}</button>`;
  };
  const blocks = String(src || '').split(/```/);
  let html = '';
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      html += `<pre><code>${esc(block.replace(/^\w*\n/, ''))}</code></pre>`;
      return;
    }
    const lines = esc(block).split('\n');
    let list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    let para = [];
    const flush = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
    for (const raw of lines) {
      const line = inline(raw).replace(/\[m(\d+)\]/g, (_, id) => cite(id));
      const h = raw.match(/^(#{1,3})\s+(.*)$/);
      const ul = raw.match(/^\s*[-*•]\s+(.*)$/);
      const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) { flush(); close(); html += `<h${h[1].length + 2}>${line.replace(/^#{1,3}\s+/, '')}</h${h[1].length + 2}>`; continue; }
      if (ul || ol) {
        flush();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { close(); html += `<${want}>`; list = want; }
        html += `<li>${line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')}</li>`;
        continue;
      }
      if (!raw.trim()) { flush(); close(); continue; }
      close();
      para.push(line);
    }
    flush(); close();
  });
  return html;
}

/* ── Time helpers ─────────────────────────────────────────────────── */

function fmtTs(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function bucket(ts) {
  const d = new Date(ts * 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return 'Older';
}

/* ── Threads sidebar ──────────────────────────────────────────────── */

async function loadThreads() {
  try {
    const res = await fetch('/api/gpt/conversations?limit=100', { headers: authHeaders() });
    const data = await res.json();
    state.conversations = data.conversations || [];
  } catch { state.conversations = []; }
  renderThreads();
}

function renderThreads() {
  const q = els.filter.value.trim().toLowerCase();
  const rows = state.conversations.filter((c) => !q || String(c.title || '').toLowerCase().includes(q));
  let html = '';
  let last = '';
  for (const c of rows) {
    const b = bucket(c.updatedAt || c.createdAt);
    if (b !== last) { html += `<div class="gpt-bucket">${b}</div>`; last = b; }
    const active = c.id === state.conversationId ? ' active' : '';
    html += `<div class="gpt-thread-item${active}" data-id="${escAttr(c.id)}">
      <span class="t">${esc(c.title || 'Untitled')}</span>
      <button type="button" class="del" data-del="${escAttr(c.id)}" title="Delete thread" aria-label="Delete thread">×</button>
    </div>`;
  }
  els.threads.innerHTML = html || '<div class="gpt-bucket muted">No threads yet</div>';
}

async function openConversation(id, { pushUrl = true } = {}) {
  abortStream();
  const res = await fetch(`/api/gpt/conversations/${encodeURIComponent(id)}`, { headers: authHeaders() });
  if (!res.ok) { newChat(); return; }
  const data = await res.json();
  state.conversationId = id;
  state.pins = (data.conversation?.pins || []).map((p) => ({ ...p, saved: true }));
  state.model = data.conversation?.model || null;
  state.modelDirty = false;
  renderModelLabel();
  els.title.textContent = data.conversation?.title || 'WhatsApp GPT';
  renderMessages(data.messages || []);
  renderPills();
  renderThreads();
  if (pushUrl) history.replaceState(null, '', `/gpt?c=${encodeURIComponent(id)}`);
  if (matchMedia('(max-width: 820px)').matches) els.app.classList.add('side-hidden');
}

function newChat() {
  abortStream();
  state.conversationId = null;
  state.pins = state.pins.filter((p) => !p.saved);
  els.thread.innerHTML = '';
  els.title.textContent = 'WhatsApp GPT';
  els.empty.hidden = false;
  history.replaceState(null, '', '/gpt');
  // Keep the current pick for the new thread (Cursor does the same); it is sent with the first message.
  state.modelDirty = !!state.model;
  renderModelLabel();
  renderPills();
  renderThreads();
  els.input.focus();
}

/* ── Message rendering ────────────────────────────────────────────── */

function sourceCards(sources = []) {
  if (!sources.length) return '';
  const who = [...new Set(sources.map((s) => s.chatName).filter(Boolean))].slice(0, 2).join(', ');
  return `<details class="gpt-sources-wrap"><summary>${sources.length} source${sources.length === 1 ? '' : 's'}${who ? ` · ${esc(who)}` : ''}</summary>
    <div class="gpt-sources">${sources.map((s, i) => `
    <a class="gpt-source" href="/?chat=${encodeURIComponent(s.chatJid || '')}&msg=${encodeURIComponent(s.messageId || '')}" target="searchable-main" data-ref="${escAttr(String(s.ref || '').replace(/^m/, ''))}">
      <span class="n">${i + 1}</span>
      <span class="meta">${esc(s.sender)} · ${esc(s.chatName || '')} · ${esc(fmtTs(s.timestamp))}</span>
      <span class="txt">${esc(String(s.text || '').slice(0, 180))}</span>
    </a>`).join('')}</div></details>`;
}

function stepsHtml(steps = [], open = false) {
  if (!steps.length) return '';
  const label = steps.length === 1 ? steps[0] : `${steps.length} steps`;
  return `<details class="gpt-steps"${open ? ' open' : ''}><summary>${esc(label)}</summary>
    <ul>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>`;
}

function assistantHtml(m) {
  const p = m.payload || {};
  const model = p.model?.model ? `<span class="gpt-msg-model" title="${escAttr(`${p.model.provider} · ${p.model.model}`)}">${esc(shortModel(p.model.model))}</span>` : '';
  return `<div class="gpt-msg gpt-assistant">
    ${stepsHtml(p.steps || [])}
    <div class="gpt-md">${renderMarkdown(m.content, p.refs || {})}</div>
    ${p.expenseDiff ? renderExpenseDiff(p.expenseDiff) : ''}
    <div class="gpt-msg-foot">${sourceCards(p.sources || [])}${model}</div>
  </div>`;
}

function userHtml(m) {
  const mentions = m.payload?.mentions || [];
  const chips = mentions.length
    ? `<div class="gpt-user-ctx">${mentions.map((p) => `<span class="pill">@${esc(p.chatName || p.chatJid)}</span>`).join('')}</div>`
    : '';
  return `<div class="gpt-msg gpt-user">${chips}<div class="bubble">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
}

function renderMessages(messages) {
  els.empty.hidden = messages.length > 0;
  els.thread.innerHTML = messages.map((m) => (m.role === 'assistant' ? assistantHtml(m) : userHtml(m))).join('');
  scrollToBottom(true);
}

function nearBottom() {
  const s = els.scroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) els.scroll.scrollTop = els.scroll.scrollHeight;
}

/* ── Model picker ─────────────────────────────────────────────────── */

function shortModel(id) {
  return String(id || '').replace(/^[^/]+\//, '').replace(/:free$/, '').replace(/-latest$/, '');
}

function modelKey(provider, model) { return `${provider}/${model}`; }

function providerName(id) {
  return state.catalog?.providers.find((p) => p.id === id)?.name || id;
}

async function loadModels() {
  try {
    const res = await fetch('/api/gpt/models', { headers: authHeaders() });
    state.catalog = await res.json();
  } catch { state.catalog = null; }
  renderModelLabel();
  if (!els.modelMenu.hidden) renderModelMenu();
}

function renderModelLabel() {
  const def = state.catalog?.default;
  if (state.model) {
    els.modelLabel.textContent = shortModel(state.model.model);
    els.modelBtn.title = `${providerName(state.model.provider)} · ${state.model.model} (this thread)`;
    els.model.textContent = `${providerName(state.model.provider)} · ${shortModel(state.model.model)}`;
  } else {
    els.modelLabel.textContent = 'Auto';
    els.modelBtn.title = def ? `Auto — uses your default: ${providerName(def.provider)} · ${def.model}` : 'Auto';
    els.model.textContent = def ? `Auto · ${shortModel(def.model)}` : '';
  }
}

function setModel(selection) {
  state.model = selection;
  state.modelDirty = true;
  renderModelLabel();
}

function toggleHidden(key) {
  if (state.hiddenModels.has(key)) state.hiddenModels.delete(key);
  else state.hiddenModels.add(key);
  localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...state.hiddenModels]));
  renderModelMenu();
}

function renderModelMenu() {
  const cat = state.catalog;
  if (!cat) { els.modelList.innerHTML = '<div class="gpt-model-empty">Could not load models.</div>'; return; }
  const q = els.modelFilter.value.trim().toLowerCase();
  const manage = state.manageModels;
  els.modelManage.classList.toggle('on', manage);
  els.modelManage.textContent = manage ? 'Done' : 'Manage';

  const selectedKey = state.model ? modelKey(state.model.provider, state.model.model) : null;
  let html = '';
  if (!q) {
    html += `<button type="button" class="gpt-model-opt${state.model ? '' : ' on'}" data-auto="1" role="option">
      <span class="chk">${state.model ? '' : '✓'}</span>
      <span class="nm">Auto</span>
      <span class="sub">${esc(providerName(cat.default.provider))} · ${esc(shortModel(cat.default.model))}</span>
    </button>`;
  }
  const providers = [...cat.providers].sort((a, b) => Number(b.configured) - Number(a.configured));
  for (const p of providers) {
    const rows = p.models.filter((m) => {
      const hidden = state.hiddenModels.has(modelKey(p.id, m));
      if (hidden && !manage) return false;
      return !q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
    });
    if (!rows.length && !(manage && !q)) continue;
    const tag = p.id === 'ollama' ? 'local' : p.free ? 'free tier' : 'paid';
    html += `<div class="gpt-model-group">
      <div class="gpt-model-group-head">
        <span class="gname">${esc(p.name)}</span>
        <span class="gtag">${tag}</span>
        ${p.configured ? '' : `<button type="button" class="gkey" data-addkey="${escAttr(p.id)}">Add API key</button>`}
      </div>
      <div class="gpt-model-keyrow" data-keyrow="${escAttr(p.id)}" hidden>
        <input type="password" placeholder="${esc(p.name)} API key" autocomplete="off" data-keyinput="${escAttr(p.id)}">
        <button type="button" data-savekey="${escAttr(p.id)}">Save</button>
      </div>`;
    for (const m of rows) {
      const key = modelKey(p.id, m);
      const hidden = state.hiddenModels.has(key);
      const on = key === selectedKey;
      html += `<button type="button" class="gpt-model-opt${on ? ' on' : ''}${p.configured ? '' : ' off'}${hidden ? ' hidden-model' : ''}"
          role="option" data-provider="${escAttr(p.id)}" data-model="${escAttr(m)}" ${p.configured || manage ? '' : 'disabled'}>
        <span class="chk">${on ? '✓' : ''}</span>
        <span class="nm">${esc(shortModel(m))}</span>
        <span class="sub">${esc(m !== shortModel(m) ? m : '')}</span>
        ${manage ? `<span class="eye" data-eye="${escAttr(key)}" title="${hidden ? 'Show in list' : 'Hide from list'}">${hidden ? 'Hidden' : 'Shown'}</span>` : ''}
      </button>`;
    }
    html += '</div>';
  }
  els.modelList.innerHTML = html || '<div class="gpt-model-empty">No models match.</div>';
}

function openModelMenu(open) {
  els.modelMenu.hidden = !open;
  els.modelBtn.classList.toggle('open', open);
  if (open) {
    if (!state.catalog) void loadModels();
    renderModelMenu();
    els.modelFilter.value = '';
    els.modelFilter.focus();
  } else {
    state.manageModels = false;
  }
}

async function saveProviderKey(provider, apiKey) {
  const res = await fetch('/api/gpt/models/key', {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify({ provider, apiKey }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not save key');
  }
  await loadModels();
  renderModelMenu();
}

/* ── Pills + @mentions ────────────────────────────────────────────── */

function renderPills() {
  els.pills.innerHTML = state.pins.map((p, i) => `
    <span class="pill" title="${escAttr(p.chatJid)}">@${esc(p.chatName || p.chatJid)}
      <button type="button" data-unpin="${i}" aria-label="Remove">×</button></span>`).join('');
  els.pills.hidden = state.pins.length === 0;
}

async function unpin(index) {
  const [removed] = state.pins.splice(index, 1);
  renderPills();
  if (removed?.saved && state.conversationId) {
    await fetch(`/api/gpt/conversations/${encodeURIComponent(state.conversationId)}/pins`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ pins: state.pins.filter((p) => p.saved) }),
    }).catch(() => {});
  }
}

function addPin(item) {
  if (!item?.chatJid || state.pins.some((p) => p.chatJid === item.chatJid)) return;
  state.pins.push({ type: 'chat', chatJid: item.chatJid, chatName: item.chatName });
  renderPills();
}

function mentionQuery() {
  const el = els.input;
  const before = el.value.slice(0, el.selectionStart);
  const m = before.match(/(^|\s)@([^\s@]{0,40})$/);
  return m ? { query: m[2], start: before.length - m[2].length - 1 } : null;
}

async function updateMention() {
  const mq = mentionQuery();
  if (!mq) return closeMention();
  state.mention.ctrl?.abort();
  const ctrl = new AbortController();
  state.mention.ctrl = ctrl;
  try {
    const res = await fetch(`/api/gpt/mentions?q=${encodeURIComponent(mq.query)}`, { headers: authHeaders(), signal: ctrl.signal });
    const data = await res.json();
    state.mention.items = data.items || [];
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.mention.items = [];
  }
  state.mention.index = 0;
  state.mention.open = true;
  renderMention();
}

function renderMention() {
  const { items, index } = state.mention;
  els.mention.hidden = !state.mention.open;
  els.mention.innerHTML = items.length
    ? items.map((c, i) => `<div class="opt${i === index ? ' on' : ''}" role="option" data-i="${i}">
        <span class="nm">${esc(c.chatName)}</span>
        <span class="sub">${c.messageCount} msgs${c.lastMessageTs ? ` · ${esc(fmtTs(c.lastMessageTs))}` : ''}</span></div>`).join('')
    : '<div class="opt muted">No matching chats</div>';
}

function closeMention() {
  state.mention.open = false;
  els.mention.hidden = true;
}

function pickMention(i) {
  const item = state.mention.items[i];
  const mq = mentionQuery();
  if (!item) return closeMention();
  if (mq) {
    const el = els.input;
    el.value = el.value.slice(0, mq.start) + el.value.slice(el.selectionStart);
    el.selectionStart = el.selectionEnd = mq.start;
  }
  addPin(item);
  closeMention();
  autosize();
  els.input.focus();
}

/* ── Streaming turn ───────────────────────────────────────────────── */

function setStreaming(on) {
  els.app.classList.toggle('is-streaming', on);
  els.send.title = on ? 'Stop' : 'Send';
}

function abortStream() {
  state.streaming?.ctrl.abort();
  state.streaming = null;
  setStreaming(false);
}

function liveBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'gpt-msg gpt-assistant live';
  wrap.innerHTML = `<details class="gpt-steps" open><summary>Thinking…</summary><ul></ul></details>
    <div class="gpt-md"><span class="caret"></span></div>`;
  els.thread.appendChild(wrap);
  return {
    wrap,
    summary: wrap.querySelector('summary'),
    list: wrap.querySelector('ul'),
    md: wrap.querySelector('.gpt-md'),
    text: '',
    frame: 0,
  };
}

function paintLive(live) {
  if (live.frame) return;
  live.frame = requestAnimationFrame(() => {
    live.frame = 0;
    live.md.innerHTML = `${renderMarkdown(live.text)}<span class="caret"></span>`;
    scrollToBottom();
  });
}

async function send(textOverride = null) {
  if (state.streaming) { abortStream(); return; }
  const text = String(textOverride ?? els.input.value).trim();
  if (!text) return;
  closeMention();
  els.input.value = '';
  autosize();
  els.empty.hidden = true;

  const mentions = state.pins.filter((p) => !p.saved).map((p) => ({ type: 'chat', chatJid: p.chatJid, chatName: p.chatName }));
  els.thread.insertAdjacentHTML('beforeend', userHtml({ content: text, payload: { mentions } }));
  const live = liveBubble();
  scrollToBottom(true);

  const ctrl = new AbortController();
  state.streaming = { ctrl };
  setStreaming(true);
  const steps = [];

  try {
    const res = await fetch('/api/gpt/chat', {
      method: 'POST',
      headers: authHeaders(),
      signal: ctrl.signal,
      body: JSON.stringify({
        message: text,
        conversationId: state.conversationId || undefined,
        mentions: state.pins.map((p) => ({ type: 'chat', chatJid: p.chatJid, chatName: p.chatName })),
        ...(state.modelDirty ? { model: state.model } : {}),
        installId: window.SearchableAccount?.getInstallId?.(),
      }),
    });
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json();
      live.wrap.remove();
      showError(data.error || 'Request failed', data.code);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'status') {
          live.summary.textContent = ev.text;
        } else if (ev.type === 'tool') {
          steps.push(ev.text);
          live.list.insertAdjacentHTML('beforeend', `<li>${esc(ev.text)}</li>`);
        } else if (ev.type === 'delta') {
          live.text += ev.text || '';
          paintLive(live);
        } else if (ev.type === 'reset') {
          live.text = '';
          paintLive(live);
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'Something went wrong');
        } else if (ev.type === 'done') {
          done = ev;
        }
      }
    }
    if (!done) throw new Error('The answer stream ended early.');
    cancelAnimationFrame(live.frame);
    const msg = done.message || { content: done.answer, payload: { sources: done.sources, expenseDiff: done.expenseDiff } };
    live.wrap.outerHTML = assistantHtml(msg);
    const isNew = !state.conversationId;
    state.conversationId = done.conversationId;
    state.pins = (done.conversation?.pins || []).map((p) => ({ ...p, saved: true }));
    state.model = done.conversation?.model || null;
    state.modelDirty = false;
    renderModelLabel();
    renderPills();
    els.title.textContent = done.conversation?.title || els.title.textContent;
    if (isNew) history.replaceState(null, '', `/gpt?c=${encodeURIComponent(done.conversationId)}`);
    void loadThreads();
  } catch (err) {
    if (err.name === 'AbortError') {
      live.wrap.classList.remove('live');
      live.md.innerHTML = `${renderMarkdown(live.text)}<p class="muted">Stopped.</p>`;
    } else {
      live.wrap.remove();
      showError(err.message);
    }
  } finally {
    state.streaming = null;
    setStreaming(false);
    scrollToBottom();
  }
}

function showError(message, code) {
  const needsAccount = code === 'trial_expired' || code === 'account_required';
  els.thread.insertAdjacentHTML('beforeend', `<div class="gpt-msg gpt-error">${esc(message)}${
    needsAccount && window.SearchableAccount ? ' <button type="button" class="gpt-signin" id="gpt-signin">Sign in</button>' : ''}</div>`);
  $('#gpt-signin')?.addEventListener('click', () => window.SearchableAccount?.openGate?.(window.__searchableAppConfig || {}));
  scrollToBottom(true);
}

/* ── Composer ─────────────────────────────────────────────────────── */

function autosize() {
  const el = els.input;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

function wire() {
  els.input.addEventListener('input', () => { autosize(); void updateMention(); });
  els.input.addEventListener('click', () => void updateMention());
  els.input.addEventListener('keydown', (e) => {
    if (state.mention.open && state.mention.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = state.mention.items.length;
        state.mention.index = (state.mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(state.mention.index); return; }
    }
    if (e.key === 'Escape') { closeMention(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  });
  els.mention.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('[data-i]');
    if (opt) { e.preventDefault(); pickMention(Number(opt.dataset.i)); }
  });
  els.pills.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unpin]');
    if (b) void unpin(Number(b.dataset.unpin));
  });
  $('#gpt-at').addEventListener('click', () => {
    const el = els.input;
    const pos = el.selectionStart ?? el.value.length;
    const pre = el.value.slice(0, pos);
    const insert = (pre && !/\s$/.test(pre) ? ' ' : '') + '@';
    el.value = pre + insert + el.value.slice(pos);
    el.selectionStart = el.selectionEnd = pos + insert.length;
    el.focus();
    void updateMention();
  });
  els.send.addEventListener('click', () => void send());

  els.modelBtn.addEventListener('click', () => openModelMenu(els.modelMenu.hidden));
  els.modelFilter.addEventListener('input', renderModelMenu);
  els.modelManage.addEventListener('click', () => { state.manageModels = !state.manageModels; renderModelMenu(); });
  els.modelMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openModelMenu(false); els.input.focus(); } });
  els.modelList.addEventListener('click', async (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) { e.stopPropagation(); toggleHidden(eye.dataset.eye); return; }
    const add = e.target.closest('[data-addkey]');
    if (add) {
      const row = els.modelList.querySelector(`[data-keyrow="${CSS.escape(add.dataset.addkey)}"]`);
      if (row) { row.hidden = !row.hidden; row.querySelector('input')?.focus(); }
      return;
    }
    const save = e.target.closest('[data-savekey]');
    if (save) {
      const input = els.modelList.querySelector(`[data-keyinput="${CSS.escape(save.dataset.savekey)}"]`);
      save.disabled = true;
      try { await saveProviderKey(save.dataset.savekey, input?.value || ''); } catch (err) { alert(err.message); save.disabled = false; }
      return;
    }
    const opt = e.target.closest('.gpt-model-opt');
    if (!opt || opt.disabled) return;
    if (state.manageModels && !opt.dataset.auto) return;
    setModel(opt.dataset.auto ? null : { provider: opt.dataset.provider, model: opt.dataset.model });
    openModelMenu(false);
    els.input.focus();
  });
  els.modelList.addEventListener('keydown', (e) => {
    const input = e.target.closest('[data-keyinput]');
    if (input && e.key === 'Enter') {
      e.preventDefault();
      els.modelList.querySelector(`[data-savekey="${CSS.escape(input.dataset.keyinput)}"]`)?.click();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (els.modelMenu.hidden) return;
    if (e.target.closest('#gpt-model-menu') || e.target.closest('#gpt-model-btn')) return;
    openModelMenu(false);
  });
  $('#gpt-new').addEventListener('click', newChat);
  $('#gpt-side-close').addEventListener('click', () => els.app.classList.add('side-hidden'));
  $('#gpt-side-open').addEventListener('click', () => els.app.classList.remove('side-hidden'));
  els.filter.addEventListener('input', renderThreads);
  els.threads.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      await fetch(`/api/gpt/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
      if (id === state.conversationId) newChat();
      void loadThreads();
      return;
    }
    const item = e.target.closest('[data-id]');
    if (item) void openConversation(item.dataset.id);
  });
  els.thread.addEventListener('click', (e) => {
    const c = e.target.closest('.cite');
    if (!c) return;
    const msg = c.closest('.gpt-assistant');
    const card = msg?.querySelector(`.gpt-source[data-ref="${CSS.escape(c.dataset.ref)}"]`);
    if (card) {
      const wrap = card.closest('details');
      if (wrap) wrap.open = true;
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 900);
    }
  });
  els.suggest.innerHTML = SUGGESTIONS.map((s) => `<button type="button" class="chip">${esc(s)}</button>`).join('');
  els.suggest.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) void send(chip.textContent);
  });
}

async function boot() {
  if (matchMedia('(max-width: 820px)').matches) els.app.classList.add('side-hidden');
  wire();
  autosize();
  const params = new URLSearchParams(location.search);
  const scope = params.get('chat');
  if (scope) addPin({ chatJid: scope, chatName: params.get('name') || scope });
  await Promise.all([loadThreads(), loadModels()]);
  if (params.get('c')) await openConversation(params.get('c'), { pushUrl: false });
  const q = params.get('q');
  if (q) void send(q);
  else els.input.focus();
  if (location.hash === '#models') openModelMenu(true);
}

void boot();
