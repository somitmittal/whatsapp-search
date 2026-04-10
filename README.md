# WhatsApp Mirror — Local AI Search

Search all your WhatsApp chats using AI, 100% locally. No data leaves your machine (except LLM API calls you configure).

## Architecture

```
Chrome Extension (web.whatsapp.com)
  → extracts chats + messages from WhatsApp Web's internal stores
  → sends batches to localhost:3000/api/extension/messages

Node.js Local Server (localhost:3000)
  → SQLite (FTS5) for storage + full-text search
  → LLM-powered smart search: daily summaries → day selection → answer synthesis
  → Web UI: chat browser, AI search, import, settings

LLM Providers (your choice):
  → Google Gemini (free, recommended)
  → OpenAI GPT-4o
  → Anthropic Claude
  → Ollama (fully local, no internet)
```

## Quick Start

```bash
# 1. Install & start the server
npm install
npm start
# → opens http://localhost:3000

# 2. Install Chrome Extension
# Open chrome://extensions → Enable Developer mode → Load unpacked → select extension/ folder

# 3. Configure AI in Settings tab
# Get free Gemini API key: https://aistudio.google.com/apikey
# Or use Ollama for fully local AI

# 4. Open https://web.whatsapp.com → extension syncs automatically
```

## Features

- **Chrome Extension sync** — automatic background sync from your existing WhatsApp Web session
- **Import** — drag & drop WhatsApp exported `.zip` or `.txt` files for full history
- **AI search** — natural language search across all chats with cited sources
- **Multi-provider LLM** — Gemini (free), OpenAI, Claude, or Ollama (local)
- **Multimodal** — search images, videos, audio by caption/description
- **100% local data** — SQLite database on your machine, nothing uploaded

## File Structure

```
extension/           Chrome extension (Manifest V3)
  manifest.json      Extension config
  inject.js          Page-context script — accesses WhatsApp Web internals
  content.js         Content script — relays data to server
  background.js      Service worker — state management
  popup.html/js      Extension popup UI

src/
  index.js           App entry point
  config.js          Configuration loader
  web/server.js      Express + WebSocket server
  storage/database.js  SQLite with FTS5
  search/smart-search.js      LLM-powered search engine
  search/daily-summary-service.js   Auto daily summaries
  import/chat-import.js   WhatsApp export parser
  llm/               Multi-provider LLM layer
    provider.js      Factory + metadata
    gemini.js        Google Gemini
    openai.js        OpenAI GPT
    claude.js        Anthropic Claude
    ollama.js        Ollama (local)

public/index.html    Web UI (single page app)
data/                Local SQLite DB + media (gitignored)
```

## Dependencies

- `better-sqlite3` — SQLite with FTS5
- `express` — HTTP server
- `ws` — WebSocket for real-time updates
- `multer` — File upload handling
- `adm-zip` — ZIP extraction for imports
