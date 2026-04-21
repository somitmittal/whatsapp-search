document.addEventListener('DOMContentLoaded', () => {
  const serverUrlEl = document.getElementById('server-url');
  const accessTokenEl = document.getElementById('access-token');
  const saveServerBtn = document.getElementById('save-server-btn');

  chrome.storage.sync.get(['serverUrl', 'accessToken'], (r) => {
    if (serverUrlEl) serverUrlEl.value = r.serverUrl || 'http://localhost:3000';
    if (accessTokenEl) accessTokenEl.value = r.accessToken || '';
  });

  if (saveServerBtn) {
    saveServerBtn.addEventListener('click', () => {
      const serverUrl = (serverUrlEl && serverUrlEl.value || '').trim() || 'http://localhost:3000';
      const accessToken = (accessTokenEl && accessTokenEl.value || '').trim();
      chrome.storage.sync.set({ serverUrl, accessToken }, () => {
        saveServerBtn.textContent = 'Saved';
        setTimeout(() => { saveServerBtn.textContent = 'Save server settings'; }, 1500);
      });
    });
  }

  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const strategyBadge = document.getElementById('strategy-badge');
  const chatCount = document.getElementById('chat-count');
  const lastSync = document.getElementById('last-sync');
  const errorMsg = document.getElementById('error-msg');
  const domInfo = document.getElementById('dom-info');
  const progress = document.getElementById('progress');
  const syncBtn = document.getElementById('sync-btn');
  const openBtn = document.getElementById('open-ui-btn');

  function updateUI(state) {
    dot.className = `dot ${state.connected ? 'connected' : ''}`;
    statusText.textContent = state.connected
      ? (state.syncing ? 'Syncing...' : 'Connected')
      : 'Waiting...';
    chatCount.textContent = state.chatCount || '\u2014';
    lastSync.textContent = state.lastSync
      ? new Date(state.lastSync).toLocaleTimeString()
      : 'Never';

    const strategy = state.strategy || 'none';
    strategyBadge.className = `strategy-badge ${strategy}`;
    strategyBadge.textContent = strategy === 'webpack' ? 'Full Access'
      : strategy === 'dom' ? 'DOM Scraping'
      : '\u2014';

    domInfo.style.display = strategy === 'dom' ? '' : 'none';

    if (state.error) {
      errorMsg.textContent = state.error;
      errorMsg.style.display = '';
    } else {
      errorMsg.style.display = 'none';
    }

    if (state.syncing && state.syncProgress) {
      const p = state.syncProgress;
      progress.textContent = `${p.current}/${p.total} chats \u2014 ${p.totalMessages || 0} messages`;
      progress.style.display = '';
    } else {
      progress.style.display = 'none';
    }

    syncBtn.disabled = state.syncing || !state.connected;
  }

  chrome.runtime.sendMessage({ type: 'get-state' }, (state) => {
    if (state) updateUI(state);
  });

  const pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'get-state' }, (state) => {
      if (state) updateUI(state);
    });
  }, 2000);

  window.addEventListener('unload', () => clearInterval(pollInterval));

  syncBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'trigger-sync', since: 0 });
    syncBtn.disabled = true;
    statusText.textContent = 'Starting sync...';
  });

  openBtn.addEventListener('click', () => {
    chrome.storage.sync.get(['serverUrl'], (r) => {
      const u = (r.serverUrl || 'http://localhost:3000').trim();
      chrome.tabs.create({ url: u });
    });
  });
});
