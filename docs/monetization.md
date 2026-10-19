# Monetization & control plane

Chats stay on-device. The **control plane** stores only accounts, licenses, download analytics, product events, and remote policy (lock / min version).

## Download analytics

- Users hit `/download` → buttons go to `/api/releases/download/:platform` (tracked) → 302 to GitHub.
- Platforms: `mac-arm64`, `mac-x64`, `windows`, `linux`.
- Admin UI: `/analytics` (Bearer `SESSION_SECRET`).
- JSON: `GET /api/analytics/downloads` with `Authorization: Bearer $SESSION_SECRET`.
- GitHub’s own `download_count` is exposed on `/api/releases/latest` assets.

## Accounts & trial

1. First open: account gate asks for email → magic link / 6-digit code.
2. Verified users get a **14-day Pro trial**.
3. Free forever: import + browse. Pro: AI search / WhatsApp GPT (and Stripe subscription after trial).

### Env (Render)

See `env.render.example` — `RESEND_API_KEY`, `STRIPE_*`, `POSTHOG_*`, `CONTROL_PLANE_PUBLIC_URL`, `LICENSE_GATE`.

Optional remote-control knobs on the **hosted** control plane:

| Env | Purpose |
|-----|---------|
| `APP_MIN_VERSION` | e.g. `1.0.11` — installs below this get `update_required` and cannot use Pro |
| `APP_UPDATE_DOWNLOAD_URL` | Override download page (default: `{CONTROL_PLANE_PUBLIC_URL}/download`) |

### Desktop builds (important)

Desktop releases must bake the hosted URL, or each install uses a **local** `control_plane.db` and Stripe/admin lock never apply.

1. Set GitHub Actions secret **`CONTROL_PLANE_URL`** to your Render public URL (same as `CONTROL_PLANE_PUBLIC_URL`).
2. Release workflow runs `scripts/write-control-plane-defaults.sh` before `electron-builder`, writing `electron/control-plane.defaults.json`.
3. Electron reads that file into `CONTROL_PLANE_URL` / `LICENSE_GATE=1` for the child server.

Local packaging without the secret leaves `controlPlaneUrl` empty (local-only gate).

## Remote lock (admin)

On `/analytics` (or API):

```bash
# Lock
curl -X POST "$HOST/api/control/admin/license" \
  -H "Authorization: Bearer $SESSION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","status":"disabled"}'

# Restore trial / Pro
curl -X POST "$HOST/api/control/admin/license" \
  -H "Authorization: Bearer $SESSION_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","status":"trialing"}'
```

Statuses: `disabled` / `revoked` / `locked` → client shows **Account locked** and AI/GPT returns 402. Offline license tokens expire after the existing grace window (~7 days).

## Force update

Set `APP_MIN_VERSION` on Render. License status responses include `policy.updateRequired`. Clients below the floor see **Update required** (not dismissible) and Pro APIs deny with `update_required`.

This only affects builds that call the hosted control plane (see Desktop builds above). Ungated old GitHub binaries that never contact your host cannot be remotely updated.

## Stripe

- Checkout: `POST /api/control/billing/checkout` `{ installId }`
- Portal: `POST /api/control/billing/portal` `{ installId }`
- Webhook: `POST /api/control/webhooks/stripe` (configure endpoint + `STRIPE_WEBHOOK_SECRET`)

## PostHog

Optional. Set `POSTHOG_API_KEY`. Events: `download_clicked`, `app_opened`, `account_created`, `trial_start`, `ai_search_run`, `paywall_shown`, `checkout_started`, `subscribed`, `admin_license_update`.

## LinkedIn GTM

See [linkedin-gtm.md](./linkedin-gtm.md).
