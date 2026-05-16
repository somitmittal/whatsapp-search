/**
 * background.js — Chrome extension service worker.
 * Manages state and coordinates between content script and popup.
 */

let state = {
  connected: false,
  chatCount: 0,
  lastSync: null,
  syncing: false,
  syncProgress: null,
  error: null,
  strategy: null,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'status':
      // Always update connected and strategy
      state.connected = !!msg.payload.connected;
      state.strategy = msg.payload.strategy || state.strategy;
      
      // Only update chatCount if it's provided and we are connected
      if (state.connected) {
        state.chatCount = msg.payload.chatCount ?? state.chatCount;
      } else {
        state.chatCount = 0;
      }
      
      state.error = null;
      updateBadge();
      break;

    case 'sync-progress':
      state.syncing = true;
      state.syncProgress = msg.payload;
      break;

    case 'sync-complete':
      state.syncing = false;
      state.lastSync = new Date().toISOString();
      state.syncProgress = null;
      updateBadge();
      break;

    case 'error':
      state.error = msg.payload.message;
      break;

    case 'get-state':
      sendResponse(state);
      return true;

    case 'trigger-sync':
      broadcastToContentScripts({ type: 'trigger-sync', since: msg.since || 0 });
      break;
  }
});

function updateBadge() {
  const text = state.connected
    ? (state.chatCount > 0 ? String(state.chatCount) : '\u2713')
    : '';
  const color = state.connected ? '#00a884' : '#999999';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

async function broadcastToContentScripts(message) {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

updateBadge();
