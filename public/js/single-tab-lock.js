import { refreshDash } from './dashboard.js';

export function initSingleTabLock() {
  (function singleTabLock() {
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
    }
    /**
     * Only refresh the lock if this tab still owns it (or lock is missing/stale).
     * Blind overwrites used to let the previous tab reclaim ownership ~every 1.2s after "Use here",
     * which re-showed the overlay and made the new tab look broken or hung.
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
      relinquish();
      showLockOverlay(true);
    }

    // initial acquire
    check();
    setInterval(check, 1500);

    window.addEventListener('storage', (e) => {
      if (e.key !== KEY || e.newValue == null) return;
      try {
        const cur = JSON.parse(e.newValue);
        if (cur && cur.tabId && cur.tabId !== tabId && isOwner) {
          relinquish();
          showLockOverlay(true);
        }
      } catch { /* ignore */ }
    });

    bc?.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'owner' && m.tabId && m.tabId !== tabId) {
        // Another tab took over
        if (isOwner) relinquish();
        showLockOverlay(true);
      }
    });

    document.getElementById('tab-lock-takeover')?.addEventListener('click', () => {
      becomeOwner();
      try { void refreshDash(); } catch { /* refreshDash defined later; ignore if unavailable */ }
    });
    document.getElementById('tab-lock-back')?.addEventListener('click', () => {
      // Keep overlay; user can close the tab.
      showLockOverlay(true);
    });
  })();
}
