/**
 * public/js/emoji-picker.js — WhatsApp Emoji Picker & Search UI
 *
 * Provides:
 * 1. WhatsApp-style Composer Emoji Panel with search bar, category tabs, and recents.
 * 2. Message Reaction Emoji Picker with live search filtering.
 * 3. Inline emoji autocomplete (`:query`) in the message composer.
 */

import { EMOJI_CATEGORIES, EMOJI_CATALOG, searchEmojis, getRecentEmojis, recordRecentEmoji } from './emoji-data.js';
import { esc, escAttr } from './util.js';

/**
 * Inserts an emoji at the current cursor / selection point in an input element.
 */
export function insertEmojiAtCursor(inputEl, emoji) {
  if (!inputEl) return;
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? inputEl.value.length;
  const text = inputEl.value;
  const before = text.substring(0, start);
  const after = text.substring(end);

  inputEl.value = `${before}${emoji}${after}`;
  const newPos = start + emoji.length;
  inputEl.selectionStart = newPos;
  inputEl.selectionEnd = newPos;

  // Trigger input event for any reactive state / button enable
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  inputEl.focus();
}

/**
 * Template for one emoji button.
 */
function renderEmojiBtn(item, extraClass = '') {
  const emoji = typeof item === 'string' ? item : item.emoji;
  const name = typeof item === 'string' ? item : item.name;
  return `<button type="button" class="wa-emoji-btn ${extraClass}" data-emoji="${escAttr(emoji)}" title="${escAttr(name)}" aria-label="${escAttr(name)}">${esc(emoji)}</button>`;
}

/**
 * WhatsApp Emoji Panel Component (for Chat Composer)
 */
export class ComposerEmojiPanel {
  constructor({ containerEl, inputEl, toggleBtnEl }) {
    this.container = containerEl;
    this.input = inputEl;
    this.toggleBtn = toggleBtnEl;
    this.activeCategory = 'all';
    this.searchQuery = '';
    this.isOpen = false;

    this._bindEvents();
  }

  _bindEvents() {
    this.toggleBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!this.isOpen) return;
      if (this.container?.contains(e.target) || this.toggleBtn?.contains(e.target)) return;
      this.close();
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
        this.input?.focus();
      }
    });
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    if (!this.container) return;
    this.isOpen = true;
    this.container.hidden = false;
    this.toggleBtn?.classList.add('is-active');
    this.render();

    // Auto-focus search input
    setTimeout(() => {
      const searchInput = this.container.querySelector('.wa-emoji-search-input');
      searchInput?.focus();
    }, 50);
  }

  close() {
    if (!this.container) return;
    this.isOpen = false;
    this.container.hidden = true;
    this.toggleBtn?.classList.remove('is-active');
    this.searchQuery = '';
  }

  render() {
    if (!this.container) return;

    const q = this.searchQuery.trim();
    const isSearching = q.length > 0;

    let bodyHtml = '';

    if (isSearching) {
      const results = searchEmojis(q, { category: this.activeCategory, limit: 120 });
      if (results.length === 0) {
        bodyHtml = `
          <div class="wa-emoji-empty">
            <span class="wa-emoji-empty-icon">🔍</span>
            <span class="wa-emoji-empty-text">No emojis found for “${esc(q)}”</span>
          </div>`;
      } else {
        bodyHtml = `
          <div class="wa-emoji-section">
            <div class="wa-emoji-section-title">Search Results (${results.length})</div>
            <div class="wa-emoji-grid">
              ${results.map((r) => renderEmojiBtn(r)).join('')}
            </div>
          </div>`;
      }
    } else {
      // 1. Recents section (if any)
      const recents = getRecentEmojis();
      let recentsHtml = '';
      if (recents.length > 0 && (this.activeCategory === 'all' || this.activeCategory === 'recent')) {
        recentsHtml = `
          <div class="wa-emoji-section" data-cat-section="recent">
            <div class="wa-emoji-section-title">Frequently Used</div>
            <div class="wa-emoji-grid">
              ${recents.map((e) => renderEmojiBtn(e)).join('')}
            </div>
          </div>`;
      }

      // 2. Categorized sections
      const categoriesToRender = this.activeCategory === 'all'
        ? EMOJI_CATEGORIES
        : EMOJI_CATEGORIES.filter((c) => c.id === this.activeCategory);

      const sectionsHtml = categoriesToRender.map((cat) => {
        const items = EMOJI_CATALOG.filter((item) => item.category === cat.id);
        return `
          <div class="wa-emoji-section" data-cat-section="${cat.id}">
            <div class="wa-emoji-section-title">${esc(cat.label)}</div>
            <div class="wa-emoji-grid">
              ${items.map((item) => renderEmojiBtn(item)).join('')}
            </div>
          </div>`;
      }).join('');

      bodyHtml = `${recentsHtml}${sectionsHtml}`;
    }

    this.container.innerHTML = `
      <div class="wa-emoji-panel-inner">
        <div class="wa-emoji-search-bar">
          <svg class="wa-emoji-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M10 2a8 8 0 0 1 6.32 12.906l4.387 4.387a1 1 0 0 1-1.414 1.414l-4.387-4.387A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/>
          </svg>
          <input type="text" class="wa-emoji-search-input" placeholder="Search emoji" value="${escAttr(this.searchQuery)}" autocomplete="off" />
          <button type="button" class="wa-emoji-search-clear" title="Clear search" aria-label="Clear search" ${isSearching ? '' : 'hidden'}>✕</button>
        </div>

        <div class="wa-emoji-category-tabs">
          <button type="button" class="wa-emoji-cat-btn ${this.activeCategory === 'all' ? 'is-active' : ''}" data-cat="all" title="All">All</button>
          ${EMOJI_CATEGORIES.map((cat) => `
            <button type="button" class="wa-emoji-cat-btn ${this.activeCategory === cat.id ? 'is-active' : ''}" data-cat="${cat.id}" title="${escAttr(cat.label)}">
              ${esc(cat.icon)}
            </button>
          `).join('')}
        </div>

        <div class="wa-emoji-scroll-body">
          ${bodyHtml}
        </div>
      </div>
    `;

    this._bindPanelEvents();
  }

  _bindPanelEvents() {
    const searchInput = this.container.querySelector('.wa-emoji-search-input');
    const clearBtn = this.container.querySelector('.wa-emoji-search-clear');

    searchInput?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      if (clearBtn) clearBtn.hidden = !this.searchQuery;
      this._updateGridOnly();
    });

    clearBtn?.addEventListener('click', () => {
      this.searchQuery = '';
      if (searchInput) { searchInput.value = ''; searchInput.focus(); }
      if (clearBtn) clearBtn.hidden = true;
      this._updateGridOnly();
    });

    // Category tab clicks
    this.container.querySelectorAll('.wa-emoji-cat-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeCategory = btn.dataset.cat || 'all';
        this.container.querySelectorAll('.wa-emoji-cat-btn').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        this._updateGridOnly();
      });
    });

    // Emoji selection clicks
    this.container.querySelector('.wa-emoji-scroll-body')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      const emoji = btn.dataset.emoji;
      if (emoji) {
        insertEmojiAtCursor(this.input, emoji);
        recordRecentEmoji(emoji);
      }
    });
  }

  _updateGridOnly() {
    const scrollBody = this.container.querySelector('.wa-emoji-scroll-body');
    if (!scrollBody) {
      this.render();
      return;
    }

    const q = this.searchQuery.trim();
    const isSearching = q.length > 0;

    let bodyHtml = '';
    if (isSearching) {
      const results = searchEmojis(q, { category: this.activeCategory, limit: 120 });
      if (results.length === 0) {
        bodyHtml = `
          <div class="wa-emoji-empty">
            <span class="wa-emoji-empty-icon">🔍</span>
            <span class="wa-emoji-empty-text">No emojis found for “${esc(q)}”</span>
          </div>`;
      } else {
        bodyHtml = `
          <div class="wa-emoji-section">
            <div class="wa-emoji-section-title">Search Results (${results.length})</div>
            <div class="wa-emoji-grid">
              ${results.map((r) => renderEmojiBtn(r)).join('')}
            </div>
          </div>`;
      }
    } else {
      const recents = getRecentEmojis();
      let recentsHtml = '';
      if (recents.length > 0 && (this.activeCategory === 'all' || this.activeCategory === 'recent')) {
        recentsHtml = `
          <div class="wa-emoji-section" data-cat-section="recent">
            <div class="wa-emoji-section-title">Frequently Used</div>
            <div class="wa-emoji-grid">
              ${recents.map((e) => renderEmojiBtn(e)).join('')}
            </div>
          </div>`;
      }

      const categoriesToRender = this.activeCategory === 'all'
        ? EMOJI_CATEGORIES
        : EMOJI_CATEGORIES.filter((c) => c.id === this.activeCategory);

      const sectionsHtml = categoriesToRender.map((cat) => {
        const items = EMOJI_CATALOG.filter((item) => item.category === cat.id);
        return `
          <div class="wa-emoji-section" data-cat-section="${cat.id}">
            <div class="wa-emoji-section-title">${esc(cat.label)}</div>
            <div class="wa-emoji-grid">
              ${items.map((item) => renderEmojiBtn(item)).join('')}
            </div>
          </div>`;
      }).join('');

      bodyHtml = `${recentsHtml}${sectionsHtml}`;
    }

    scrollBody.innerHTML = bodyHtml;
  }
}

/**
 * Reaction Emoji Picker Search Enabler
 * Dynamically binds search filtering into the message reaction bubble popup (.wa-reaction-picker).
 */
export function setupReactionSearch(pickerEl, { onSelect = null } = {}) {
  if (!pickerEl || pickerEl.dataset.searchReady) return;
  pickerEl.dataset.searchReady = '1';

  const searchInput = pickerEl.querySelector('.wa-reaction-search-input');
  const grid = pickerEl.querySelector('.wa-picker-grid');
  if (!searchInput || !grid) return;

  searchInput.addEventListener('input', (e) => {
    const q = String(e.target.value || '').trim();
    if (!q) {
      // Restore standard catalog in reaction grid
      grid.innerHTML = EMOJI_CATALOG.slice(0, 96).map((item) =>
        `<button type="button" class="wa-tb" data-wa-react="${escAttr(item.emoji)}" title="React ${escAttr(item.emoji)}" aria-label="React ${escAttr(item.emoji)}">${esc(item.emoji)}</button>`
      ).join('');
      return;
    }

    const matches = searchEmojis(q, { limit: 64 });
    if (matches.length === 0) {
      grid.innerHTML = `<div class="wa-reaction-empty">No emojis matching “${esc(q)}”</div>`;
    } else {
      grid.innerHTML = matches.map((m) =>
        `<button type="button" class="wa-tb" data-wa-react="${escAttr(m.emoji)}" title="React ${escAttr(m.emoji)}" aria-label="React ${escAttr(m.emoji)}">${esc(m.emoji)}</button>`
      ).join('');
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      pickerEl.hidden = true;
    }
  });
}

/**
 * Inline Colon Emoji Autocomplete (:heart -> ❤️)
 */
export function setupInlineEmojiAutocomplete(inputEl) {
  if (!inputEl || inputEl.dataset.emojiAutocomplete) return;
  inputEl.dataset.emojiAutocomplete = '1';

  let popup = document.getElementById('wa-inline-emoji-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'wa-inline-emoji-popup';
    popup.className = 'wa-inline-emoji-popup';
    popup.hidden = true;
    document.body.appendChild(popup);
  }

  const hidePopup = () => { popup.hidden = true; };

  inputEl.addEventListener('input', () => {
    const text = inputEl.value;
    const cursorPos = inputEl.selectionStart;
    if (cursorPos == null) { hidePopup(); return; }

    const textBefore = text.slice(0, cursorPos);
    const match = textBefore.match(/:([a-zA-Z0-9_]{2,15})$/);
    if (!match) {
      hidePopup();
      return;
    }

    const query = match[1];
    const results = searchEmojis(query, { limit: 6 });
    if (results.length === 0) {
      hidePopup();
      return;
    }

    // Position popup above input
    const rect = inputEl.getBoundingClientRect();
    popup.style.left = `${Math.max(10, rect.left)}px`;
    popup.style.bottom = `${window.innerHeight - rect.top + 6}px`;
    popup.innerHTML = results.map((item, idx) => `
      <button type="button" class="wa-inline-emoji-item ${idx === 0 ? 'is-selected' : ''}" data-emoji="${escAttr(item.emoji)}" data-match-len="${match[0].length}">
        <span class="wa-inline-emoji-glyph">${esc(item.emoji)}</span>
        <span class="wa-inline-emoji-name">${esc(item.name)}</span>
      </button>
    `).join('');
    popup.hidden = false;
  });

  popup.addEventListener('click', (e) => {
    const item = e.target.closest('[data-emoji]');
    if (!item) return;
    const emoji = item.dataset.emoji;
    const matchLen = Number(item.dataset.matchLen) || 0;
    const cursorPos = inputEl.selectionStart;
    const text = inputEl.value;

    const before = text.slice(0, cursorPos - matchLen);
    const after = text.slice(cursorPos);
    inputEl.value = `${before}${emoji} ${after}`;
    const newPos = before.length + emoji.length + 1;
    inputEl.selectionStart = newPos;
    inputEl.selectionEnd = newPos;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.focus();
    recordRecentEmoji(emoji);
    hidePopup();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (popup.hidden) return;
    const items = Array.from(popup.querySelectorAll('.wa-inline-emoji-item'));
    if (!items.length) return;
    const selectedIdx = items.findIndex((el) => el.classList.contains('is-selected'));

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = (selectedIdx + 1) % items.length;
      items.forEach((el, i) => el.classList.toggle('is-selected', i === nextIdx));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = (selectedIdx - 1 + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('is-selected', i === prevIdx));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const active = items[selectedIdx] || items[0];
      if (active) {
        e.preventDefault();
        active.click();
      }
    } else if (e.key === 'Escape') {
      hidePopup();
    }
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(hidePopup, 180);
  });
}
