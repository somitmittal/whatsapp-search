import { store } from './store.js';
import { loadSmbProfile } from './business.js';
import { refreshDash } from './dashboard.js';
import { connectGmail } from './gmail.js';
import { checkPullStatus, confirmOllamaDownload, hideAiSetupBanner, refreshAiSetupBanner, startPullPolling } from './ollama-setup.js';
import { openOverlay } from './overlays.js';
import { $, $$, esc } from './util.js';

// ── Onboarding ─────────────────────────────────────────────────────
const OB_STEPS = [
  {
    title: 'Welcome to WhatsApp Search',
    subtitle: 'Your chats as a private knowledge base',
    html: `<p class="ob-desc">Import your WhatsApp export and ask questions in plain English. Pick your account type so AI search matches how you use WhatsApp.</p>
        <div class="setting-row" style="margin:12px 0;align-items:flex-start;">
          <label style="min-width:110px;padding-top:8px;">I use WhatsApp for</label>
          <select id="ob-smb-profile" style="flex:1;">
            <option value="personal">Personal chats</option>
            <option value="clinic">Clinic / healthcare (patients)</option>
            <option value="real_estate">Real estate (buyers &amp; sellers)</option>
            <option value="d2c">Online store / D2C (customers)</option>
            <option value="construction">Construction (site expenses)</option>
          </select>
        </div>
        <div class="setting-row" id="ob-smb-name-row" style="display:none;margin-bottom:12px;">
          <label style="min-width:110px;">Business name</label>
          <input type="text" id="ob-smb-business-name" placeholder="Optional — helps AI answers" style="flex:1;" />
        </div>
        <div class="ob-features">
          <div class="ob-feat"><div class="ob-feat-icon">&#128274;</div><div class="ob-feat-label">100% local</div><div class="ob-feat-desc">Nothing leaves your device</div></div>
          <div class="ob-feat"><div class="ob-feat-icon">&#129302;</div><div class="ob-feat-label">AI-powered</div><div class="ob-feat-desc">Direct answers with sources</div></div>
          <div class="ob-feat"><div class="ob-feat-icon">&#128269;</div><div class="ob-feat-label">Deep search</div><div class="ob-feat-desc">Find orders, visits, follow-ups</div></div>
        </div>`,
  },
  {
    title: 'Export Your Chats',
    subtitle: 'Get your WhatsApp data ready',
    html: `<div class="ob-steps-list">
          <div class="ob-step-item"><div class="ob-step-num">1</div><div class="ob-step-text">Open a WhatsApp chat &rarr; tap <strong>&#8942; &rarr; More &rarr; Export chat</strong></div></div>
          <div class="ob-step-item"><div class="ob-step-num">2</div><div class="ob-step-text">Choose <strong>Without media</strong> (faster) or <strong>Include media</strong></div></div>
          <div class="ob-step-item"><div class="ob-step-num">3</div><div class="ob-step-text">Save the <strong>.zip</strong> file &mdash; email it to yourself for <strong>Load WhatsApp Backup</strong>, or upload it in the next steps</div></div>
        </div>`,
  },
  {
    title: 'Load WhatsApp Backup (optional)',
    subtitle: 'Import exports you emailed to yourself',
    html: `<p class="ob-desc">Email your WhatsApp export (.zip or .txt) to yourself, then connect Google to pull those attachments automatically. Access is read-only.</p>
        <p id="ob-gmail-status" style="font-size:12px;color:var(--text2);margin-bottom:12px;min-height:18px;"></p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">
          <button type="button" class="btn btn-primary" id="ob-gmail-connect" style="padding:10px 18px;border-radius:8px;border:none;cursor:pointer;font-weight:600;">Connect Google</button>
          <button type="button" class="btn btn-secondary" id="ob-gmail-sync" style="padding:10px 18px;border-radius:8px;cursor:pointer;">Sync now</button>
        </div>
        <p class="ob-desc" style="margin-top:14px;font-size:11px;color:var(--text2);">If the server is not configured for Google OAuth, use <strong>Next</strong> and upload files manually. Skip anytime.</p>`,
  },
  {
    title: 'Import & Search',
    subtitle: 'Drop your file and start asking',
    html: `<div class="ob-steps-list">
          <div class="ob-step-item"><div class="ob-step-num">1</div><div class="ob-step-text">Click <strong>+</strong> in the sidebar, use <strong>Load WhatsApp Backup</strong>, or drag &amp; drop your .zip/.txt file</div></div>
          <div class="ob-step-item"><div class="ob-step-num">2</div><div class="ob-step-text">Wait for indexing &mdash; the AI builds a <strong>searchable index</strong> of every day's conversations</div></div>
          <div class="ob-step-item"><div class="ob-step-num">3</div><div class="ob-step-text">Ask anything in the <strong>search bar</strong> &mdash; "Who mentioned the trip?" "What was that restaurant name?"</div></div>
        </div>`,
  },
  {
    title: 'Set Up Local AI',
    subtitle: 'Best Ollama model for this Mac — confirm before download',
    html: `<div id="ob-ollama-root" class="ob-ollama"><span class="spinner" style="width:18px;height:18px;"></span> Detecting RAM and picking the best model...</div>`,
    ollama: true,
  },
];

async function renderObOllamaStep() {
  const root = $('#ob-ollama-root');
  if (!root) return;
  try {
    const data = await fetch('/api/ollama/recommend').then(r => r.json());
    if (data.supported === false) {
      root.innerHTML = `<p class="ob-desc">${esc(data.reason || 'Local Ollama is not available on this host.')}</p>
          <p class="ob-desc" style="margin-top:10px;">Use <strong>Groq</strong> or <strong>Ollama Cloud</strong> in Settings → AI. On Render, set <code>GROQ_API_KEY</code> and <code>OLLAMA_CLOUD_API_KEY</code> in environment variables.</p>
          <button type="button" class="ob-ollama-skip-local" id="ob-ollama-skip-local" style="margin-top:12px;">Continue</button>`;
      return;
    }
    if (data.error || !data.hardware || !data.recommended) {
      root.innerHTML = `<p class="ob-desc">Could not detect hardware. Install <a href="https://ollama.com/download" target="_blank" rel="noopener">Ollama</a> and pick a model in Settings.</p>`;
      return;
    }
    store.obOllamaRec = data;
    const hw = data.hardware;
    const rec = data.recommended;
    const gpuLine = hw.gpu ? ` · GPU: <code>${esc(hw.gpu.name)}</code>` : '';
    const avail = hw.availableRam != null ? hw.availableRam : hw.freeRam;
    const budget = hw.budgetRam;
    const memLine = budget != null && avail != null
      ? `<code>${hw.ram} GB</code> total · <code>~${avail} GB</code> available · <code>~${budget} GB</code> AI budget`
      : `<code>${hw.ram} GB RAM</code>`;
    root.innerHTML = `
        <div class="ob-ollama-specs">${memLine} · <code>${hw.cpuCores} cores</code>${gpuLine}</div>
        <div class="ob-ollama-pick">
          <span class="ob-ollama-name">${esc(rec.model)}</span>
          <span class="ob-ollama-badge">${esc(rec.label)}</span>
          <span class="ob-ollama-size">~${rec.sizeGb} GB</span>
        </div>
        <p class="ob-ollama-reason">${esc(rec.reason)}</p>
        <p class="ob-desc" style="margin-top:0;margin-bottom:12px;">AI Search needs this model downloaded once. Until then you can import and browse chats, but Ask AI will not work.</p>
        <div class="ob-ollama-actions">
          <button type="button" class="ob-ollama-apply" id="ob-ollama-apply">${rec.available ? 'Use this model' : `Download ${esc(rec.model)} (~${rec.sizeGb} GB)`}</button>
          <button type="button" class="ob-ollama-skip-local" id="ob-ollama-skip-local">Choose later</button>
          <button type="button" class="ob-ollama-apply" id="ob-ollama-cancel-pull" style="display:none;background:#fff;color:#6d4c00;border:1px solid #e0a100;">Cancel download</button>
        </div>
        <div class="ob-ollama-status" id="ob-ollama-status"></div>
        <div class="ob-ollama-bar" id="ob-ollama-bar"><div class="ob-ollama-bar-fill" id="ob-ollama-bar-fill"></div></div>
        <p class="ob-desc" style="margin-top:14px;font-size:11px;color:var(--text2);">Nothing downloads until you confirm. You can cancel mid-download. Choose later if you only want to browse chats first.</p>`;
  } catch (err) {
    root.innerHTML = `<p class="ob-desc">Setup check failed. You can configure AI in Settings later.</p>`;
  }
}

async function applyObOllamaRecommendation() {
  if (!store.obOllamaRec?.recommended) return;
  const rec = store.obOllamaRec.recommended;
  const btn = $('#ob-ollama-apply');
  const status = $('#ob-ollama-status');
  const bar = $('#ob-ollama-bar');
  const fill = $('#ob-ollama-bar-fill');
  if (!rec.available) {
    const ok = await confirmOllamaDownload(rec.model);
    if (!ok) return;
  }
  if (btn) { btn.disabled = true; btn.textContent = rec.available ? 'Setting up...' : 'Starting download...'; }
  try {
    const data = await fetch('/api/ollama/apply-recommendation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: rec.model, confirmPull: !rec.available }),
    }).then(r => r.json());
    if (data.error) {
      if (status) status.innerHTML = `<span class="health-dot fail"></span> ${esc(data.error)}`;
      if (btn) btn.disabled = false;
      return;
    }
    if (data.healthy) {
      if (status) status.innerHTML = `<span class="health-dot ok"></span> ${esc(rec.model)} is ready!`;
      if (btn) btn.textContent = 'Done';
      return;
    }
    if (data.pulling) {
      if (status) status.innerHTML = `<span class="spinner" style="width:12px;height:12px;"></span> Downloading — use <strong>Cancel download</strong> below or on the yellow banner`;
      if (bar) bar.classList.add('visible');
      const cancelBtn = $('#ob-ollama-cancel-pull');
      if (cancelBtn) cancelBtn.style.display = '';
      startObOllamaPullWatch(fill, status, rec.model);
      hideAiSetupBanner();
      startPullPolling();
      return;
    }
    if (status) status.innerHTML = 'Install <a href="https://ollama.com/download" target="_blank" rel="noopener">Ollama</a> first, then try again in Settings.';
    if (btn) btn.disabled = false;
  } catch (err) {
    if (status) status.innerHTML = esc(err.message);
    if (btn) btn.disabled = false;
  }
}

function startObOllamaPullWatch(fillEl, statusEl, modelName) {
  if (store.obOllamaPullTimer) clearInterval(store.obOllamaPullTimer);
  store.obOllamaPullTimer = setInterval(async () => {
    try {
      const data = await fetch('/api/pull-status').then(r => r.json());
      if (!data) return;
      if (fillEl && data.percent != null) fillEl.style.width = data.percent + '%';
      const cancelBtn = $('#ob-ollama-cancel-pull');
      if (data.status === 'done') {
        clearInterval(store.obOllamaPullTimer);
        store.obOllamaPullTimer = null;
        if (statusEl) statusEl.innerHTML = `<span class="health-dot ok"></span> ${esc(modelName)} ready!`;
        const btn = $('#ob-ollama-apply');
        if (btn) { btn.textContent = 'Done'; btn.disabled = true; }
        if (cancelBtn) cancelBtn.style.display = 'none';
        void refreshAiSetupBanner();
      } else if (data.status === 'cancelled') {
        clearInterval(store.obOllamaPullTimer);
        store.obOllamaPullTimer = null;
        if (statusEl) statusEl.innerHTML = '<span class="health-dot warn"></span> Download cancelled';
        const btn = $('#ob-ollama-apply');
        if (btn) { btn.textContent = `Download ${esc(modelName)}`; btn.disabled = false; }
        if (cancelBtn) cancelBtn.style.display = 'none';
        void refreshAiSetupBanner();
      } else if (data.status === 'error') {
        clearInterval(store.obOllamaPullTimer);
        store.obOllamaPullTimer = null;
        if (statusEl) statusEl.innerHTML = `<span class="health-dot fail"></span> Download failed — try Settings`;
        if (cancelBtn) cancelBtn.style.display = 'none';
      }
    } catch { /* ignore */ }
  }, 2000);
}

async function updateObGmailForOb() {
  const el = $('#ob-gmail-status');
  const btnSync = $('#ob-gmail-sync');
  if (!el) return;
  try {
    const s = await fetch('/api/gmail/status').then(r => r.json());
    if (!s.configured) {
      el.textContent = 'Load WhatsApp Backup is not configured on this server (missing OAuth credentials).';
      if (btnSync) btnSync.disabled = true;
      return;
    }
    if (btnSync) btnSync.disabled = !s.connected;
    if (s.connected) el.textContent = `Connected${s.email ? ': ' + s.email : ''}. Tap Sync to import mailed WhatsApp exports.`;
    else el.textContent = 'Not connected — tap Connect Google (read-only mailbox access).';
  } catch {
    el.textContent = '';
  }
}

function renderObStep() {
  const s = OB_STEPS[store.obStep];
  $('#ob-counter').textContent = `Step ${store.obStep + 1} of ${OB_STEPS.length}`;
  $$('.ob-step-dot').forEach((d, i) => {
    d.className = 'ob-step-dot' + (i < store.obStep ? ' done' : i === store.obStep ? ' active' : '');
  });
  $('#ob-body').innerHTML = `<h2>${s.title}</h2><div class="ob-subtitle">${s.subtitle}</div>${s.html}`;
  $('#ob-next').textContent = store.obStep === OB_STEPS.length - 1 ? 'Get Started' : 'Next';
  if (store.obStep === 0) {
    const obProf = $('#ob-smb-profile');
    const obNameRow = $('#ob-smb-name-row');
    const obName = $('#ob-smb-business-name');
    if (obProf) {
      obProf.value = store.smbState.profile || 'personal';
      obProf.onchange = () => {
        const on = obProf.value !== 'personal';
        if (obNameRow) obNameRow.style.display = on ? '' : 'none';
      };
      obProf.dispatchEvent(new Event('change'));
    }
    if (obName) obName.value = store.smbState.businessName || '';
  }
  if (store.obStep === 2) void updateObGmailForOb();
  if (s.ollama) void renderObOllamaStep();
}

async function saveObSmbProfileFromOnboarding() {
  const profile = $('#ob-smb-profile')?.value || 'personal';
  const businessName = $('#ob-smb-business-name')?.value || '';
  try {
    await fetch('/api/smb/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, businessName }),
    });
    await loadSmbProfile();
  } catch { /* ignore */ }
}

function closeOnboarding() {
  $('#onboarding').classList.remove('open');
  localStorage.setItem('wa_onboarding_done', '1');
}

export function initOnboarding() {
  (function gmailReturnParams() {
    const sp = new URLSearchParams(window.location.search);
    const gc = sp.get('gmail_connected') === '1';
    const ge = sp.get('gmail_error');
    const fromOb = sp.get('ob') === '1';
    if (gc || ge) history.replaceState({}, '', window.location.pathname);
    if (gc && fromOb && !localStorage.getItem('wa_onboarding_done')) store.obStep = 2;
    if (ge) {
      $('#imp-title').textContent = 'Gmail';
      $('#imp-text').textContent = decodeURIComponent(String(ge).replace(/\+/g, ' '));
      $('#import-result').classList.add('visible');
      openOverlay('import');
    } else if (gc && !ge) {
      $('#imp-title').textContent = 'Gmail connected';
      $('#imp-text').textContent = fromOb ? 'Use Load now on this step, or tap Next to continue.' : 'Use Import → Load WhatsApp Backup when you add new mailed exports.';
      $('#import-result').classList.add('visible');
      if (!fromOb) openOverlay('import');
    }
  })();

  $('#onboarding').addEventListener('click', (e) => {
    const ollamaApply = e.target && e.target.closest && e.target.closest('#ob-ollama-apply');
    const ollamaCancelPull = e.target && e.target.closest && e.target.closest('#ob-ollama-cancel-pull');
    const ollamaSkip = e.target && e.target.closest && e.target.closest('#ob-ollama-skip-local');
    if (ollamaApply) {
      e.preventDefault();
      void applyObOllamaRecommendation();
      return;
    }
    if (ollamaCancelPull) {
      e.preventDefault();
      void fetch('/api/pull-cancel', { method: 'POST' }).then(() => checkPullStatus()).catch(() => {});
      return;
    }
    if (ollamaSkip) {
      e.preventDefault();
      const st = $('#ob-ollama-status');
      if (st) st.textContent = 'You can change the model anytime in Settings.';
      return;
    }
    const connectEl = e.target && e.target.closest && e.target.closest('#ob-gmail-connect');
    const syncEl = e.target && e.target.closest && e.target.closest('#ob-gmail-sync');
    if (connectEl) {
      e.preventDefault();
      connectGmail(true);
      return;
    }
    if (syncEl) {
      e.preventDefault();
      const btn = syncEl;
      btn.disabled = true;
      fetch('/api/gmail/sync', { method: 'POST', credentials: 'same-origin' })
        .then(async (r) => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || 'Sync failed');
          const n = (data.results && data.results.length) || 0;
          alert(`Imported ${n} file(s). Skipped ${data.skipped || 0} already imported.`);
          refreshDash();
        })
        .catch((err) => alert(err.message))
        .finally(() => {
          btn.disabled = false;
          void updateObGmailForOb();
        });
    }
  });

  $('#ob-next').addEventListener('click', () => {
    if (store.obStep === 0) void saveObSmbProfileFromOnboarding();
    if (store.obStep < OB_STEPS.length - 1) { store.obStep++; renderObStep(); }
    else { closeOnboarding(); }
  });

  $('#ob-skip').addEventListener('click', closeOnboarding);

  if (!localStorage.getItem('wa_onboarding_done')) {
    renderObStep();
    $('#onboarding').classList.add('open');
  } else if (store.isDesktopApp) {
    fetch('/api/desktop/info').then(r => r.json()).catch(() => ({}));
  }
}
