# Session Handoff Template

When concluding an agent session or passing work between worktrees, record the handoff summary using this template (e.g. in `.agent-context/session-handoff.md` or PR notes).

---

## 1. Session Metadata
* **Branch / Worktree:** `feature/<name>`
* **Date:** `YYYY-MM-DD`
* **Agent / Task Name:** `[Short description of task]`

## 2. Changes Made
* **Files modified:**
  - `path/to/file1` — [What changed]
  - `path/to/file2` — [What changed]
* **Files created:**
  - `path/to/new_file` — [Purpose]

## 3. Verification Evidence (Three-Layer Termination)
* **Layer 1 (Syntax Check):** `[PASS] node --check passed on changed files`
* **Layer 2 (Test Suite):** `[PASS] npm test (or ./scripts/verify.sh <test-file>) - X tests passing`
* **Layer 3 (Smoke / Contract Gate):** `[PASS] node scripts/smoke-contract.mjs passed`
* **Manual / Browser QA:** `[What was tested in UI / desktop, or what remains manual]`

## 4. Known Edge Cases / Blockers
* Any edge cases uncovered during testing.
* Open questions or dependencies.

## 5. Next Best Action
* Exactly what the next agent or human developer should run or inspect next.
