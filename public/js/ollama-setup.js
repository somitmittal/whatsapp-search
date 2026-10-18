import { store } from './store.js';
import { loadSmbProfile } from './business.js';
import { openOverlay } from './overlays.js';
import { loadSettings, updateModelOptions } from './settings.js';
import { $, esc } from './util.js';

// ── Ollama Hardware Recommendation ────────────────────────────────

export function ollamaLocalHas(name, localModels) {
  const local = localModels || store._hwRecCache?.localModels || store.obOllamaRec?.localModels || [];
  return (local || []).some((m) => m === name || m === `${name}:latest` || m.startsWith(`${name}:`));
}

function ollamaDownloadSizeGb(name) {
  const tiers = store._hwRecCache?.allTiers || store.obOllamaRec?.allTiers || [];
  const t = (tiers || []).find((x) => x.model === name);
  return t ? t.sizeGb : null;
}

async function ensureOllamaRecCache() {
  if (store._hwRecCache?.localModels) return store._hwRecCache;
  try {
    const data = await fetch('/api/ollama/recommend').then((r) => r.json());
    if (data && data.supported !== false && !data.error) store._hwRecCache = data;
  } catch { /* ignore */ }
  return store._hwRecCache;
}

export async function confirmOllamaDownload(model) {
  await ensureOllamaRecCache();
  if (ollamaLocalHas(model)) return true;
  const gb = ollamaDownloadSizeGb(model);
  const size = gb != null ? ` (~${gb} GB)` : '';
  return window.confirm(
    `Download ${model}${size}?\n\nAI Search needs this model on your Mac. Until it finishes, Ask AI will not work.\n\nYou can press Cancel download on the yellow banner to stop anytime.`,
  );
}

const AI_SETUP_DISMISS_KEY = 'ai_setup_dismissed_model';

export function hideAiSetupBanner() {
  $('#ai-setup-banner')?.classList.remove('visible');
}

export async function refreshAiSetupBanner() {
  const banner = $('#ai-setup-banner');
  if (!banner) return;
  try {
    const { settings } = await fetch('/api/settings').then((r) => r.json());
    const provider = settings?.llm_provider || 'ollama';
    if (provider !== 'ollama') { hideAiSetupBanner(); return; }

    const data = await fetch('/api/ollama/recommend').then((r) => r.json());
    if (!data || data.supported === false || data.error || !data.recommended) {
      hideAiSetupBanner();
      return;
    }
    store._hwRecCache = data;
    const rec = data.recommended;
    const hw = data.hardware || {};
    const note = $('#welcome-ai-model-note');
    if (rec.available) {
      hideAiSetupBanner();
      if (note) {
        note.textContent = `AI Search is ready with local model ${rec.model}.`;
      }
      return;
    }

    const dismissed = localStorage.getItem(AI_SETUP_DISMISS_KEY);
    if (dismissed === rec.model) { hideAiSetupBanner(); }
    else {
      const avail = hw.availableRam != null ? hw.availableRam : hw.freeRam;
      const specs = [
        hw.ram != null ? `${hw.ram} GB RAM` : null,
        avail != null ? `~${avail} GB free` : null,
        hw.cpuCores != null ? `${hw.cpuCores} cores` : null,
        hw.gpu?.name ? hw.gpu.name : null,
      ].filter(Boolean).join(' · ');
      $('#asb-title').textContent = 'Download a local AI model to use AI Search';
      $('#asb-detail').innerHTML = `Recommended for this Mac${specs ? ` (${esc(specs)})` : ''}: <code>${esc(rec.model)}</code> (~${rec.sizeGb} GB). ${esc(rec.reason || '')} Nothing downloads until you choose.`;
      const dl = $('#asb-download');
      if (dl) {
        dl.disabled = false;
        dl.textContent = `Download ${rec.model} (~${rec.sizeGb} GB)`;
      }
      banner.classList.add('visible');
    }

    if (note) {
      note.innerHTML = `AI Search needs <code>${esc(rec.model)}</code> (~${rec.sizeGb} GB) once — use the green banner or Settings → AI. Nothing downloads automatically.`;
    }
  } catch {
    hideAiSetupBanner();
  }
}

export async function checkHardwareRecommendation() {
  const panel = $('#hw-recommend');
  if (!panel || !$('#s-provider')) return;
  if ($('#s-provider').value !== 'ollama') { panel.classList.remove('visible'); return; }
  if (store._hwRecCache) { renderHwRec(store._hwRecCache); return; }
  if (store._hwRecFetching) return;
  store._hwRecFetching = true;
  try {
    const data = await fetch('/api/ollama/recommend').then(r => r.json());
    if (data.error) { store._hwRecFetching = false; return; }
    store._hwRecCache = data;
    renderHwRec(data);
  } catch { /* silent */ }
  store._hwRecFetching = false;
}

function renderHwRec(data) {
  const panel = $('#hw-recommend');
  const { hardware: hw, recommended: rec } = data;
  const gpuLine = hw.gpu ? ` &middot; GPU: <code>${esc(hw.gpu.name)}</code>` : '';
  const avail = hw.availableRam != null ? hw.availableRam : hw.freeRam;
  const budget = hw.budgetRam != null ? hw.budgetRam : null;
  const availLine = avail != null
    ? ` &middot; <code>~${avail} GB</code> available${budget != null ? ` (<code>~${budget} GB</code> AI budget)` : ''}`
    : '';
  $('#hw-specs').innerHTML = `<code>${hw.ram} GB</code> total RAM${availLine} &middot; <code>${hw.cpuCores} cores</code>${gpuLine} &middot; ${esc(hw.platform)}/${esc(hw.arch)}`;
  $('#hw-model-name').textContent = rec.model;
  $('#hw-model-badge').textContent = rec.label;
  $('#hw-model-size').textContent = `~${rec.sizeGb} GB download`;
  $('#hw-reason').textContent = rec.reason;
  const needEl = $('#hw-need');
  if (needEl) {
    needEl.textContent = rec.available
      ? 'AI Search uses this local model on your Mac.'
      : 'AI Search needs this model downloaded on your Mac. Until it is installed, you can browse chats but Ask AI will not run.';
  }

  const curModel = $('#s-model').value;
  const isCurrent = curModel === rec.model;
  const actionsEl = $('#hw-actions');
  const statusEl = $('#hw-status');

  if (isCurrent && rec.available) {
    actionsEl.style.display = 'none';
    statusEl.style.display = 'block';
    statusEl.innerHTML = '<span class="health-dot ok"></span> Already using the best model for this Mac.';
  } else {
    actionsEl.style.display = 'flex';
    statusEl.style.display = 'none';
    const applyBtn = $('#hw-apply');
    applyBtn.textContent = rec.available
      ? `Use ${rec.model}`
      : `Download ${rec.model} (~${rec.sizeGb} GB)`;
  }

  panel.classList.add('visible');
}

// ── Model Pull Progress Polling ──────────────────────────────────
export function startPullPolling() {
  if (store.pullPollTimer) return;
  store.pullPollTimer = setInterval(checkPullStatus, 2000);
  checkPullStatus();
}

function stopPullPolling() {
  if (store.pullPollTimer) { clearInterval(store.pullPollTimer); store.pullPollTimer = null; }
}

export async function checkPullStatus() {
  try {
    const data = await fetch('/api/pull-status').then(r => r.json());
    const banner = $('#pull-banner');
    // Keep the existing 2s watcher alive: on startup the first status request can
    // arrive before Ollama begins pulling. Stopping here delayed the bar by up to
    // the 30s fallback interval even though download progress was already logged.
    if (!data || !data.status) {
      banner.classList.remove('visible', 'error', 'done', 'can-cancel');
      return;
    }

    banner.classList.remove('error', 'done', 'can-cancel');
    $('#pb-fill').style.width = (data.percent || 0) + '%';
    $('#pb-pct').textContent = (data.percent || 0) + '%';

    if (data.status === 'downloading') {
      banner.classList.add('visible', 'can-cancel');
      hideAiSetupBanner();
      $('#pb-icon').innerHTML = '&#11015;&#65039;';
      $('#pb-title').textContent = `Downloading ${data.model}...`;
      $('#pb-detail').textContent = data.detail || 'Required for AI Search — press Cancel download to stop';
    } else if (data.status === 'cancelled') {
      banner.classList.add('visible', 'error');
      $('#pb-icon').innerHTML = '&#10060;';
      $('#pb-title').textContent = 'Download cancelled';
      $('#pb-detail').textContent = data.detail || 'You can download again from the green banner or Settings';
      $('#pb-pct').textContent = '';
      setTimeout(() => {
        banner.classList.remove('visible');
        stopPullPolling();
        void refreshAiSetupBanner();
      }, 5000);
    } else if (data.status === 'done') {
      banner.classList.add('visible', 'done');
      $('#pb-icon').innerHTML = '&#9989;';
      $('#pb-title').textContent = `${data.model} ready!`;
      $('#pb-detail').textContent = 'Model downloaded successfully';
      $('#pb-pct').textContent = '';
      $('#s-status').innerHTML = `<span class="health-dot ok"></span> Connected to ${esc(data.model)}`;
      const hwSt = $('#hw-status');
      if (hwSt && hwSt.style.display !== 'none') {
        hwSt.innerHTML = `<span class="health-dot ok"></span> ${esc(data.model)} is ready!`;
      }
      localStorage.removeItem(AI_SETUP_DISMISS_KEY);
      setTimeout(() => {
        banner.classList.remove('visible');
        stopPullPolling();
        void refreshAiSetupBanner();
      }, 5000);
    } else if (data.status === 'error') {
      banner.classList.add('visible', 'error');
      $('#pb-icon').innerHTML = '&#10060;';
      $('#pb-title').textContent = `Download failed`;
      $('#pb-detail').textContent = data.detail || 'Try again from Settings';
      $('#pb-pct').textContent = '';
      setTimeout(() => {
        banner.classList.remove('visible');
        stopPullPolling();
        void refreshAiSetupBanner();
      }, 8000);
    } else {
      banner.classList.remove('visible');
    }
  } catch { /* server not reachable */ }
}

export function initOllamaSetup() {
  $('#hw-apply').addEventListener('click', async () => {
    if (!store._hwRecCache) return;
    const rec = store._hwRecCache.recommended;
    const applyBtn = $('#hw-apply');
    const statusEl = $('#hw-status');
    const actionsEl = $('#hw-actions');
    const downloadLabel = rec.available ? `Use ${rec.model}` : `Download ${rec.model} (~${rec.sizeGb} GB)`;

    if (!rec.available) {
      const ok = await confirmOllamaDownload(rec.model);
      if (!ok) return;
    }

    applyBtn.disabled = true;
    applyBtn.textContent = rec.available ? 'Setting up...' : 'Starting download...';

    try {
      const data = await fetch('/api/ollama/apply-recommendation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: rec.model, confirmPull: !rec.available }),
      }).then(r => r.json());

      actionsEl.style.display = 'none';
      statusEl.style.display = 'block';

      if (data.warning) {
        statusEl.innerHTML = `<span class="health-dot warn"></span> ${esc(data.warning)}`;
        $('#s-model').value = data.model;
      } else if (data.healthy) {
        statusEl.innerHTML = `<span class="health-dot ok"></span> ${esc(rec.model)} is ready!`;
        $('#s-status').innerHTML = `<span class="health-dot ok"></span> Connected to ${esc(rec.model)}`;
      } else if (data.pulling) {
        statusEl.innerHTML = `<span class="spinner" style="width:12px;height:12px;"></span> Downloading ${esc(data.model || rec.model)} — press <strong>Cancel download</strong> on the banner to stop`;
        hideAiSetupBanner();
        startPullPolling();
      } else {
        statusEl.innerHTML = '<span class="health-dot fail"></span> Could not start Ollama — is it <a href="https://ollama.com/download" target="_blank">installed</a>?';
      }

      $('#s-provider').value = 'ollama';
      updateModelOptions();
      $('#s-model').value = data.model || rec.model;
      store._hwRecCache = null;
      void loadSettings();
      void refreshAiSetupBanner();
    } catch (err) {
      statusEl.style.display = 'block';
      statusEl.innerHTML = `<span class="health-dot fail"></span> ${esc(err.message)}`;
    }
    applyBtn.disabled = false;
    applyBtn.textContent = downloadLabel;
  });

  $('#hw-dismiss').addEventListener('click', () => {
    $('#hw-recommend').classList.remove('visible');
  });

  $('#asb-dismiss')?.addEventListener('click', () => {
    const model = store._hwRecCache?.recommended?.model;
    if (model) localStorage.setItem(AI_SETUP_DISMISS_KEY, model);
    hideAiSetupBanner();
  });

  $('#asb-settings')?.addEventListener('click', () => {
    openOverlay('settings');
    void loadSettings();
  });

  $('#asb-download')?.addEventListener('click', async () => {
    const rec = store._hwRecCache?.recommended;
    if (!rec) {
      await refreshAiSetupBanner();
      return;
    }
    if (!rec.available) {
      const ok = await confirmOllamaDownload(rec.model);
      if (!ok) return;
    }
    const btn = $('#asb-download');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting download...'; }
    try {
      const data = await fetch('/api/ollama/apply-recommendation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: rec.model, confirmPull: !rec.available }),
      }).then((r) => r.json());
      if (data.error) {
        if (btn) { btn.disabled = false; btn.textContent = `Download ${rec.model}`; }
        alert(data.error);
        return;
      }
      localStorage.removeItem(AI_SETUP_DISMISS_KEY);
      hideAiSetupBanner();
      if (data.pulling) startPullPolling();
      else void refreshAiSetupBanner();
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = `Download ${rec.model}`; }
      alert(err.message || 'Download failed');
    }
  });

  $('#pb-cancel')?.addEventListener('click', async () => {
    $('#pb-cancel').disabled = true;
    try {
      await fetch('/api/pull-cancel', { method: 'POST' });
      await checkPullStatus();
    } catch { /* ignore */ }
    $('#pb-cancel').disabled = false;
  });

  startPullPolling();

  // Re-arm after a completed/error pull so later provider changes are also observed.
  setInterval(() => { if (!store.pullPollTimer) startPullPolling(); }, 30000);
  void loadSmbProfile();
  void refreshAiSetupBanner();
}
