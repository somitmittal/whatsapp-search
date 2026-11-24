import { refreshDash } from './dashboard.js';

export function initSingleTabLock() {
  (function singleTabLock() {
    // Desktop (Electron) app is always a dedicated single window — never lock or block interactions
    if (window.desktopApp?.isDesktop === true || new URLSearchParams(window.location.search).get('desktop') === '1') {
      const ov = document.getElementById('tab-lock-overlay');
      if (ov) {
        ov.classList.remove('open');
        ov.hidden = true;
        ov.style.display = 'none';
        ov.style.pointerEvents = 'none';
      }
      return;
    }

    const KEY = 'wa_search_active_tab_v1';
    const TAB_ID_KEY = 'wa_search_tab_id_v1';
    const HEARTBEAT_MS = 1200;
    const STALE_MS = 4000;
    // Persist per *tab* across refresh so reload doesn't look like "another tab".
    const tabId = (() => {
      try {
        const existing = sessionStorage.getItem(TAB_ID_KEY);
        if (existing) return existing;
        const id = Math.random().toString(16).slice(2) + Date.now().toString(16);
        sessionStorage.setItem(TAB_ID_KEY, id);
        return id;
      } catch {
        return Math.random().toString(16).slice(2) + Date.now().toString(16);
      }
    })();
    let isOwner = false;
    let hb = null;
    const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('wa-search-tab-lock') : null;

    function readLock() {
      try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
    }
    function writeLock(obj) {
      try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch {}
    }
    function showLockOverlay(show) {
      const ov = document.getElementById('tab-lock-overlay');
      if (!ov) return;
      ov.classList.toggle('open', !!show);
      if (!show) {
        ov.hidden = true;
        ov.style.display = 'none';
        ov.style.pointerEvents = 'none';
      } else {
        ov.hidden = false;
        ov.style.display = 'flex';
        ov.style.pointerEvents = 'auto';
      }
    }

    // Ensure overlay starts dismissed so it never intercepts clicks by default
    showLockOverlay(false);

    /**
     * Only refresh the lock if this tab still owns it (or lock is missing/stale).
     */
    function tickHeartbeat() {
      if (!isOwner) return;
      const cur = readLock();
      const now = Date.now();
      if (!cur || !cur.tabId || (now - (cur.ts || 0)) > STALE_MS) {
        writeLock({ tabId, ts: now });
        return;
      }
      if (cur.tabId !== tabId) {
        relinquish();
        showLockOverlay(true);
        return;
      }
      writeLock({ tabId, ts: now });
    }
    function becomeOwner() {
      isOwner = true;
      writeLock({ tabId, ts: Date.now() });
      showLockOverlay(false);
      if (hb) clearInterval(hb);
      hb = setInterval(tickHeartbeat, HEARTBEAT_MS);
      tickHeartbeat();
      bc?.postMessage({ type: 'owner', tabId });
    }
    function relinquish() {
      isOwner = false;
      if (hb) clearInterval(hb);
      hb = null;
    }
    function check() {
      const cur = readLock();
      const now = Date.now();
      if (!cur || !cur.tabId || (now - (cur.ts || 0)) > STALE_MS) {
        becomeOwner();
        return;
      }
      if (cur.tabId === tabId) {
        isOwner = true;
        showLockOverlay(false);
        if (!hb) {
          hb = setInterval(tickHeartbeat, HEARTBEAT_MS);
          tickHeartbeat();
        }
        return;
      }
      // If document is currently visible and active, automatically claim ownership
      // instead of freezing the user's interactive session
      if (document.visibilityState === 'visible' && document.hasFocus?.()) {
        becomeOwner();
        return;
      }
      relinquish();
      showLockOverlay(true);
    }

    // initial acquire
    check();
    setInterval(check, 1500);

    // Auto-acquire when tab gains focus or visibility so active user is never blocked
    window.addEventListener('focus', () => {
      becomeOwner();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') becomeOwner();
    });

    window.addEventListener('storage', (e) => {
      if (e.key !== KEY || e.newValue == null) return;
      try {
        const cur = JSON.parse(e.newValue);
        if (cur && cur.tabId && cur.tabId !== tabId && isOwner) {
          // If the tab is actively focused by the user, keep/reclaim ownership
          if (document.visibilityState === 'visible' && document.hasFocus?.()) {
            becomeOwner();
          } else {
            relinquish();
            showLockOverlay(true);
          }
        }
      } catch { /* ignore */ }
    });

    bc?.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'owner' && m.tabId && m.tabId !== tabId) {
        if (document.visibilityState === 'visible' && document.hasFocus?.()) {
          becomeOwner();
        } else {
          if (isOwner) relinquish();
          showLockOverlay(true);
        }
      }
    });

    document.getElementById('tab-lock-takeover')?.addEventListener('click', () => {
      becomeOwner();
      try { void refreshDash(); } catch { /* refreshDash defined later; ignore if unavailable */ }
    });
    document.getElementById('tab-lock-back')?.addEventListener('click', () => {
      // Dismiss overlay so user can still browse local cache/archive without getting frozen
      showLockOverlay(false);
    });
    document.getElementById('tab-lock-overlay')?.addEventListener('click', (e) => {
      if (e.target?.id === 'tab-lock-overlay') {
        showLockOverlay(false);
      }
    });
  })();
}
