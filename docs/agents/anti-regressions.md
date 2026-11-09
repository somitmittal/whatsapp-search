# Anti-Regression Checklist for Agents

These are real historical bugs and regressions that occurred in previous agent merges. Every agent working in this repo **must not regress** these invariants.

---

### 1. Ask AI Composer Clickability & Overlay Invariants
* **Bug:** Model dropdown menus, `@ Add context` chips, and prompt composer input became completely unclickable.
* **Root Cause:** Full-viewport elements (`#gpt-classic-overlays`) with `position: fixed; inset: 0; z-index: 200` captured pointer events above the `#gpt-composer-wrap`. Also settings scrims lacked `[hidden] { display: none !important; }`.
* **Rules:**
  - Never put full-viewport positioning on `.gpt-classic-overlays`; only `.overlay-panel` may be full-screen.
  - Keep `#gpt-composer-wrap` at `overflow: visible` so popups are never clipped.
  - See `.cursor/rules/ask-ai-composer-clickable.mdc`.

---

### 2. WhatsApp Sidebar Empty After Ask AI Merge
* **Bug:** After merging `saved-memory`, the WhatsApp sidebar chats completely disappeared.
* **Root Cause:** `loadChats()` in the frontend was incorrectly redirected to `/api/gpt/conversations` (Ask AI thread list) instead of `/api/chats` (the real WhatsApp roster).
* **Rules:**
  - WhatsApp chat roster **always** loads from `GET /api/chats`.
  - Ask AI conversation threads **always** load from `GET /api/gpt/conversations`.
  - These two endpoints must never be swapped or combined.

---

### 3. In-App Updater Loops and Downgrades
* **Bug:** Desktop app notified users: *"Update X is available — downloading..."* even when already running version X, and loop-downloaded.
* **Root Cause:** UI treated any returned `updateInfo.version` as an available upgrade, and `autoDownload` was set to `true`.
* **Rules:**
  - Always check `isUpdateAvailable` before presenting an update banner.
  - Never offer an update if `installedVersion === latestVersion`.
  - Keep `autoDownload = false` (user-initiated download only).
  - Version resets (e.g. back to 1.0.0) require manual reinstall; never try to downgrade clients over in-app updater.

---

### 4. Electron Desktop Video Fullscreen & Media Permissions
* **Bug:** HTML5 video fullscreen never worked in the packaged Electron app.
* **Root Cause:** `mainWindow.webContents.session.setPermissionCheckHandler(() => false)` blanket-denied all permissions except media.
* **Rules:**
  - Never blanket-deny Electron permissions; explicitly allow `media` and `fullscreen` for loopback origins.
  - Media CSS: ensure `:fullscreen` rules override bubble `max-width` and `max-height`.

---

### 5. Media Send-To-Self & Filename Persistence
* **Bug:** Sending voice notes or audio to oneself resulted in missing local files or downloading audio as `.mp4`.
* **Root Cause:** Outbound `sendFile` did not write bytes to local `media/` folder, relying on WhatsApp CDN re-download which often fails for self-chats.
* **Rules:**
  - Always persist outbound `sendFile` buffers into `data/media/` immediately.
  - Audio downloads must never force an `.mp4` extension when Content-Type is audio (see `src/web/media-filename.js`).

---

### 6. Native SQLite Bindings & Node Versions
* **Bug:** `NODE_MODULE_VERSION 127 vs 141` crash on running tests or server.
* **Root Cause:** Running tests with Node 25 while `better-sqlite3` was built against Node 22.
* **Rules:**
  - Node 22 (`>=22.23.4 <23`) is the only supported runtime engine.
  - Always run `scripts/init.sh` or ensure `/opt/homebrew/opt/node@22/bin` is first on `PATH`.
