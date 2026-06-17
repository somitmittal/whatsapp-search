/**
 * Minimal preload — exposes desktop flag for optional renderer use.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  platform: process.platform,
});
