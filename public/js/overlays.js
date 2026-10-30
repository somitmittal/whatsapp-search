import { store } from './store.js';
import { openNewGroupOverlay, openNewMessageOverlay } from './contacts.js';
import { closeAllMenus, closeMenu } from './menus.js';
import { loadSettings } from './settings.js';
import { loadManagedSkills } from './skills-settings.js';
import { $, $$ } from './util.js';
import { canShowChatUI, hasIndexedArchive, isWaUiReady, wantsLiveSyncUi } from './wa-connection.js';

function syncAppOverlayFront() {
  const open = !!document.querySelector('.overlay-panel.open');
  document.getElementById('app')?.classList.toggle('app-overlays-front', open);
  document.getElementById('gpt-app')?.classList.toggle('app-overlays-front', open);
}

export function openOverlay(name) {
  const el = $(`#overlay-${name}`);
  if (!el) return;
  el.classList.add('open');
  syncAppOverlayFront();
  if (name === 'settings') {
    const saved = localStorage.getItem('wa_settings_tab');
    if (saved) setSettingsTab(saved, false);
    else setSettingsTab(defaultSettingsTab(), false);
  }
}

/** Classic WhatsApp settings live in #overlay-settings only.
 *  GPT uses #gpt-settings (managed in gpt.js) — never fall back to document. */
function settingsOverlayRoot() {
  return document.getElementById('overlay-settings');
}

function defaultSettingsTab() {
  const first = settingsOverlayRoot()?.querySelector('[data-settings-tab]');
  return first?.getAttribute('data-settings-tab') || 'ai';
}

export function setSettingsTab(tabId, persist = true) {
  const root = settingsOverlayRoot();
  if (!root) return;
  const available = [...root.querySelectorAll('[data-settings-tab]')].map((b) => b.getAttribute('data-settings-tab'));
  let id = tabId || defaultSettingsTab();
  // GPT renamed the classic WhatsApp tab → linked-devices
  if (id === 'whatsapp' && available.includes('linked-devices')) id = 'linked-devices';
  // Drop a stale GPT-shell id (e.g. "general") left in localStorage.
  if (available.length && !available.includes(id)) id = available[0];
  root.querySelectorAll('[data-settings-tab]').forEach((btn) => {
    const on = btn.getAttribute('data-settings-tab') === id;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  root.querySelectorAll('[data-settings-panel]').forEach((panel) => {
    panel.classList.toggle('active', panel.getAttribute('data-settings-panel') === id);
  });
  if (id === 'skills') void loadManagedSkills();
  if (persist) {
    try { localStorage.setItem('wa_settings_tab', id); } catch { /* ignore */ }
  }
}

export function closeOverlay(name) {
  $(`#overlay-${name}`)?.classList.remove('open');
  syncAppOverlayFront();
}

export function closeAllOverlays() {
  $$('.overlay-panel').forEach(o => o.classList.remove('open'));
  syncAppOverlayFront();
}

export function switchPanel() {
  if (!$('#panel-empty') && !$('#panel-chat')) return;
  if (!store.activeChat) {
    const aibar = $('#chat-action-items-bar');
    if (aibar) aibar.style.display = 'none';
  }
  // Search panel is now a slide-over — it doesn't replace the chat panel
  if (store.searchActive) {
    $('#panel-search')?.classList.add('visible');
    // Ensure the underlying panel is also visible
    if (store.activeChat) {
      $$('.panel:not(#panel-search)').forEach(p => p.classList.remove('visible'));
      $('#panel-chat')?.classList.add('visible');
    } else {
      $$('.panel:not(#panel-search)').forEach(p => p.classList.remove('visible'));
      $('#panel-empty')?.classList.add('visible');
    }
    return;
  }
  $('#panel-search')?.classList.remove('visible');
  $$('.panel').forEach(p => p.classList.remove('visible'));
  if (store.activeChat && canShowChatUI()) {
    $('#panel-chat')?.classList.add('visible');
  } else {
    $('#panel-empty')?.classList.add('visible');
    if (wantsLiveSyncUi() && !isWaUiReady()) {
      if ($('#welcome-qr')) $('#welcome-qr').style.display = '';
      if ($('#welcome-default')) $('#welcome-default').style.display = 'none';
    } else if (!canShowChatUI()) {
      if ($('#welcome-qr')) $('#welcome-qr').style.display = 'none';
      if ($('#welcome-default')) $('#welcome-default').style.display = hasIndexedArchive() ? '' : 'none';
    } else {
      if ($('#welcome-qr')) $('#welcome-qr').style.display = 'none';
      if ($('#welcome-default')) $('#welcome-default').style.display = '';
    }
  }
}

function showEmptyPanel() {
  store.activeChat = null;
  store.searchActive = false;
  setMobileChatOpen(false);
  switchPanel();
}

function isNarrowViewport() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 768px)').matches;
}

export function setMobileChatOpen(open) {
  const app = $('#app');
  if (!app || !isNarrowViewport()) return;
  app.classList.toggle('chat-open', !!open);
}

export function initOverlays() {
  $('#btn-import')?.addEventListener('click', () => {
    openOverlay('import');
    setTimeout(() => document.getElementById('file-input')?.click(), 0);
  });
  $('#btn-new-message')?.addEventListener('click', () => openNewMessageOverlay());
  $('#close-new-message')?.addEventListener('click', () => closeOverlay('new-message'));
  $('#close-new-group')?.addEventListener('click', () => closeOverlay('new-group'));
  $('#new-group-cancel')?.addEventListener('click', () => closeOverlay('new-group'));
  $('#btn-open-new-group')?.addEventListener('click', () => void openNewGroupOverlay());
  $('#close-forward')?.addEventListener('click', () => { closeOverlay('forward'); store.forwardTarget = null; store.forwardSelected.clear(); });
  $('#forward-cancel')?.addEventListener('click', () => { closeOverlay('forward'); store.forwardTarget = null; store.forwardSelected.clear(); });

  $('#menu-settings')?.addEventListener('click', () => { closeMenu(); openOverlay('settings'); loadSettings(); });
  $('#close-import')?.addEventListener('click', () => closeOverlay('import'));
  $('#close-settings')?.addEventListener('click', () => closeOverlay('settings'));

  $('#btn-restore-backup')?.addEventListener('click', () => {
    openOverlay('import');
    setTimeout(() => document.getElementById('file-input')?.click(), 0);
  });

  $('#btn-link-whatsapp')?.addEventListener('click', async () => {
    try { await fetch('/api/wa/connect', { method: 'POST' }); } catch {}
    openOverlay('settings');
    loadSettings();
  });

  $('#sidebar-link-wa-btn')?.addEventListener('click', async () => {
    try { await fetch('/api/wa/connect', { method: 'POST' }); } catch {}
    showEmptyPanel();
  });

  $('#btn-menu')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('#sidebar-menu')?.classList.toggle('open');
  });

  document.addEventListener('click', () => closeAllMenus());

  settingsOverlayRoot()?.querySelectorAll('[data-settings-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setSettingsTab(btn.getAttribute('data-settings-tab')));
  });

  window.addEventListener('resize', () => {
    if (!isNarrowViewport()) $('#app')?.classList.remove('chat-open');
  });
}
