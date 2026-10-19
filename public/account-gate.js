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

  let lastStatus = null;
  let expiryTimer = null;

  function getEmail() {
    return localStorage.getItem(EMAIL_KEY);
  }

  function hasSession() {
    return Boolean(localStorage.getItem(TOKEN_KEY) || localStorage.getItem(EMAIL_KEY));
  }

  function getLastStatus() {
    return lastStatus;
  }

  /** Drop the license session. Install id stays so the device can re-link. */
  function clearSession({ keepEmail = false } = {}) {
    localStorage.removeItem(TOKEN_KEY);
    if (!keepEmail) localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem(SKIP_UNTIL_KEY);
  }

  function logout(cfg) {
    clearSession({ keepEmail: false });
    lastStatus = null;
    clearTimeout(expiryTimer);
    expiryTimer = null;
    track(cfg || window.__searchableAppConfig || {}, 'account_logout', {});
    if (typeof window.__searchableOnAccountChanged === 'function') {
      window.__searchableOnAccountChanged({ signedOut: true });
    }
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
    // Expired / inactive: drop a stale token so GPT cannot keep sending it.
    if (data.entitlement && data.entitlement.allowed === false) {
      localStorage.removeItem(TOKEN_KEY);
    }
    lastStatus = data;
    return data;
  }

  /**
   * Fire once when trialEndsAt is reached (from the server's date — not a poll interval).
   * Clears the license and nudges the UI / subscribe gate.
   */
  function armTrialExpiry(cfg, status) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
    const entitlement = status?.entitlement;
    if (!entitlement?.trialEndsAt) return;
    if (entitlement.plan === 'pro' && entitlement.allowed) return;
    const ends = new Date(entitlement.trialEndsAt).getTime();
    if (!Number.isFinite(ends)) return;
    const fire = () => {
      expiryTimer = null;
      clearSession({ keepEmail: true });
      const expiredStatus = {
        ...status,
        entitlement: {
          ...entitlement,
          allowed: false,
          plan: 'trial',
          status: 'expired',
          reason: 'trial_expired',
        },
        licenseToken: null,
      };
      lastStatus = expiredStatus;
      track(cfg, 'trial_expired_autologout', {});
      if (typeof window.__searchableOnTrialExpired === 'function') {
        window.__searchableOnTrialExpired(expiredStatus);
      } else if (cfg?.licenseGate) {
        openGate(cfg, expiredStatus);
      }
      if (typeof window.__searchableOnAccountChanged === 'function') {
        window.__searchableOnAccountChanged({ trialExpired: true, status: expiredStatus });
      }
    };
    const ms = ends - Date.now();
    if (ms <= 0) {
      // Already expired: init/refresh clears the session and may open the gate.
      // Only force a logout if the status still claims the trial is active.
      if (entitlement.allowed) fire();
      return;
    }
    // setTimeout's max delay is 2^31-1 ms (~24.8d); trials are 14d.
    expiryTimer = setTimeout(fire, Math.min(ms + 250, 2147483647));
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

  function productCopy(cfg) {
    const days = Number(cfg?.trialDays) || 14;
    const gpt = typeof location !== 'undefined' && location.pathname.startsWith('/gpt');
    if (gpt) {
      return {
        title: 'Activate WhatsApp GPT',
        lead: `Create a free account for a <strong>${days}-day Pro trial</strong>. Your WhatsApp chats stay on this device — we only store your email for license and billing.`,
        later: 'Continue browsing (GPT later)',
      };
    }
    return {
      title: 'Activate AI search',
      lead: `Create a free account for a <strong>${days}-day Pro trial</strong>. Your WhatsApp chats stay on this device — we only store your email for license and billing.`,
      later: 'Continue browsing (AI search later)',
    };
  }

  function ensureModal(cfg) {
    let el = document.getElementById('account-gate');
    if (el) return el;
    const copy = productCopy(cfg);
    el = document.createElement('div');
    el.id = 'account-gate';
    el.innerHTML = `
      <div class="ag-backdrop">
        <div class="ag-card" role="dialog" aria-labelledby="ag-title">
          <h2 id="ag-title">${copy.title}</h2>
          <p class="ag-lead">${copy.lead}</p>
          <label class="ag-label" for="ag-email">Work email</label>
          <input id="ag-email" type="email" autocomplete="email" placeholder="you@company.com" />
          <div id="ag-code-wrap" hidden>
            <label class="ag-label" for="ag-code">Code from email</label>
            <input id="ag-code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" />
          </div>
          <p id="ag-msg" class="ag-msg" hidden></p>
          <button type="button" class="ag-primary" id="ag-submit">Email me a code</button>
          <button type="button" class="ag-secondary" id="ag-later">${copy.later}</button>
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

  async function openGate(cfg, status = null) {
    persistUtm();
    const el = ensureModal(cfg);
    el.hidden = false;
    const copy = productCopy(cfg);
    const title = document.getElementById('ag-title');
    const lead = el.querySelector('.ag-lead');
    const later = document.getElementById('ag-later');
    const submit = document.getElementById('ag-submit');
    const emailInput = document.getElementById('ag-email');
    const codeWrap = document.getElementById('ag-code-wrap');
    if (title) title.textContent = copy.title;
    if (lead) lead.innerHTML = copy.lead;
    if (later) later.textContent = copy.later;
    const saved = localStorage.getItem(EMAIL_KEY);
    if (saved && emailInput) emailInput.value = saved;

    document.getElementById('ag-later').onclick = () => {
      localStorage.setItem(SKIP_UNTIL_KEY, String(Date.now() + 6 * 3600000));
      el.hidden = true;
      track(cfg, 'account_gate_dismissed');
    };

    const expired = status?.entitlement?.reason === 'trial_expired';
    const canPay = expired && cfg?.stripeEnabled;
    if (canPay) {
      const days = Number(cfg?.trialDays) || 14;
      if (title) {
        title.textContent = location.pathname.startsWith('/gpt')
          ? 'Subscribe to continue WhatsApp GPT'
          : 'Subscribe to continue AI search';
      }
      if (lead) lead.textContent = `Your ${days}-day Pro trial has ended. Subscribe to keep using AI features.`;
      if (emailInput) emailInput.hidden = true;
      if (codeWrap) codeWrap.hidden = true;
      if (submit) {
        submit.textContent = 'Subscribe to Pro';
        submit.onclick = () => {
          startCheckout(cfg).catch((err) => showMsg(err.message || 'Checkout failed', false));
        };
      }
      return;
    }
    if (emailInput) emailInput.hidden = false;

    document.getElementById('ag-submit').onclick = async () => {
      const email = emailInput.value.trim().toLowerCase();
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
        // Refresh so trialEndsAt is armed for auto-logout at the real end time.
        void refreshAccount(cfg).catch(() => {});
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

  async function openBillingPortal(cfg) {
    const res = await fetch(apiUrl(cfg, '/api/control/billing/portal'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: getInstallId() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Billing portal failed');
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
    if (status?.entitlement?.reason === 'trial_expired') {
      clearSession({ keepEmail: true });
    }
    armTrialExpiry(cfg, status);
    if (shouldShowGate(cfg, status)) {
      await openGate(cfg, status);
    }
    if (typeof window.__searchableOnAccountChanged === 'function') {
      window.__searchableOnAccountChanged({ status });
    }
    return { status, installId: getInstallId(), authHeaders };
  }

  async function refreshAccount(cfg) {
    const status = await fetchLicenseStatus(cfg || window.__searchableAppConfig || {});
    if (status?.entitlement?.reason === 'trial_expired') {
      clearSession({ keepEmail: true });
    }
    armTrialExpiry(cfg || window.__searchableAppConfig || {}, status);
    if (typeof window.__searchableOnAccountChanged === 'function') {
      window.__searchableOnAccountChanged({ status });
    }
    return status;
  }

  window.SearchableAccount = {
    getInstallId,
    getEmail,
    hasSession,
    getLastStatus,
    authHeaders,
    initAccountGate,
    fetchLicenseStatus,
    refreshAccount,
    clearSession,
    logout,
    startCheckout,
    openBillingPortal,
    openGate,
    track,
  };
})();
