# WhatsApp Mirror — Local AI Search

Search all your WhatsApp chats using AI, 100% locally. No data leaves your machine (except cloud LLM API calls you configure). If you strictly want full privacy, you can run a local model with Ollama (small models like 1B–3B parameters work, but can impact search quality).

## Architecture

```
WhatsApp (Baileys direct link)  — or —  Chrome Extension (web.whatsapp.com)
  → links to your WhatsApp account with a QR code (like WhatsApp Web)
  → syncs chats + messages into the local server

Node.js Local Server (localhost:3000)
  → SQLite (FTS5) for storage + full-text search
  → LLM-powered smart search: daily summaries → day selection → answer synthesis
  → Web UI: chat browser, AI search, GPT-style chat, import, settings

LLM Providers (your choice):
  → Google Gemini (free, recommended)
  → OpenAI GPT-4o
  → Anthropic Claude
  → Ollama (fully local, no internet)
```

## Features

- **Direct WhatsApp linking** — connect your WhatsApp account with a QR code (Baileys), no phone export needed. Chats sync automatically, and the app **auto-connects on startup** whenever a saved session exists.
- **AI search** — natural language search across all chats with cited sources.
- **GPT-style chat (`/gpt`)** — chat with your AI assistant; it can see your synced chats.
- **Auto-memory** — ChatGPT-style persistent memory for the assistant. It remembers durable facts about you across conversations ("Memory updated ✓" appears when something new is saved), can be viewed and edited in **GPT Settings → Saved memory**, and can be toggled off entirely.
- **WhatsApp-style messaging UI** — hover a message for the ▾ menu: **Reply** (with quote card), **Forward** (pick any chat), react, and more.
- **Voice notes** — record and send voice notes from the composer (WhatsApp-style floating pill), and play incoming ones. Incoming notes are transcoded to AAC/m4a on serve (cached), so they **play in every browser** — including Safari, which can't decode WhatsApp's native Opus format.
- **Chrome Extension sync** (optional, alternative to linking) — automatic background sync from an existing WhatsApp Web session.
- **Import** — drag & drop WhatsApp exported `.zip` or `.txt` files for full history.
- **Multi-provider LLM** — Gemini (free), OpenAI, Claude, or Ollama (local).
- **Multimodal** — search images, videos, audio by caption/description.
- **100% local data** — SQLite database on your machine, nothing uploaded.

## Quick Start (new setup)

**Prerequisites**

- **Node.js ≥ 22.23.4 and < 23** ([download](https://nodejs.org)) — check with `node --version`
- **ffmpeg** on your `PATH` (for voice-note playback in all browsers) — e.g. `brew install ffmpeg` on macOS. If it's somewhere else, set `FFMPEG_PATH` (see Configuration).

**1. Install & start the server**

```bash
git clone https://github.com/somitmittal/whatsapp-search.git
cd whatsapp-search
npm install
npm start
```

The server starts on **http://localhost:3000**.

**2. Link your WhatsApp account**

1. Open **http://localhost:3000** in your browser.
2. In **Settings → Linked Devices** (or the connect prompt on the home page), you'll see a QR code.
3. On your phone: **WhatsApp → ⋮ (or Settings) → Linked Devices → Link a Device** and scan the QR code.
4. Chats sync in the background — first-time sync of a full archive can take a while; the UI shows sync progress. Next time you start the server, it reconnects automatically with the saved session (no re-scan needed).

**3. Configure AI in Settings**

- Get a free Gemini API key: https://aistudio.google.com/apikey
- Or install [Ollama](https://ollama.com) for fully local AI (`ollama pull llama3.2:3b`).

**4. (Optional) Install the Chrome Extension**

Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the `extension/` folder. It syncs from your WhatsApp Web session as an alternative/additional source.

## Configuration (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` / `WEB_HOST` | loopback (`127.0.0.1`) on local machines | Bind address. Set `0.0.0.0` to expose on your LAN |
| `DATA_DIR` | `./data` | Where the database, media, and WhatsApp sessions are stored |
| `FFMPEG_PATH` | `ffmpeg` | Path to the ffmpeg binary used for voice-note transcoding |
| `LLM_PROVIDER` | `ollama` | Default AI provider (`gemini`, `openai`, `claude`, `ollama`, …) — also configurable in the UI |

The server binds to `127.0.0.1` locally so your chats are not advertised on your network. To use it from your phone, set `HOST=0.0.0.0` and browse to `http://<your-computer's-LAN-IP>:3000`.

## Where your data lives

```
data/
  whatsapp_search.db   SQLite DB: messages, chats, memories (FTS5-indexed)
  media/               Downloaded media, per-chat folders
  tenants/<id>/
    .baileys_auth/     WhatsApp session credentials (keep private!)
    wa-config.json     Per-tenant WhatsApp settings
```

Delete the directory to start completely fresh (you'll need to re-scan the QR).

## Voice notes

- **Recording:** click the mic in the composer, record, then send — it goes as a WhatsApp voice note (push-to-talk).
- **Playback:** WhatsApp voice notes arrive as Opus audio (in Ogg or MP4 containers), which Safari cannot decode and Chromium handles inconsistently. The server transcodes them to **AAC/m4a** on first play and caches the result, so playback works in Safari, Chrome, and Firefox alike.
- **Downloading on phones:** the served filename always matches the actual audio format (`.m4a`), so downloads open in any mobile audio player.
- Requires ffmpeg on the server; without it, notes still download but may not play in Safari.

## Troubleshooting

- **Startup seems stuck at "Server ready."** — Fixed in current versions: the WhatsApp client now auto-connects on boot when a saved session exists. If you see no `[WA] ✅ Connected as …` line after ~10s, check the log for a reconnect message; it retries automatically.
- **No QR code appears** — make sure the server is running and reload the page. An expired QR refreshes automatically.
- **Mic not working** — the browser needs microphone permission for `http://localhost:3000` (Chrome: padlock icon → Site settings → Microphone). `localhost` is treated as a secure context; plain LAN IPs are not, so recording may be blocked from a phone over HTTP.
- **Voice notes don't play in Safari** — make sure ffmpeg is installed and on your `PATH` (or set `FFMPEG_PATH`). The first play of each note does the one-time transcode; cached copies (`*.play.m4a`) are reused afterwards.
- **Search returns poor results with Ollama** — small local models are weaker; try a larger model, or use a cloud provider (Gemini is free).

## Desktop app (Searchable)

Download DMGs/installers from [GitHub Releases](https://github.com/somitmittal/whatsapp-search/releases) or the in-app `/download` page. See [docs/desktop-releases.md](docs/desktop-releases.md).

**Monetization / analytics:** tracked downloads, accounts, 14-day Pro trial, Stripe, and LinkedIn GTM — see [docs/monetization.md](docs/monetization.md) and [docs/linkedin-gtm.md](docs/linkedin-gtm.md). Admin download stats: `/analytics`.

### macOS first launch

Builds are ad-hoc signed (no Apple Developer account). **`xattr` alone is not enough** if Gatekeeper reports a damaged/invalid signature. With the DMG open:

```bash
# Eject any older Searchable DMG first so /Volumes/Searchable is this version.
rm -rf /Applications/Searchable.app
ditto /Volumes/Searchable/Searchable.app /Applications/Searchable.app
xattr -cr /Applications/Searchable.app
codesign --force --deep --sign - /Applications/Searchable.app
open /Applications/Searchable.app
```

Do **not** add `--options runtime` unless you also sign with `build/entitlements.mac.plist`. Right-click → **Open** if macOS still prompts.

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
  web/server.js      Express + WebSocket server (media serving, WA routes)
  web/audio-transcode.js  Voice-note Opus → AAC/m4a transcode (cached)
  whatsapp/wa-client.js   Baileys WhatsApp client (link, sync, send)
  storage/database.js  SQLite with FTS5
  search/smart-search.js      LLM-powered search engine
  search/daily-summary-service.js   Auto daily summaries
  import/chat-import.js   WhatsApp export parser
  gpt/user-memory.js      Persistent assistant memory
  llm/               Multi-provider LLM layer
    provider.js      Factory + metadata
    gemini.js        Google Gemini
    openai.js        OpenAI GPT
    claude.js        Anthropic Claude
    ollama.js        Ollama (local)

public/index.html    Main UI (chat browser, search, settings)
public/gpt.html      GPT-style chat UI (/gpt) with memory + voice notes
data/                Local SQLite DB + media (gitignored)
```

## Dependencies

- `better-sqlite3` — SQLite with FTS5
- `express` — HTTP server
- `ws` — WebSocket for real-time updates
- `multer` — File upload handling
- `adm-zip` — ZIP extraction for imports
- `@whiskeysockets/baileys` — WhatsApp linking (QR, sync, send)
