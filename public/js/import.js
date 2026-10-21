import { store } from './store.js';
import { openChat } from './chat-view.js';
import { refreshDash } from './dashboard.js';
import { closeAllOverlays } from './overlays.js';
import { renderChatsFromState } from './sidebar.js';
import { $ } from './util.js';
import { ensureImportFirstWelcome } from './wa-bootstrap.js';
import { updateSidebarForWaState } from './wa-connection.js';

// ── Import ─────────────────────────────────────────────────────────
function dropZone() { return $('#drop-zone'); }
function fileInput() { return $('#file-input'); }

function setImportPhase(phase, pct) {
  const prog = $('#import-progress');
  const fill = $('#ip-fill');
  const phaseEl = $('#ip-phase');
  const titleEl = $('#ip-title');
  const subEl = $('#ip-subtitle');
  const iconEl = $('#ip-icon');
  if (!prog || !fill) return;

  prog.classList.add('visible');
  fill.classList.remove('indeterminate');
  if (phase === 'upload') {
    if (iconEl) iconEl.innerHTML = '&#128228;';
    if (titleEl) titleEl.textContent = 'Uploading...';
    if (subEl) subEl.textContent = 'Sending file to local server';
    fill.classList.add('indeterminate');
    if (phaseEl) phaseEl.textContent = 'Uploading file...';
  } else if (phase === 'parse') {
    if (iconEl) iconEl.innerHTML = '&#128196;';
    if (titleEl) titleEl.textContent = 'Parsing messages...';
    if (subEl) subEl.textContent = 'Reading chat export';
    fill.style.width = '40%';
    if (phaseEl) phaseEl.textContent = 'Parsing messages...';
  } else if (phase === 'index') {
    if (iconEl) iconEl.innerHTML = '&#128269;';
    if (titleEl) titleEl.textContent = 'Indexing for search...';
    if (subEl) subEl.textContent = 'Building search index';
    fill.style.width = '75%';
    if (phaseEl) phaseEl.textContent = 'Indexing for search...';
  } else if (phase === 'done') {
    if (iconEl) iconEl.innerHTML = '&#9989;';
    if (titleEl) titleEl.textContent = 'Import complete!';
    if (subEl) subEl.textContent = 'Your chat is ready to search';
    fill.style.width = '100%';
    if (phaseEl) phaseEl.textContent = pct || 'Done!';
  } else if (phase === 'error') {
    if (iconEl) iconEl.innerHTML = '&#10060;';
    if (titleEl) titleEl.textContent = 'Import failed';
    if (subEl) subEl.textContent = pct || 'Something went wrong';
    fill.style.width = '100%';
    fill.style.background = 'var(--danger, #c23b4a)';
    if (phaseEl) phaseEl.textContent = '';
  }
}

function hideImportProgress() {
  const prog = $('#import-progress');
  const fill = $('#ip-fill');
  if (fill) {
    fill.style.background = '';
    fill.style.width = '0%';
    fill.classList.remove('indeterminate');
  }
  prog?.classList.remove('visible');
}

/**
 * After import: close the overlay, refresh the sidebar, open the imported chat.
 * @param {string|null} chatJid  the imported chat's JID (from server response)
 * @param {string} [resultTitle]  short text to show as a toast
 */
async function finishImportUi(chatJid, resultTitle) {
  clearTimeout(store._refreshDashTimer);
  // Set BEFORE refreshDash so background WA events don't clear the chat during the await.
  store._justImportedJid = chatJid || store._justImportedJid;
  closeAllOverlays();
  if (resultTitle) showImportToast(resultTitle);
  const touchTs = Math.floor(Date.now() / 1000);
  await refreshDash();
  let targetJid = chatJid;
  if (!targetJid && store.chatData.length) {
    let best = 0;
    for (const c of store.chatData) {
      const t = Number(c.lastImportedAt) || 0;
      if (t >= best) { best = t; targetJid = c.chatJid; }
    }
  }
  if (targetJid) {
    store._justImportedJid = targetJid;
    const row = store.chatData.find((c) => c.chatJid === targetJid);
    if (row) row.lastImportedAt = Math.max(Number(row.lastImportedAt) || 0, touchTs);
  }
  if (document.getElementById('gpt-app')) {
    window.dispatchEvent(new CustomEvent('wgpt:chats-imported', { detail: { chatJid: targetJid } }));
    return;
  }
  ensureImportFirstWelcome();
  updateSidebarForWaState();
  renderChatsFromState();
  if (targetJid) void openChat(targetJid);
}

/** Briefly show a small toast anchored to the bottom of the sidebar. */
function showImportToast(msg) {
  let toast = document.getElementById('import-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'import-toast';
    toast.style.cssText = [
      'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
      'background:#128C7E', 'color:#fff', 'padding:10px 20px',
      'border-radius:20px', 'font-size:13px', 'font-weight:500',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)', 'z-index:9999',
      'transition:opacity 0.4s', 'white-space:nowrap', 'max-width:90vw',
      'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 3200);
}

async function uploadBatch(fileList) {
  $('#import-result')?.classList.remove('visible');
  hideImportProgress();
  setImportPhase('upload');

  const form = new FormData();
  for (const f of fileList) form.append('file', f);

  try {
    setImportPhase('parse');
    const res = await fetch('/api/import', { method: 'POST', credentials: 'same-origin', body: form });
    const raw = await res.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(res.ok
        ? 'Import returned a non-JSON response'
        : `Import failed (HTTP ${res.status}). The file may be too large for the server.`);
    }
    if (!res.ok && !data.error) {
      throw new Error(`Import failed (HTTP ${res.status})`);
    }

    setImportPhase('index');
    await new Promise(r => setTimeout(r, 600));

    if (data.error) {
      setImportPhase('error', data.error);
      showImportToast('Import failed: ' + data.error.slice(0, 60));
    } else if (data.results) {
      const ok = data.results.filter(r => !r.error), fail = data.results.filter(r => r.error);
      const totalNew = ok.reduce((s, r) => s + (r.inserted || 0), 0);
      const totalParsed = ok.reduce((s, r) => s + (r.parsedCount ?? r.total ?? 0), 0);
      const toastMsg = totalNew > 0
        ? `Imported ${totalNew.toLocaleString()} new messages from ${ok.length} chat${ok.length > 1 ? 's' : ''}`
        : `${totalParsed.toLocaleString()} messages already in library`;
      setImportPhase('done', totalNew > 0 ? `${totalNew.toLocaleString()} new messages` : `${totalParsed.toLocaleString()} messages refreshed`);
      if (fail.length) showImportToast(`${ok.length} imported, ${fail.length} failed`);
      await finishImportUi(data.pinnedChatJid || ok[0]?.chatJid, toastMsg);
    } else {
      const ins = data.inserted ?? 0;
      const tot = data.total ?? data.parsedCount ?? 0;
      let toastMsg;
      if (data.parseFailed) {
        toastMsg = 'No messages matched WhatsApp format';
        setImportPhase('error', 'Parse failed');
        showImportToast(toastMsg);
        return;
      } else if (ins === 0 && tot > 0) {
        toastMsg = `${tot.toLocaleString()} messages already in library — moved to top`;
        setImportPhase('done', 'Chat refreshed');
      } else if (ins === 0 && tot === 0) {
        toastMsg = 'Nothing to import — archive was empty';
        setImportPhase('done', 'Nothing new');
        showImportToast(toastMsg);
        return;
      } else {
        toastMsg = `Imported ${ins.toLocaleString()} messages from ${data.chatName}`;
        setImportPhase('done', `${ins.toLocaleString()} messages indexed`);
      }
      await finishImportUi(data.pinnedChatJid || data.chatJid, toastMsg);
    }

    setTimeout(hideImportProgress, 4000);
  } catch (err) {
    setImportPhase('error', err.message);
    if ($('#imp-title')) $('#imp-title').textContent = 'Import Failed';
    if ($('#imp-text')) $('#imp-text').textContent = err.message;
    $('#import-result')?.classList.add('visible');
    setTimeout(hideImportProgress, 4000);
  }
}

export function initImport() {
  const dz = dropZone();
  const fi = fileInput();
  if (!dz || !fi) return;
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); if (e.dataTransfer.files.length) uploadBatch(e.dataTransfer.files); });
  fi.addEventListener('change', () => { if (fi.files.length) uploadBatch(fi.files); fi.value = ''; });
}
