import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

describe('UI Freeze Protections & Non-Blocking Overlay Invariants', () => {
  const cssDir = path.join(process.cwd(), 'public/css');
  const appCss = fs.readFileSync(path.join(cssDir, 'app.css'), 'utf8');
  const chatMessagesCss = fs.readFileSync(path.join(cssDir, 'chat-messages.css'), 'utf8');
  const settingsOverlayCss = fs.readFileSync(path.join(cssDir, 'settings-overlay.css'), 'utf8');
  const singleTabLockJs = fs.readFileSync(path.join(process.cwd(), 'public/js/single-tab-lock.js'), 'utf8');
  const appJs = fs.readFileSync(path.join(process.cwd(), 'public/js/app.js'), 'utf8');

  test('CSS enforces pointer-events: none and display: none for closed overlays', () => {
    // .confirm-overlay:not(.open)
    expect(appCss).toMatch(/\.confirm-overlay:not\(\.open\)\s*\{\s*display:\s*none\s*!important;\s*pointer-events:\s*none\s*!important;/);
    expect(chatMessagesCss).toMatch(/\.confirm-overlay:not\(\.open\)\s*\{\s*display:\s*none\s*!important;\s*pointer-events:\s*none\s*!important;/);

    // .wa-reaction-modal-overlay:not(.open)
    expect(appCss).toMatch(/\.wa-reaction-modal-overlay:not\(\.open\)\s*\{\s*display:\s*none\s*!important;\s*pointer-events:\s*none\s*!important;/);
    expect(chatMessagesCss).toMatch(/\.wa-reaction-modal-overlay:not\(\.open\)\s*\{\s*display:\s*none\s*!important;\s*pointer-events:\s*none\s*!important;/);

    // .avatar-viewer:not(.open)
    expect(appCss).toMatch(/\.avatar-viewer:not\(\.open\)\s*\{\s*display:\s*none\s*!important;\s*pointer-events:\s*none\s*!important;/);

    // .overlay-panel:not(.open)
    expect(settingsOverlayCss).toMatch(/\.overlay-panel:not\(\.open\)\s*\{\s*display:\s*none\s*!important;\s*pointer-events:\s*none\s*!important;/);
  });

  test('single-tab-lock disables lock for Desktop Electron app', () => {
    expect(singleTabLockJs).toContain('window.desktopApp?.isDesktop === true');
    expect(singleTabLockJs).toContain("new URLSearchParams(window.location.search).get('desktop') === '1'");
  });

  test('single-tab-lock auto-acquires on focus/visibility and dismisses overlay on Go back or backdrop', () => {
    expect(singleTabLockJs).toContain("window.addEventListener('focus'");
    expect(singleTabLockJs).toContain("document.addEventListener('visibilitychange'");
    expect(singleTabLockJs).toContain("document.getElementById('tab-lock-back')?.addEventListener('click'");
    expect(singleTabLockJs).toContain("showLockOverlay(false)");
  });

  test('app.js initializes modules defensively with individual try/catch blocks', () => {
    expect(appJs).toContain('try {');
    expect(appJs).toContain('catch (err)');
    expect(appJs).toContain('[app.js] init failed for');
  });
});
