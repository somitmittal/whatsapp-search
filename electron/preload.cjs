/**
 * Preload — desktop flag + in-app updater bridge for the renderer.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  openReleases: () => ipcRenderer.invoke('desktop:open-releases'),
  onUpdaterEvent: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = (_event, payload) => {
      try { cb(payload); } catch { /* ignore */ }
    };
    ipcRenderer.on('desktop:updater', handler);
    return () => ipcRenderer.removeListener('desktop:updater', handler);
  },
});
