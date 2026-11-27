# Architecture Guide for Agents

This document outlines the core architecture of Searchable (`whatsapp-gpt`), describing key sub-systems, data flow, and runtime expectations.

## 1. System Components Overview

Searchable operates as a hybrid local web application and packaged Electron desktop app.

* **Backend / API Server (`src/index.js`, `src/web/server.js`)**:
  - Express-based local HTTP server (default port 3000, overridable by `WEB_PORT`).
  - Routes for WhatsApp sync, chat rosters (`/api/chats`), Ask AI sessions (`/api/gpt/conversations`), and expenses.
  - Row-level `tenantId` isolation via `src/storage/tenant-context.js` (local single-workspace; **multi-tenant SaaS is deprecated** — see [deprecated.md](./deprecated.md)).
  - **Primary UI route:** `/gpt`. `/` redirects to `/gpt`. Classic `index.html` / `/chats` is deprecated.

* **Storage & Indexing (`src/storage/database.js`)**:
  - Local SQLite database powered by `better-sqlite3`.
  - SQLite WAL mode + foreign keys enabled.
  - FTS5 full-text search triggers on incoming messages.
  - Media attachments indexed and stored locally in `data/media/`.

* **Desktop Shell (`electron/main.cjs`, `electron/`)**:
  - Electron 45 runtime wrapping the local server and web UI.
  - Desktop data path: `~/Library/Application Support/Searchable/data` (macOS).
  - Explicit loopback security policies: permissions restricted via `electron/media-permissions.cjs`.

* **WhatsApp Integration (`src/whatsapp/wa-client.js`)**:
  - Powered by `@whiskeysockets/baileys`.
  - Ingestion gate and priority queue for unread and high-priority chats.
  - Multi-device QR connection and background sync.

* **In-App AI Agent Engine (`src/gpt/`, `src/skills/`)**:
  - Multi-turn tool-calling agent loop in `src/gpt/agent.js`.
  - Tool catalog (`search`, `read`, `chats`, `summaries`, `reconcile`) in `src/gpt/tools.js`.
  - Context engine (`src/gpt/context.js`) packing WhatsApp context within `GPT_LIMITS` budgets.
  - Provider adapters (`src/llm/`): Ollama, Groq, OpenAI, Gemini, Claude, OpenRouter.
  - Grounding and citation engine (`src/search/grounding.js`) enforcing `[m...]` reference integrity.

## 2. Directory Layout

```
whatsapp-gpt/
├── AGENTS.md                  # Root agent rules & progressive router
├── docs/agents/               # Agent guides (architecture, deprecated, anti-regressions)
├── electron/                  # Electron main process & desktop packaging scripts
├── public/
│   ├── gpt.html + gpt-app/    # ACTIVE primary UI (Ask AI + WA in GPT shell)
│   ├── index.html + js/app.js # DEPRECATED classic UI (do not extend)
│   └── js/*                   # Shared modules — edit when imported by gpt.js
├── scripts/                   # Harness scripts (init.sh, verify.sh, prune-worktrees.sh)
├── src/
│   ├── gpt/                   # Ask AI agent, tools, context engine, model registry
│   ├── llm/                   # LLM provider clients (Ollama, Groq, Gemini, etc.)
│   ├── search/                # Grounding, hybrid retrieval, synthesis
│   ├── skills/                # Slash-skills, expense reconciliation runners
│   ├── storage/               # SQLite database (tenant columns = isolation, not SaaS product)
│   ├── web/                   # Express HTTP routes and middleware
│   └── whatsapp/              # Baileys WhatsApp client, ingestion queues
├── extension/, mobile/, wa-search*  # DEPRECATED inactive clients/prototypes
└── tests/                     # Jest test suites
```

## 3. Node & Environment Invariants

* **Node version:** Node `>=22.23.4 <23` is required (`package.json.engines`).
* **Bootstrap:** Always execute `source scripts/init.sh` before testing or developing in a worktree to ensure the correct Node 22 binary and native SQLite ABI are loaded.
