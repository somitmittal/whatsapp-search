# AGENTS.md — Rules & Harness for Every Agent Working in This Repo

The `kavida` workspace has multiple autonomous agents working on the same repository at the same time. Follow these rules on every task, without being asked.

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

### Phase 2: Work in Dedicated Worktree (Rule 1)
* **NEVER** edit `/Users/somitmittal/Desktop/whatsapp-gpt` (the main checkout) or another agent's worktree directly.
* Create a dedicated worktree off `main`:
  ```bash
  git -C /Users/somitmittal/Desktop/whatsapp-gpt worktree add .worktrees/feature/<short-name> -b feature/<short-name> main
  ```
* Make all edits, tests, and commits inside that worktree only.
* Target **one atomic task at a time (WIP=1)**.

### Phase 3: Three-Layer Termination Verification (Rule 2)
Nothing gets pushed or merged without passing the **Three-Layer Termination Gate**:
```bash
./scripts/verify.sh
```
1. **Layer 1 (Static):** `node --check` syntax validation on all core files.
2. **Layer 2 (Test Suite):** `npm test` (Jest VM modules) passes cleanly.
3. **Layer 3 (Smoke / Contracts):** `node scripts/smoke-contract.mjs` architectural invariants pass.

For UI or Electron changes:
* Start the local server (`npm start`) or app (`npm run electron`) from the worktree and verify the user flow.
* If a change cannot be fully tested (e.g. needs live WhatsApp pairing), state explicitly what was tested and what remains manual.

### Phase 4: Lifecycle Handoff & Hygiene
* If another agent or user will continue your work, fill out the handoff notes following [docs/agents/session-handoff-template.md](docs/agents/session-handoff-template.md).
* Periodically audit and prune dead worktrees:
  ```bash
  bash scripts/prune-worktrees.sh          # Dry run
  bash scripts/prune-worktrees.sh --force  # Prune merged/dead worktrees
  ```

---

## 📖 Progressive Disclosure Index (Read on Demand)

Do not load unnecessary context into your prompt upfront. Read these modular guides only when touching their respective domains:

* **[Architecture & Layout](docs/agents/architecture.md):** High-level view of Electron, Express server, SQLite storage, WhatsApp Baileys integration, and GPT agents.
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
* **UIs:** Ask AI: `/gpt`; WhatsApp search: `/`.
* **Control-plane:** Lives in `src/control-plane/` (Vercel entry: `api/index.js`).
