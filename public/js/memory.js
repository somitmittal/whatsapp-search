/**
 * memory.js — ChatGPT-style saved-memory UI shared by /gpt and the classic app.
 *
 *   1. "Memory updated ✓" pill flashed wherever the page ends up (service worker
 *      event, SSE stream event).
 *   2. Settings widget: auto-save toggle + list of saved facts (add / delete).
 */
import { esc, escAttr } from './util.js';

let chipTimer = null;

/** Flash the "Memory updated" pill (ChatGPT-style) above the composer. */
export function showMemorySavedChip(text = '') {
  let chip = document.getElementById('memory-saved-chip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'memory-saved-chip';
    chip.setAttribute('role', 'status');
    document.body.appendChild(chip);
  }
  chip.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z"/></svg><span><strong>Memory updated</strong>${text ? ` — “${esc(text)}”` : ''}</span>`;
  chip.classList.add('visible');
  clearTimeout(chipTimer);
  chipTimer = setTimeout(() => chip.classList.remove('visible'), 4500);
}

async function fetchMemory() {
  const r = await fetch('/api/gpt/memory', { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Could not load memory');
  return r.json();
}

function memoryItemHtml(m) {
  return `<div class="memory-item" role="listitem">
    <span class="memory-item-text">${esc(m.text)}</span>
    <button type="button" class="memory-item-del" data-memory-del="${escAttr(m.id)}" aria-label="Forget this" title="Forget this">✕</button>
  </div>`;
}

/**
 * Mount the settings widget (idempotent — re-renders in place).
 * Markup in HTML files is just `<div class="memory-widget" id="memory-widget"></div>`.
 */
export function mountMemoryWidget(container) {
  const root = typeof container === 'string' ? document.getElementById(container) : container;
  if (!root) return;
  if (!root.dataset.bound) {
    root.dataset.bound = '1';
    root.addEventListener('click', async (e) => {
      if (e.target.closest('#memory-add-btn')) await addFromInput(root);
      const del = e.target.closest('[data-memory-del]');
      if (del) {
        e.target.disabled = true;
        await fetch(`/api/gpt/memory/${encodeURIComponent(del.getAttribute('data-memory-del'))}`, { method: 'DELETE', credentials: 'same-origin' });
        await load(root);
      }
    });
    root.addEventListener('change', async (e) => {
      if (e.target.id === 'memory-enabled') {
        await fetch('/api/gpt/memory/enabled', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: e.target.checked }),
          credentials: 'same-origin',
        });
        await load(root);
      }
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'memory-add-input') { e.preventDefault(); void addFromInput(root); }
    });
  }
  void load(root);
}

async function addFromInput(root) {
  const input = root.querySelector('#memory-add-input');
  const btn = root.querySelector('#memory-add-btn');
  const text = String(input?.value || '').trim();
  if (!input || !text || btn?.disabled) return;
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/gpt/memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      credentials: 'same-origin',
    });
    if (r.ok) { if (input) input.value = ''; await load(root); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function load(root) {
  try {
    const { enabled, memories = [] } = await fetchMemory();
    root.innerHTML = `
      <div class="memory-toggle-row">
        <label class="memory-switch">
          <input type="checkbox" id="memory-enabled" ${enabled ? 'checked' : ''} />
          <span>Save facts about me automatically</span>
        </label>
      </div>
      <div class="memory-list" role="list" aria-label="Saved memories">
        ${memories.length
          ? memories.map(memoryItemHtml).join('')
          : '<p class="memory-empty">No memories saved yet. Things you share in Ask AI (work, preferences, devices, ongoing tasks) will be remembered here.</p>'}
      </div>
      <div class="memory-add-row" ${enabled ? '' : 'hidden'}>
        <input type="text" id="memory-add-input" placeholder="Add a fact yourself… e.g. “I run a cement trading business”" />
        <button type="button" id="memory-add-btn">Save</button>
      </div>`;
  } catch (err) {
    root.innerHTML = `<p class="memory-empty">${esc(err?.message || 'Memory unavailable')}</p>`;
  }
}
