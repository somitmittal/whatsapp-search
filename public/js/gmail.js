import { refreshDash } from './dashboard.js';
import { $ } from './util.js';

export async function refreshGmailImportUi() {
  const statusEl = $('#gmail-import-status');
  const loadBtn = $('#gmail-btn-load');
  const discBtn = $('#gmail-btn-disconnect');
  if (!statusEl || !loadBtn || !discBtn) return;
  try {
    const s = await fetch('/api/gmail/status').then(r => r.json());
    if (!s.configured) {
      statusEl.textContent = 'Not available on this server (Google OAuth is not configured).';
      loadBtn.disabled = true;
      discBtn.style.display = 'none';
      return;
    }
    loadBtn.disabled = false;
    if (s.connected) {
      statusEl.textContent = 'Connected: ' + (s.email || 'Google account');
      discBtn.style.display = '';
    } else {
      statusEl.textContent = 'Tap “Load WhatsApp Backup” to sign in and import exported chat attachments from Gmail.';
      discBtn.style.display = 'none';
    }
  } catch {
    statusEl.textContent = 'Could not reach the server. Check your connection and try again.';
    loadBtn.disabled = false;
    discBtn.style.display = 'none';
  }
}

export async function connectGmail(onboarding) {
  const params = new URLSearchParams();
  params.set('origin', window.location.origin);
  if (onboarding) params.set('ob', '1');
  let r;
  try {
    r = await fetch(`/api/gmail/auth-url?${params.toString()}`, { credentials: 'same-origin' });
  } catch (e) {
    alert(e.message || 'Network error');
    return;
  }
  let data;
  try {
    data = await r.json();
  } catch {
    alert('Invalid response from server');
    return;
  }
  if (!r.ok || !data.url) {
    alert(data.error || 'Could not start Google sign-in');
    return;
  }
  window.location.href = data.url;
}

export function initGmail() {
  $('#gmail-btn-load')?.addEventListener('click', async () => {
    const btn = $('#gmail-btn-load');
    if (!btn) return;
    btn.disabled = true;
    try {
      const s = await fetch('/api/gmail/status').then(r => r.json());
      if (!s.configured) {
        $('#import-result').classList.add('visible');
        $('#imp-title').textContent = 'Load WhatsApp Backup';
        $('#imp-text').textContent = 'Not available on this server (Google OAuth is not configured).';
        return;
      }
      if (!s.connected) {
        await connectGmail(false);
        return;
      }
      const r = await fetch('/api/gmail/sync', { method: 'POST', credentials: 'same-origin' });
      const data = await r.json();
      if (!r.ok) {
        $('#import-result').classList.add('visible');
        $('#imp-title').textContent = 'Load WhatsApp Backup';
        $('#imp-text').textContent = data.error || 'Failed';
        return;
      }
      const n = (data.results && data.results.length) || 0;
      $('#import-result').classList.add('visible');
      $('#imp-title').textContent = 'Backup loaded';
      const errTail = (data.errors && data.errors.length) ? ` Notes: ${data.errors.slice(0, 3).join('; ')}` : '';
      $('#imp-text').textContent = `Imported ${n} file(s). Skipped ${data.skipped || 0} already imported.${errTail}`;
      await refreshDash();
    } catch (e) {
      $('#import-result').classList.add('visible');
      $('#imp-title').textContent = 'Load WhatsApp Backup';
      $('#imp-text').textContent = e.message;
    } finally {
      btn.disabled = false;
      void refreshGmailImportUi();
    }
  });

  $('#gmail-btn-disconnect')?.addEventListener('click', async () => {
    await fetch('/api/gmail/disconnect', { method: 'POST' });
    void refreshGmailImportUi();
  });
}
