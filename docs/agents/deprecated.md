# Deprecated / Inactive Surfaces (Do Not Spend Agent Time Here)

**Active product UI is Ask AI / GPT:** `/gpt` → `public/gpt.html` + `public/gpt-app/`.

Unless the user **explicitly** asks to change one of the items below, **do not** read, refactor, “improve,” test, or extend them. Prefer fixing bugs in the GPT shell and shared WhatsApp sync/search backend that GPT already uses.

---

## 1. Classic WhatsApp Search UI (replaced by GPT)

| Path / surface | Notes |
|---|---|
| `public/index.html` | Classic full-app shell. `/` redirects to `/gpt`. |
| `GET /chats` in `src/web/server.js` | Legacy mirror route that still serves `index.html`. |
| `public/js/app.js` | Classic-only bootstrap (`init*` for the old shell). |
| Classic-only chrome in `index.html` | Old sidebar layout, classic AI-search header button, classic dashboard panels. |

**Still shared (OK to touch when GPT needs it):** `public/js/messages-render.js`, `chat-view.js`, `composer.js`, `overlays.js`, `wa-connection.js`, `settings.js`, `menus.js` (non-index items), etc. Those modules are imported by `public/gpt-app/gpt.js`.

---

## 2. Per-chat “AI indexing” button / menu (not actively used)

Opt-in indexing **UI** is inactive product work. Do not redesign, wire new flows, or polish these controls.

| Path / surface | Notes |
|---|---|
| `#menu-index-chat`, `#ctx-index-chat` | “Index for AI search” / “Stop AI indexing” menu items (`public/gpt.html`, `public/index.html`). |
| `.chat-ai-toggle` | Per-row AI index toggle CSS/JS (`public/css/*`, `public/gpt-app/gpt.css`, `sidebar.js`, `gpt.js`). |
| `syncIndexChatMenuItem` / `setChatIndexEnabled` UX in `public/js/menus.js`, `dashboard.js` | Client toggles calling `/api/chats/...` index endpoints. |
| Related settings copy about “Save Media Indexing” in classic settings | Classic settings row only. |

**Do not confuse with:** backend retrieval / FTS / JIT media OCR in `src/search/` and `src/gpt/retrieval.js` — those power Ask AI answers and **are** active. Leave indexing **APIs** alone unless a GPT search bug requires a minimal fix; do not expand the user-facing toggle product.

---

## 3. Multi-tenant / SaaS control-plane expansion (local single-tenant is the focus)

Local desktop + single workspace is the active deployment. Tenant plumbing exists for legacy rows (`legacy-default`) and must keep working, but **do not** build out multi-user tenancy.

| Path / surface | Notes |
|---|---|
| Multi-user session / tenant switching UX | Not an active product surface. |
| Expanding `src/web/auth-routes.js` for multi-account SaaS | Avoid unless explicitly requested. |
| Expanding `src/control-plane/` beyond license/trial/paywall needed by desktop | Billing/license gates used by the app are fine; do not grow multi-tenant admin/SaaS features. |
| `src/storage/migrate-multi-tenant.js` | Migration compatibility only — do not invent new tenant models. |

When touching DB/API code that already takes `tenantId`, keep the existing `runWithTenant` / `LEGACY_TENANT_ID` pattern. Do not add new multi-tenant product features.

---

## 4. Other inactive clients / prototypes

| Path | Notes |
|---|---|
| `extension/` | Chrome extension mirror — not the active desktop GPT product. |
| `mobile/` | Mobile prototype — inactive. |
| `wa-search-preview/`, `wa-search.jsx`, `vite.wa-search.config.js` | Old preview / prototype — inactive. |
| `public/analytics.html`, marketing-only pages | Not the in-app GPT workflow. |

---

## Agent checklist

1. Default work: **`/gpt`**, `public/gpt-app/`, `src/gpt/`, WhatsApp sync, search/grounding used by Ask AI.
2. If a task mentions “sidebar,” “chat list,” or “settings,” implement it in the **GPT shell**, not `public/index.html`.
3. If tempted to touch deprecated files for a shared helper, prefer extracting/sharing from GPT imports — do not revive classic-only UX.
4. See also: [architecture.md](./architecture.md), [anti-regressions.md](./anti-regressions.md).
