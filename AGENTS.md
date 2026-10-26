# AGENTS.md — rules for every agent working in this repo

The `kavida` workspace has multiple agents working on the same repository at the
same time. Follow these rules on every task, without being asked.

## Rule 1 — Always work in a worktree

- NEVER edit `/Users/somitmittal/Desktop/whatsapp-gpt` (the main checkout) or
  another agent's worktree directly.
- Before starting any change, create a dedicated worktree off `main`:

  ```bash
  git -C /Users/somitmittal/Desktop/whatsapp-gpt worktree add .worktrees/feature/<short-name> -b feature/<short-name> main
  ```

- Make all edits, tests, and commits inside that worktree only.
- One worktree per task/feature. Branch name: `feature/<short-name>`.
- Merge back to `main` only after the testing rule (below) is satisfied, and
  rebase/merge latest `main` into the branch first if it has moved.

## Rule 2 — Test everything before pushing

- Nothing gets pushed/merged without being verified:
  1. Run `npm test` (Jest) — must pass, add/extend tests for new logic.
  2. For UI/browser changes: run the local server, load the affected pages in a
     browser, and confirm the feature works end-to-end.
  3. For anything server/Electron-related: start the app (`npm start` or
     `npm run electron` from the worktree) and exercise the changed paths.
- If a change cannot be fully tested (e.g. needs a real WhatsApp link), state
  explicitly what was tested and what remains manual.

## Repo quick facts

- Node >= 22.23.4 <23 (security baseline; see engines), ESM (`"type": "module"`).
- Local server: `npm start` → http://localhost:3000 (dev data in `data/`).
- Packaged desktop app writes to
  `~/Library/Application Support/Searchable/data`.
- GPT UI: `/gpt`; main search UI: `/`.
- Control-plane code lives in `src/control-plane/` (Vercel entry: `api/index.js`).
