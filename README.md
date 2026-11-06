# Searchable

**Local AI search and chat over your WhatsApp history.**

Searchable links to your WhatsApp account (like WhatsApp Web), syncs chats to a local SQLite database, and lets you search and ask questions with an LLM you choose — Gemini, OpenAI, Claude, or fully local Ollama. Your chat archive stays on your machine.

[![Node.js](https://img.shields.io/badge/node-22.x-brightgreen.svg)](https://nodejs.org)
[![GitHub release](https://img.shields.io/github/v/release/somitmittal/whatsapp-search)](https://github.com/somitmittal/whatsapp-search/releases)

---

## Why Searchable?

| | WhatsApp search | Searchable |
|---|---|---|
| Natural-language questions | No | Yes (“What did Mom say about the flight?”) |
| Cross-chat answers with citations | No | Yes |
| Runs offline with a local model | No | Yes (Ollama) |
| Data leaves your device | Cloud-backed | **Local SQLite** (except optional cloud LLM calls) |

---

## Features

- **QR link** — connect once; sessions restore automatically on next launch
- **AI search** — natural language over chats, with cited source messages
- **Chat list search** — WhatsApp-style sidebar filter: matching chat titles first, then chats whose messages contain the keywords
- **Ask AI (`/gpt`)** — ChatGPT-style assistant that can see your synced chats
- **Persistent memory** — durable facts the assistant remembers across conversations (editable in GPT Settings)
- **WhatsApp-style messaging** — reply, forward, react, voice notes
- **Media** — images, video, audio, and documents; voice notes play in every browser (Opus → AAC when needed)
- **Import** — drag & drop WhatsApp export `.zip` / `.txt` for full history
- **Chrome extension** (optional) — sync from an existing WhatsApp Web session
- **Desktop app** — macOS / Windows / Linux builds from [Releases](https://github.com/somitmittal/whatsapp-search/releases)

---

## Quick start

### Prerequisites

- **Node.js ≥ 22.23.4 and &lt; 23** — [nodejs.org](https://nodejs.org) (`node --version`)
- **ffmpeg** on your `PATH` (voice-note playback) — e.g. `brew install ffmpeg` on macOS  
  Or set `FFMPEG_PATH` (see [Configuration](#configuration))

### Install & run

```bash
git clone https://github.com/somitmittal/whatsapp-search.git
cd whatsapp-search
npm install
npm start
```

Open **http://localhost:3000**.

### Link WhatsApp

1. Open Settings → Linked Devices (or the connect prompt on the home page).
2. On your phone: **WhatsApp → Linked Devices → Link a Device** and scan the QR code.
3. Chats sync in the background. Later launches reconnect with the saved session (no re-scan).

### Configure AI

- Free Gemini key: https://aistudio.google.com/apikey  
- Or install [Ollama](https://ollama.com) for fully local AI (`ollama pull llama3.2:3b`)

### Optional: Chrome extension

`chrome://extensions` → Developer mode → **Load unpacked** → select the `extension/` folder.

---

## Desktop app

Download installers from [GitHub Releases](https://github.com/somitmittal/whatsapp-search/releases) or the in-app `/download` page.

Packaged app data lives at:

`~/Library/Application Support/Searchable/data` (macOS)

Replacing the `.app` does **not** wipe your chats. See [docs/desktop-releases.md](docs/desktop-releases.md).

### macOS first launch (ad-hoc signed builds)

```bash
# Eject any older Searchable DMG first so /Volumes/Searchable is this version.
rm -rf /Applications/Searchable.app
ditto /Volumes/Searchable/Searchable.app /Applications/Searchable.app
xattr -cr /Applications/Searchable.app
codesign --force --deep --sign - /Applications/Searchable.app
open /Applications/Searchable.app
```

Right-click → **Open** if Gatekeeper still prompts. Do not add `--options runtime` unless you also sign with `build/entitlements.mac.plist`.

---

## Architecture

```
WhatsApp (Baileys QR link)  — or —  Chrome extension (web.whatsapp.com)
        │
        ▼
Node.js server (localhost:3000)
  ├── SQLite + FTS5          storage & full-text search
  ├── LLM smart search       daily summaries → day pick → answer
  └── Web UI                 chats, search, /gpt, import, settings

LLM providers (your choice): Gemini · OpenAI · Claude · Ollama
```

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` / `WEB_HOST` | `127.0.0.1` locally | Bind address (`0.0.0.0` for LAN) |
| `DATA_DIR` | `./data` | Database, media, WhatsApp sessions |
| `FFMPEG_PATH` | `ffmpeg` | Binary for voice-note transcoding |
| `LLM_PROVIDER` | `ollama` | Default provider (also settable in UI) |

The server binds to loopback by default so chats are not advertised on your network. To use it from a phone on your LAN:

```bash
HOST=0.0.0.0 npm start
# then open http://<your-LAN-IP>:3000
```

### Data layout

```
data/
  whatsapp_search.db     messages, chats, memories (FTS5)
  media/                 downloaded media, per-chat folders
  tenants/<id>/
    .baileys_auth/       WhatsApp session (keep private)
    wa-config.json       per-tenant WhatsApp settings
```

Delete `data/` to start fresh (you will need to re-scan the QR).

---

## Voice notes & media

- **Record** from the composer mic — sent as a WhatsApp push-to-talk note.
- **Playback** — WhatsApp Opus (Ogg/MP4/WebM) is transcoded to AAC/`.m4a` on first play and cached, so Safari and Chromium both play them.
- **Download** — attachment filenames match the bytes served (e.g. `.m4a`), so phone downloads open in a normal audio player.
- **Video** — use the player fullscreen control, or double-click a clip for an expanded viewer.

Requires ffmpeg on the server for best voice-note compatibility.

---

## Development

```bash
npm start          # http://localhost:3000
npm test           # Jest
npm run electron   # desktop shell against the local server
```

**Rules for agents / contributors:** see [AGENTS.md](AGENTS.md) (worktrees, test-before-push).

### Layout

```
extension/              Chrome extension (Manifest V3)
src/
  index.js              app entry
  web/server.js         Express + WebSocket (media, WA routes)
  web/audio-transcode.js
  whatsapp/wa-client.js Baileys client (link, sync, send)
  storage/database.js   SQLite + FTS5
  search/               smart search + daily summaries
  import/               WhatsApp export parser
  gpt/                  assistant memory
  llm/                  multi-provider LLM layer
public/                 main UI + /gpt
electron/               desktop shell + updater
docs/                   releases, monetization, GTM notes
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Stuck after “Server ready” | Wait for `[WA] ✅ Connected…`; reconnect retries automatically when a session exists |
| No QR code | Confirm the server is up and reload; expired QR refreshes automatically |
| Mic blocked | Grant microphone for `http://localhost:3000`; plain LAN HTTP is not a secure context |
| Voice notes silent in Safari | Install ffmpeg / set `FFMPEG_PATH`; first play builds a cached `*.play.m4a` |
| Video won’t go fullscreen (desktop app) | Use a build that allows the `fullscreen` permission for the local UI; or double-click the video |
| Weak Ollama answers | Try a larger local model, or Gemini (free) |

---

## Docs

- [Desktop releases](docs/desktop-releases.md)
- [Monetization / analytics](docs/monetization.md)
- [LinkedIn GTM](docs/linkedin-gtm.md)

---

## Contributing

1. Branch from `main` in a worktree (see [AGENTS.md](AGENTS.md)).
2. Add or extend tests for behavior changes.
3. Run `npm test` before opening a PR.

Issues and PRs welcome: https://github.com/somitmittal/whatsapp-search/issues

---

## Disclaimer

WhatsApp is a trademark of WhatsApp Inc. This project is not affiliated with Meta or WhatsApp.
