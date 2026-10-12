# Monetization & control plane

Chats stay on-device. The **control plane** stores only accounts, licenses, download analytics, and product events.

## Download analytics

- Users hit `/download` → buttons go to `/api/releases/download/:platform` (tracked) → 302 to GitHub.
- Platforms: `mac-arm64`, `mac-x64`, `windows`, `linux`.
- Admin UI: `/analytics` (Bearer `SESSION_SECRET`).
- JSON: `GET /api/analytics/downloads` with `Authorization: Bearer $SESSION_SECRET`.
- GitHub’s own `download_count` is exposed on `/api/releases/latest` assets.

## Accounts & trial

1. First open: account gate asks for email → magic link / 6-digit code.
2. Verified users get a **14-day Pro trial**.
3. Free forever: import + browse. Pro: AI search (and Stripe subscription after trial).

### Env (Render)

See `env.render.example` — `RESEND_API_KEY`, `STRIPE_*`, `POSTHOG_*`, `CONTROL_PLANE_PUBLIC_URL`, `LICENSE_GATE`.

### Desktop

Set `CONTROL_PLANE_URL=https://your-render-host` so the packaged app uses the hosted control plane. Without it, a local `control_plane.db` is used (codes shown in-app when Resend is unset).

## Stripe

- Checkout: `POST /api/control/billing/checkout` `{ installId }`
- Portal: `POST /api/control/billing/portal` `{ installId }`
- Webhook: `POST /api/control/webhooks/stripe` (configure endpoint + `STRIPE_WEBHOOK_SECRET`)

## PostHog

Optional. Set `POSTHOG_API_KEY`. Events: `download_clicked`, `app_opened`, `account_created`, `trial_start`, `ai_search_run`, `paywall_shown`, `checkout_started`, `subscribed`.

## LinkedIn GTM

See [linkedin-gtm.md](./linkedin-gtm.md).
