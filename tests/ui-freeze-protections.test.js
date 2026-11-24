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

  test('gpt.js avoids undefined dom references and provides WhatsApp QR/linking banner', () => {
    const gptJs = fs.readFileSync(path.join(process.cwd(), 'public/gpt-app/gpt.js'), 'utf8');
    const gptHtml = fs.readFileSync(path.join(process.cwd(), 'public/gpt.html'), 'utf8');
    const gptCss = fs.readFileSync(path.join(process.cwd(), 'public/gpt-app/gpt.css'), 'utf8');

    // Ensure no broken references to global `dom` in gpt.js
    expect(gptJs).not.toMatch(/\bdom\.\w+/);
    expect(gptJs).toContain('if (els.input) setupInlineEmojiAutocomplete(els.input)');

    // Ensure gpt.html directly loads chat list styles and includes QR banner
    expect(gptHtml).toContain('<link rel="stylesheet" href="/css/chat-list.css">');
    expect(gptHtml).toContain('id="gpt-wa-banner"');

    // Ensure gpt.css explicitly enables vertical scrolling for chat list
    expect(gptCss).toContain('overflow-y: auto');
    expect(gptCss).toContain('.gpt-wa-banner');

    // Ensure in-UI affordances for QR / linked devices
    expect(gptJs).toContain('renderWaBanner');
    expect(gptJs).toContain('gpt-btn-link-wa');
  });
});
