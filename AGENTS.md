# AGENTS.md — Rules & Harness for Every Agent Working in This Repo

The `kavida` workspace has multiple autonomous agents working on the same repository at the same time. Follow these rules on every task, without being asked.

---

## 🚨 Non-Negotiable Core Rules

1. **Dedicated Worktree for Separate Changes (Rule 1):**
   Every agent MUST create an isolated worktree off `main` for their task. NEVER edit `/Users/somitmittal/Desktop/whatsapp-gpt` (the main checkout) or another agent's worktree directly.
2. **End-to-End Testing Verification (Rule 2):**
   All changes MUST be tested end-to-end and pass the Three-Layer Gate (`./scripts/verify.sh`) before any merge. No unverified code may be merged.
3. **Merge to `main` Once Tested (Rule 3):**
   Once and ONLY once changes are verified end-to-end, merge the feature branch cleanly into `main`.
4. **Inform the User Immediately (Rule 4):**
   Immediately after merging to `main`, inform the user with a summary of changes, end-to-end verification evidence, and merge confirmation.

---

## ⚡ The Agent Operating Harness (5 Subsystems)

Every agent session must follow the **Harness Lifecycle** (from `walkinglabs/learn-harness-engineering`):

### Phase 1: Bootstrap
Before touching any code, initialize your worktree environment:
```bash
source scripts/init.sh
```
* Ensures Node `>=22.23.4 <23` is active (from `/opt/homebrew/opt/node@22/bin`).
* Verifies `node_modules` and `better-sqlite3` native ABI bindings.

### Phase 2: Create & Work in Dedicated Worktree (Rule 1)
* **NEVER** edit `/Users/somitmittal/Desktop/whatsapp-gpt` (the main checkout) or another agent's worktree directly.
* Create a dedicated worktree off `main` for each separate task:
  ```bash
  git -C /Users/somitmittal/Desktop/whatsapp-gpt worktree add .worktrees/feature/<short-name> -b feature/<short-name> main
  ```
* Make all edits, tests, and commits inside that worktree only.
* Target **one atomic task at a time (WIP=1)**.

### Phase 3: End-to-End Testing & Verification Gate (Rule 2)
Nothing gets merged to `main` without full end-to-end testing and passing the **Three-Layer Termination Gate**:
```bash
./scripts/verify.sh
```
1. **Layer 1 (Static):** `node --check` syntax validation on all core and touched files.
2. **Layer 2 (Test Suite):** `npm test` (Jest VM modules) passes cleanly with 0 failures.
3. **Layer 3 (Smoke / Contracts):** `node scripts/smoke-contract.mjs` architectural invariants pass.

**End-to-End (E2E) Flow Verification:**
* For UI, API, or Electron changes: start the local server (`npm start`) or app (`npm run electron`) from the worktree and verify the complete user flow end-to-end.
* Follow [docs/agents/e2e-testing-guidelines.md](docs/agents/e2e-testing-guidelines.md) (`.cursor/rules/e2e-user-testing.mdc`) to verify **both speed and accuracy** across chat/contact loading, interactive buttons/controls, and Ask AI scoping/grounding/OCR search.
* Check against regressions listed in [docs/agents/anti-regressions.md](docs/agents/anti-regressions.md).
* If a change cannot be fully tested with live services (e.g. needs live WhatsApp pairing), mock or simulate the integration, explicitly stating what was tested end-to-end and what remains manual.

### Phase 4: Merge to `main` Once Tested End-to-End (Rule 3)
Once all three layers and end-to-end tests have passed:
1. Commit all changes cleanly on the feature branch inside your worktree:
   ```bash
   git add -A
   git commit -m "feat(<scope>): description of changes"
   ```
2. Merge the feature branch into `main`:
   ```bash
   git -C /Users/somitmittal/Desktop/whatsapp-gpt merge feature/<short-name>
   ```
3. Ensure `main` is clean, intact, and all changes integrate seamlessly without conflict.

### Phase 5: Inform User & Lifecycle Hygiene (Rule 4)
1. **Inform the User:** Notify the user immediately upon completing the merge to `main`. Include:
   * **Summary of Changes:** What was changed, created, or fixed.
   * **Test Verification Evidence:** Proof that Layer 1, Layer 2, Layer 3, and end-to-end manual/contract checks passed.
   * **Merge Confirmation:** Explicit confirmation that changes are merged to `main`.
2. **Worktree Hygiene:** Prune the completed/merged worktree:
   ```bash
   bash scripts/prune-worktrees.sh --force
   ```
3. **Session Handoff (if applicable):** If work is partial or being handed over to another agent/human, fill out notes following [docs/agents/session-handoff-template.md](docs/agents/session-handoff-template.md).

---

## 🚫 Deprecated / Inactive (Do Not Work On Unless Explicitly Asked)

Agents routinely waste time on old surfaces. **Skip these by default.** Full map: [docs/agents/deprecated.md](docs/agents/deprecated.md) (also `.cursor/rules/deprecated-surfaces.mdc`).

| Inactive | Active instead |
|---|---|
| Classic UI `public/index.html`, `public/js/app.js`, `GET /chats` | **GPT shell** `/gpt` → `public/gpt.html` + `public/gpt-app/` |
| Per-chat **AI indexing** button/menu (`.chat-ai-toggle`, Index for AI search) | Ask AI search/retrieval in `src/gpt/` + `src/search/` (no toggle UX work) |
| Multi-tenant SaaS / tenant-switch / auth expansion | Local **single-workspace** desktop; keep existing `tenantId` isolation only |
| `extension/`, `mobile/`, `wa-search-preview/`, `wa-search.jsx` | Electron + `/gpt` |

Files marked with `DEPRECATED` / `@deprecated` banners at the top are inactive entry points — do not “clean up” or extend them without an explicit user request.

---

## 📖 Progressive Disclosure Index (Read on Demand)

Do not load unnecessary context into your prompt upfront. Read these modular guides only when touching their respective domains:

* **[Deprecated / Inactive Surfaces](docs/agents/deprecated.md):** Classic UI, AI-indexing buttons, multi-tenant SaaS, old clients — **do not spend time here** unless the user asks.
* **[Architecture & Layout](docs/agents/architecture.md):** High-level view of Electron, Express server, SQLite storage, WhatsApp Baileys integration, and GPT agents.
* **[E2E User Testing Guidelines](docs/agents/e2e-testing-guidelines.md):** Speed + accuracy rubric for verifying chat/contact loading, UI button responsiveness, and Ask AI scoping/grounding/OCR search (`.cursor/rules/e2e-user-testing.mdc`).
* **[Anti-Regression Checklist](docs/agents/anti-regressions.md):** **MANDATORY CHECKLIST** before merging. Details previous regressions:
  - Ask AI composer overlay & clickability (`.cursor/rules/ask-ai-composer-clickable.mdc`)
  - WhatsApp chat list (`GET /api/chats`) vs. Ask AI threads (`GET /api/gpt/conversations`)
  - Desktop updater downgrade loops
  - Electron video fullscreen & media permissions
  - Outbound voice note persistence
* **[Session Handoff Template](docs/agents/session-handoff-template.md):** Standard format for agent session handoffs.
* **[Feature Backlog Primitives](feature_list.json):** Machine-verifiable task states and verification commands.

---

## 📌 Repo Quick Facts

* **Node:** `>=22.23.4 <23` (security baseline; see engines), ESM (`"type": "module"`).
* **Local server:** `npm start` → http://localhost:3000 (dev data in `data/`).
* **Desktop app data:** `~/Library/Application Support/Searchable/data` (macOS).
* **Primary UI:** Ask AI / GPT at `/gpt` (`/` redirects there). Classic WhatsApp search UI is deprecated.
* **Control-plane:** Lives in `src/control-plane/` (Vercel entry: `api/index.js`) — license/trial only; do not expand multi-tenant SaaS.
