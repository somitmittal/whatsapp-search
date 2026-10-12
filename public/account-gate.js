/**
 * First-run account gate + license headers for AI search.
 * Chats stay local — only email/license talk to the control plane.
 */
(function () {
  const INSTALL_KEY = 'searchable_install_id';
  const TOKEN_KEY = 'searchable_license_token';
  const EMAIL_KEY = 'searchable_account_email';
  const SKIP_UNTIL_KEY = 'searchable_gate_skip_until';

  function getInstallId() {
    let id = localStorage.getItem(INSTALL_KEY);
    if (!id) {
      id = 'inst_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(INSTALL_KEY, id);
    }
    return id;
  }

  function controlBase(cfg) {
    const remote = (cfg && cfg.controlPlaneUrl) || '';
    return remote.replace(/\/$/, '');
  }

  function apiUrl(cfg, path) {
    const base = controlBase(cfg);
    return (base || '') + path;
  }

  function utmFromLocation() {
    const q = new URLSearchParams(window.location.search);
    return {
      utmSource: q.get('utm_source') || localStorage.getItem('searchable_utm_source') || '',
      utmCampaign: q.get('utm_campaign') || localStorage.getItem('searchable_utm_campaign') || '',
    };
  }

  function persistUtm() {
    const u = utmFromLocation();
    if (u.utmSource) localStorage.setItem('searchable_utm_source', u.utmSource);
    if (u.utmCampaign) localStorage.setItem('searchable_utm_campaign', u.utmCampaign);
    return u;
  }

  async function fetchLicenseStatus(cfg) {
    const installId = getInstallId();
    const url = apiUrl(cfg, '/api/control/license/status?installId=' + encodeURIComponent(installId)
      + '&os=' + encodeURIComponent(navigator.platform || '')
      + '&appVersion=' + encodeURIComponent(cfg.appVersion || ''));
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (data.licenseToken) localStorage.setItem(TOKEN_KEY, data.licenseToken);
    if (data.email) localStorage.setItem(EMAIL_KEY, data.email);
    return data;
  }

  function authHeaders() {
    const h = { 'X-Install-Id': getInstallId() };
    const tok = localStorage.getItem(TOKEN_KEY);
    if (tok) h['X-License-Token'] = tok;
    return h;
  }

  function shouldShowGate(cfg, status) {
    if (!cfg || !cfg.licenseGate) return false;
    const skipUntil = Number(localStorage.getItem(SKIP_UNTIL_KEY) || 0);
    if (skipUntil > Date.now()) return false;
    if (status?.entitlement?.allowed) return false;
    return true;
  }

  function ensureModal() {
    let el = document.getElementById('account-gate');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'account-gate';
    el.innerHTML = `
      <div class="ag-backdrop">
        <div class="ag-card" role="dialog" aria-labelledby="ag-title">
          <h2 id="ag-title">Activate AI search</h2>
          <p class="ag-lead">Create a free account for a <strong>14-day Pro trial</strong>. Your WhatsApp chats stay on this device — we only store your email for license and billing.</p>
          <label class="ag-label" for="ag-email">Work email</label>
          <input id="ag-email" type="email" autocomplete="email" placeholder="you@company.com" />
          <div id="ag-code-wrap" hidden>
            <label class="ag-label" for="ag-code">Code from email</label>
            <input id="ag-code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" />
          </div>
          <p id="ag-msg" class="ag-msg" hidden></p>
          <button type="button" class="ag-primary" id="ag-submit">Email me a code</button>
          <button type="button" class="ag-secondary" id="ag-later">Continue browsing (AI search later)</button>
        </div>
      </div>`;
    const style = document.createElement('style');
    style.textContent = `
      #account-gate { position: fixed; inset: 0; z-index: 10000; }
      #account-gate .ag-backdrop { position: absolute; inset: 0; background: rgba(17,27,33,.45); display: flex; align-items: center; justify-content: center; padding: 20px; }
      #account-gate .ag-card { background: #fff; border-radius: 14px; padding: 24px; max-width: 400px; width: 100%; box-shadow: 0 12px 40px rgba(0,0,0,.18); }
      #account-gate h2 { font-size: 20px; margin: 0 0 8px; }
      #account-gate .ag-lead { font-size: 13px; color: #667781; margin: 0 0 16px; line-height: 1.45; }
      #account-gate .ag-label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
      #account-gate input { width: 100%; padding: 10px 12px; border: 1px solid #e9edef; border-radius: 8px; font-size: 14px; margin-bottom: 12px; box-sizing: border-box; }
      #account-gate .ag-primary { width: 100%; padding: 12px; border: none; border-radius: 10px; background: #00a884; color: #fff; font-weight: 600; cursor: pointer; }
      #account-gate .ag-secondary { width: 100%; margin-top: 8px; padding: 10px; border: none; background: transparent; color: #667781; font-size: 13px; cursor: pointer; }
      #account-gate .ag-msg { font-size: 13px; margin: 0 0 10px; }
      #account-gate .ag-msg.err { color: #b91c1c; }
      #account-gate .ag-msg.ok { color: #008f72; }
    `;
    document.head.appendChild(style);
    document.body.appendChild(el);
    return el;
  }

  function showMsg(text, ok) {
    const m = document.getElementById('ag-msg');
    if (!m) return;
    m.hidden = !text;
    m.textContent = text || '';
    m.className = 'ag-msg ' + (ok ? 'ok' : 'err');
  }

  async function openGate(cfg) {
    persistUtm();
    const el = ensureModal();
    el.hidden = false;
    const emailInput = document.getElementById('ag-email');
    const saved = localStorage.getItem(EMAIL_KEY);
    if (saved) emailInput.value = saved;

    document.getElementById('ag-later').onclick = () => {
      localStorage.setItem(SKIP_UNTIL_KEY, String(Date.now() + 6 * 3600000));
      el.hidden = true;
      track(cfg, 'account_gate_dismissed');
    };

    document.getElementById('ag-submit').onclick = async () => {
      const email = emailInput.value.trim().toLowerCase();
      const codeWrap = document.getElementById('ag-code-wrap');
      const code = (document.getElementById('ag-code').value || '').trim();
      showMsg('');
      try {
        if (codeWrap.hidden || !code) {
          const utm = persistUtm();
          const res = await fetch(apiUrl(cfg, '/api/control/auth/request-link'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email,
              installId: getInstallId(),
              utmSource: utm.utmSource,
              utmCampaign: utm.utmCampaign,
              os: navigator.platform,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Could not send code');
          codeWrap.hidden = false;
          document.getElementById('ag-submit').textContent = 'Verify code';
          showMsg('Check your email for a 6-digit code.', true);
          if (data.devCode) showMsg('Dev code: ' + data.devCode, true);
          return;
        }
        const res = await fetch(apiUrl(cfg, '/api/control/auth/verify-code'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code, installId: getInstallId() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Invalid code');
        if (data.licenseToken) localStorage.setItem(TOKEN_KEY, data.licenseToken);
        localStorage.setItem(EMAIL_KEY, email);
        el.hidden = true;
        track(cfg, 'account_created', { email });
        if (window.__searchableOnAccountReady) window.__searchableOnAccountReady(data);
      } catch (err) {
        showMsg(err.message || 'Something went wrong', false);
      }
    };
  }

  async function startCheckout(cfg) {
    const res = await fetch(apiUrl(cfg, '/api/control/billing/checkout'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: getInstallId() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout failed');
    if (data.url) window.location.href = data.url;
  }

  function track(cfg, event, properties) {
    const url = apiUrl(cfg, '/api/control/events');
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event,
        installId: getInstallId(),
        platform: navigator.platform,
        properties,
      }),
    }).catch(() => {});
  }

  async function initAccountGate(cfg) {
    persistUtm();
    getInstallId();
    track(cfg, 'app_opened', { desktop: !!(cfg && cfg.desktop) });
    let status = null;
    try {
      status = await fetchLicenseStatus(cfg);
    } catch (_) { /* offline */ }
    if (shouldShowGate(cfg, status)) {
      await openGate(cfg);
    }
    return { status, installId: getInstallId(), authHeaders };
  }

  window.SearchableAccount = {
    getInstallId,
    authHeaders,
    initAccountGate,
    fetchLicenseStatus,
    startCheckout,
    openGate,
    track,
  };
})();
