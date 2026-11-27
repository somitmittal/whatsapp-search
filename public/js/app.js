/**
 * @deprecated Classic shell bootstrap only (`public/index.html`).
 * Active UI is `/gpt` → `public/gpt-app/gpt.js`. Do not add features here.
 * See docs/agents/deprecated.md
 */
// Entry point: imports every UI module and runs their init() in the original script order.
import { initFetchShim } from './fetch-shim.js';
import { initConstants } from './constants.js';
import { initOverlays } from './overlays.js';
import { initSingleTabLock } from './single-tab-lock.js';
import { initMenus } from './menus.js';
import { initGmail } from './gmail.js';
import { initExpenses } from './expenses.js';
import { initWs } from './ws.js';
import { initWaConnection } from './wa-connection.js';
import { initWaBootstrap } from './wa-bootstrap.js';
import { initMessageActions } from './message-actions.js';
import { initContacts } from './contacts.js';
import { initSidebar } from './sidebar.js';
import { initStatusFeed } from './status-feed.js';
import { initAvatars } from './avatars.js';
import { initChatView, openChat } from './chat-view.js';
import { initAwaySummary } from './away-summary.js';
import { initSearch } from './search.js';
import { initComposer } from './composer.js';
import { initBusiness } from './business.js';
import { initImport } from './import.js';
import { initSettings } from './settings.js';
import { initSkillsSettings } from './skills-settings.js';
import { initOllamaSetup } from './ollama-setup.js';
import { initOnboarding } from './onboarding.js';
import { initDesktopUpdates } from './desktop-updates.js';

const inits = [
  ['fetchShim', initFetchShim],
  ['constants', initConstants],
  ['overlays', initOverlays],
  ['singleTabLock', initSingleTabLock],
  ['menus', initMenus],
  ['gmail', initGmail],
  ['expenses', initExpenses],
  ['ws', initWs],
  ['waConnection', initWaConnection],
  ['waBootstrap', initWaBootstrap],
  ['messageActions', initMessageActions],
  ['contacts', initContacts],
  ['sidebar', initSidebar],
  ['statusFeed', initStatusFeed],
  ['avatars', initAvatars],
  ['chatView', initChatView],
  ['awaySummary', initAwaySummary],
  ['search', initSearch],
  ['composer', initComposer],
  ['business', initBusiness],
  ['import', initImport],
  ['settings', initSettings],
  ['skillsSettings', initSkillsSettings],
  ['ollamaSetup', initOllamaSetup],
  ['onboarding', initOnboarding],
  ['desktopUpdates', initDesktopUpdates],
];

for (const [name, fn] of inits) {
  try {
    fn();
  } catch (err) {
    console.error(`[app.js] init failed for ${name}:`, err);
  }
}

const deepLink = new URLSearchParams(location.search);
if (deepLink.get('chat')) {
  void openChat(deepLink.get('chat'), deepLink.get('msg') || null);
  history.replaceState(null, '', location.pathname);
}
