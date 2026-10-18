import { store } from './store.js';
import { loadSmbProfile, loadWabaConfig } from './business.js';
import { HINTS, MODELS } from './constants.js';
import { refreshDash } from './dashboard.js';
import { checkHardwareRecommendation, confirmOllamaDownload, hideAiSetupBanner, ollamaLocalHas, refreshAiSetupBanner, startPullPolling } from './ollama-setup.js';
import { $, esc } from './util.js';

// ── Settings ───────────────────────────────────────────────────────
export function updateModelOptions() {
  const provider = $('#s-provider');
  const sel = $('#s-model');
  if (!provider || !sel) return;
  const p = provider.value;
  sel.innerHTML = '';
  (MODELS[p] || []).forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
  if ($('#s-key-row')) $('#s-key-row').style.display = (p === 'ollama') ? 'none' : '';
  if (p === 'ollama' && $('#s-key-env-note')) $('#s-key-env-note').style.display = 'none';
  const h = $('#s-hint');
  if (h) { h.style.display = ''; h.innerHTML = HINTS[p] || ''; }
}

function applyKeyEnvHints(settings, keyHints) {
  const sKey = $('#s-key');
  const sNote = $('#s-key-env-note');
  if (keyHints && keyHints.search === 'env' && settings && !settings.hasLlmApiKey && $('#s-provider').value !== 'ollama') {
    if (sNote) sNote.style.display = 'block';
    if (sKey) sKey.placeholder = 'Optional — server uses GROQ_API_KEY / LLM_API_KEY. Paste to override.';
  } else {
    if (sNote && $('#s-provider').value !== 'ollama') sNote.style.display = 'none';
    if (sKey && $('#s-provider').value !== 'ollama') {
      sKey.placeholder = 'Paste one key per line, or comma-separated. Multiple keys are rotated automatically.';
    }
  }
  const ssKey = $('#ss-key');
  const ssNote = $('#ss-key-env-note');
  const ssP = settings?.summary_provider || 'ollama_cloud';
  if (keyHints && keyHints.summary === 'env' && settings && !settings.hasSummaryApiKey && ssP !== 'same' && ssP !== 'ollama') {
    if (ssNote) ssNote.style.display = 'block';
    if (ssKey) ssKey.placeholder = 'Optional — server uses OLLAMA_CLOUD_API_KEY / SUMMARY_API_KEY. Paste to override.';
  } else {
    if (ssNote) ssNote.style.display = 'none';
    if (ssKey) ssKey.placeholder = 'Paste one key per line, or comma-separated. Multiple keys are rotated automatically.';
  }
  const smiKey = $('#smi-key');
  const smiNote = $('#smi-key-env-note');
  const smiP = (settings && settings.media_index_provider) || 'ollama';
  if (keyHints && keyHints.mediaIndex === 'env' && settings && !settings.hasMediaIndexApiKey && smiP !== 'same') {
    if (smiNote) smiNote.style.display = 'block';
    if (smiKey) smiKey.placeholder = 'Optional — server uses GEMINI_API_KEY / MEDIA_INDEX_API_KEY. Paste to override.';
  } else {
    if (smiNote) smiNote.style.display = 'none';
    if (smiKey) smiKey.placeholder = 'Paste Gemini / OpenAI key… Multiple keys comma or newline separated.';
  }
}

export async function loadSettings() {
  try {
    const { settings, keyHints } = await fetch('/api/settings').then(r => r.json());
    store.settingsKeyState.hasLlm = !!settings.hasLlmApiKey;
    store.settingsKeyState.hasSummary = !!settings.hasSummaryApiKey;
    store.settingsKeyState.hasMediaIndex = !!settings.hasMediaIndexApiKey;
    store.settingsKeyState.pendingClearLlm = false;
    store.settingsKeyState.pendingClearSummary = false;
    store.settingsKeyState.pendingClearMediaIndex = false;
    const sHint = $('#s-key-stored-hint');
    const ssHint = $('#ss-key-stored-hint');
    const smiHint = $('#smi-key-stored-hint');
    if (sHint) sHint.style.display = store.settingsKeyState.hasLlm ? 'block' : 'none';
    if (ssHint) ssHint.style.display = store.settingsKeyState.hasSummary ? 'block' : 'none';
    if (smiHint) smiHint.style.display = store.settingsKeyState.hasMediaIndex ? 'block' : 'none';
    const sCm = $('#s-key-clear-msg');
    const ssCm = $('#ss-key-clear-msg');
    const smiCm = $('#smi-key-clear-msg');
    if (sCm) sCm.style.display = 'none';
    if (ssCm) ssCm.style.display = 'none';
    if (smiCm) smiCm.style.display = 'none';
    if ($('#s-provider')) {
      if (settings.llm_provider) $('#s-provider').value = settings.llm_provider;
      updateModelOptions();
      if (settings.llm_model && $('#s-model')) $('#s-model').value = settings.llm_model;
      if ($('#s-key')) $('#s-key').value = '';
    }

    if ($('#ss-provider')) {
      if (settings.summary_provider) $('#ss-provider').value = settings.summary_provider;
      else $('#ss-provider').value = 'same';
      updateSummaryModelOptions();
      if (settings.summary_model && $('#ss-model')) $('#ss-model').value = settings.summary_model;
      if ($('#ss-key')) $('#ss-key').value = '';
    }

    if ($('#smi-provider')) {
      if (settings.media_index_provider) $('#smi-provider').value = settings.media_index_provider;
      else $('#smi-provider').value = 'ollama';
      updateSmiModelOptions();
      if (settings.media_index_model && $('#smi-model')) $('#smi-model').value = settings.media_index_model;
      if ($('#smi-key')) $('#smi-key').value = '';
    }

    if ($('#s-provider')) {
      applyKeyEnvHints(settings, keyHints);
      checkHardwareRecommendation();
    }
    void loadSmbProfile();
    void loadWabaConfig();
  } catch {}
  refreshDash();
}

/** Normalise a textarea of keys (one per line or comma-separated) → compact comma string */
function normaliseKeys(raw) {
  return raw.split(/[\n,]+/).map(k => k.trim()).filter(Boolean).join(',');
}

// ── Summary Provider Settings ───────────────────────────────────
function updateSummaryModelOptions() {
  if (!$('#ss-provider')) return;
  const p = $('#ss-provider').value;
  const isSame = p === 'same';
  if ($('#ss-key-row')) $('#ss-key-row').style.display = isSame || p === 'ollama' ? 'none' : '';
  if ((isSame || p === 'ollama') && $('#ss-key-env-note')) $('#ss-key-env-note').style.display = 'none';
  if ($('#ss-model-row')) $('#ss-model-row').style.display = isSame ? 'none' : '';
  if (!isSame) {
    const sel = $('#ss-model');
    if (!sel) return;
    sel.innerHTML = '';
    (MODELS[p] || []).forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
  }
}

function updateSmiModelOptions() {
  if (!$('#smi-provider')) return;
  const p = $('#smi-provider').value;
  const isSame = p === 'same';
  const noKey = isSame || p === 'ollama';
  if ($('#smi-key-row')) $('#smi-key-row').style.display = noKey ? 'none' : '';
  if (noKey && $('#smi-key-env-note')) $('#smi-key-env-note').style.display = 'none';
  if ($('#smi-model-row')) $('#smi-model-row').style.display = isSame ? 'none' : '';
  if (!isSame) {
    const sel = $('#smi-model');
    if (!sel) return;
    sel.innerHTML = '';
    (MODELS[p] || []).forEach(m => {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    });
  }
}

export function initSettings() {
  $('#s-provider')?.addEventListener('change', () => {
    updateModelOptions();
    checkHardwareRecommendation();
  });

  $('#s-key-clear')?.addEventListener('click', () => {
    if ($('#s-key')) $('#s-key').value = '';
    store.settingsKeyState.pendingClearLlm = true;
    const sHint = $('#s-key-stored-hint');
    const sCm = $('#s-key-clear-msg');
    if (sHint) sHint.style.display = 'block';
    if (sCm) sCm.style.display = 'inline';
  });

  $('#ss-key-clear')?.addEventListener('click', () => {
    if ($('#ss-key')) $('#ss-key').value = '';
    store.settingsKeyState.pendingClearSummary = true;
    const ssHint = $('#ss-key-stored-hint');
    const ssCm = $('#ss-key-clear-msg');
    if (ssHint) ssHint.style.display = 'block';
    if (ssCm) ssCm.style.display = 'inline';
  });

  $('#smi-key-clear')?.addEventListener('click', () => {
    if ($('#smi-key')) $('#smi-key').value = '';
    store.settingsKeyState.pendingClearMediaIndex = true;
    const smiHint = $('#smi-key-stored-hint');
    const smiCm = $('#smi-key-clear-msg');
    if (smiHint) smiHint.style.display = 'block';
    if (smiCm) smiCm.style.display = 'inline';
  });

  $('#s-save')?.addEventListener('click', async () => {
    const provider = $('#s-provider').value, model = $('#s-model').value;
    const keyInput = normaliseKeys($('#s-key').value);
    const body = { provider, model };
    if (keyInput) body.apiKey = keyInput;
    else if (store.settingsKeyState.pendingClearLlm) body.apiKey = '';
    else if (!store.settingsKeyState.hasLlm) body.apiKey = '';
    const isOllama = provider === 'ollama';
    let confirmPull = false;
    if (isOllama) {
      const ok = await confirmOllamaDownload(model);
      if (!ok) return;
      confirmPull = !ollamaLocalHas(model);
    }
    if (confirmPull) body.confirmPull = true;
    $('#s-status').innerHTML = `<span class="spinner" style="width:14px;height:14px;"></span> ${isOllama ? `Starting Ollama &amp; loading ${esc(model)}...` : 'Connecting...'}`;
    $('#s-save').disabled = true;
    try {
      const data = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
      if (data.error) {
        $('#s-status').innerHTML = `<span class="health-dot fail"></span> ${esc(data.error)}`;
      } else if (data.memoryWarning) {
        $('#s-model').value = data.model;
        $('#s-status').innerHTML = `<span class="health-dot warn"></span> ${esc(data.memoryWarning)}`;
      } else if (data.healthy) {
        $('#s-status').innerHTML = `<span class="health-dot ok"></span> Connected to ${esc(data.model)}`;
      } else if (data.pulling) {
        $('#s-status').innerHTML = `<span class="spinner" style="width:14px;height:14px;"></span> Downloading ${esc(data.model)} — press Cancel download on the banner to stop`;
        hideAiSetupBanner();
        startPullPolling();
      } else if (isOllama) {
        $('#s-status').innerHTML = '<span class="health-dot fail"></span> Could not start Ollama — is it <a href="https://ollama.com/download" target="_blank">installed</a>?';
      } else {
        $('#s-status').innerHTML = '<span class="health-dot fail"></span> Not reachable — check key';
      }
    } catch (err) { $('#s-status').innerHTML = `<span class="health-dot fail"></span> ${esc(err.message)}`; }
    finally { $('#s-save').disabled = false; void loadSettings(); void refreshAiSetupBanner(); }
  });

  $('#ss-provider')?.addEventListener('change', updateSummaryModelOptions);
  $('#smi-provider')?.addEventListener('change', updateSmiModelOptions);

  $('#smi-save')?.addEventListener('click', async () => {
    const provider = $('#smi-provider').value;
    const model = provider !== 'same' ? $('#smi-model').value : '';
    const body = { provider, model };
    if (provider !== 'same') {
      const keyInput = normaliseKeys($('#smi-key').value);
      if (keyInput) body.apiKey = keyInput;
      else if (store.settingsKeyState.pendingClearMediaIndex) body.apiKey = '';
      else if (!store.settingsKeyState.hasMediaIndex) body.apiKey = '';
    }
    $('#smi-status').innerHTML = `<span class="spinner" style="width:14px;height:14px;"></span> Connecting…`;
    $('#smi-save').disabled = true;
    try {
      const data = await fetch('/api/settings/media-index', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
      if (data.healthy) $('#smi-status').innerHTML = `<span class="health-dot ok"></span> ${esc(data.provider === 'same' ? 'Same as search' : data.model)}`;
      else $('#smi-status').innerHTML = '<span class="health-dot fail"></span> Check API key or pick Same as Search';
    } catch (err) { $('#smi-status').innerHTML = `<span class="health-dot fail"></span> ${esc(err.message)}`; }
    finally { $('#smi-save').disabled = false; void loadSettings(); }
  });

  $('#ss-save')?.addEventListener('click', async () => {
    const provider = $('#ss-provider').value;
    const model = provider !== 'same' ? $('#ss-model').value : '';
    const isOllama = provider === 'ollama';
    let confirmPull = false;
    if (isOllama && model) {
      const ok = await confirmOllamaDownload(model);
      if (!ok) return;
      confirmPull = !ollamaLocalHas(model);
    }
    const body = { provider, model };
    if (confirmPull) body.confirmPull = true;
    if (provider !== 'same' && provider !== 'ollama') {
      const keyInput = normaliseKeys($('#ss-key').value);
      if (keyInput) body.apiKey = keyInput;
      else if (store.settingsKeyState.pendingClearSummary) body.apiKey = '';
      else if (!store.settingsKeyState.hasSummary) body.apiKey = '';
    }
    $('#ss-status').innerHTML = `<span class="spinner" style="width:14px;height:14px;"></span> ${provider === 'same' ? 'Syncing...' : isOllama ? `Starting Ollama &amp; loading ${esc(model)}...` : 'Connecting...'}`;
    $('#ss-save').disabled = true;
    try {
      const data = await fetch('/api/settings/summary-provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
      if (data.error) {
        $('#ss-status').innerHTML = `<span class="health-dot fail"></span> ${esc(data.error)}`;
      } else if (data.healthy) {
        $('#ss-status').innerHTML = `<span class="health-dot ok"></span> Connected: ${esc(data.model)}`;
      } else if (data.pulling) {
        $('#ss-status').innerHTML = `<span class="spinner" style="width:14px;height:14px;"></span> Downloading ${esc(data.model)} — press Cancel download on the banner to stop`;
        hideAiSetupBanner();
        startPullPolling();
      } else if (isOllama) {
        $('#ss-status').innerHTML = '<span class="health-dot fail"></span> Could not start Ollama — is it <a href="https://ollama.com/download" target="_blank">installed</a>?';
      } else {
        $('#ss-status').innerHTML = '<span class="health-dot fail"></span> Not reachable — check key';
      }
    } catch (err) { $('#ss-status').innerHTML = `<span class="health-dot fail"></span> ${esc(err.message)}`; }
    finally { $('#ss-save').disabled = false; void loadSettings(); }
  });

  $('#gen-summaries')?.addEventListener('click', async () => {
    if ($('#sum-status')) $('#sum-status').textContent = 'Generating...';
    try {
      const data = await fetch('/api/summaries/generate', { method: 'POST' }).then(r => r.json());
      if ($('#sum-status')) $('#sum-status').textContent = data.error ? `Error: ${data.error}` : `Generated ${data.generated} summaries`;
      refreshDash();
    } catch (err) { if ($('#sum-status')) $('#sum-status').textContent = err.message; }
  });

  $('#regen-summaries')?.addEventListener('click', async () => {
    if (!confirm('This will clear all existing summaries and regenerate them with the improved prompt. This may take several minutes. Continue?')) return;
    if ($('#sum-status')) $('#sum-status').textContent = 'Clearing old summaries...';
    $('#regen-summaries').disabled = true;
    try {
      const data = await fetch('/api/summaries/regenerate', { method: 'POST' }).then(r => r.json());
      if ($('#sum-status')) $('#sum-status').textContent = `Cleared ${data.cleared} summaries. Regenerating in background...`;
      refreshDash();
    } catch (err) { if ($('#sum-status')) $('#sum-status').textContent = err.message; }
    finally { if ($('#regen-summaries')) $('#regen-summaries').disabled = false; }
  });

  updateModelOptions();
}
