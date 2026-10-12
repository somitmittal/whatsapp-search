# LinkedIn GTM — Searchable (founder outbound)

Goal for the first 30 days: **50 trials → 5 paid**. Optimize messaging, not landing pages.

## ICP (who to message)

| Role keywords | Why they pay |
|---|---|
| Founder / Co-founder (SMB) | Lost deals/decisions in WA groups |
| Consultant / Fractional CXO | Client history is WhatsApp |
| Sales Lead / BD / Account Manager | Follow-ups buried in chats |
| Ops / EA / Chief of Staff | “Find that message” is their job |
| Agency owners (marketing, staffing, real estate, travel) | Client ops on WA |

**Geo:** India, UAE, Singapore, Indonesia, Nigeria, Brazil.

**Exclude for v1:** US enterprise IT / Slack-native buyers.

## Download links (UTM)

Always use the hosted download page with UTMs so analytics map to LinkedIn:

```
https://YOUR-RENDER-HOST/download?utm_source=linkedin&utm_campaign=founder_dm&utm_medium=dm
https://YOUR-RENDER-HOST/download?utm_source=linkedin&utm_campaign=founder_post&utm_medium=organic
```

Tracked platforms land on `/api/releases/download/{mac-arm64|mac-x64|windows|linux}`.

## 3-touch DM sequence (7 days)

### Day 0 — open

```
Hi {{first_name}} — saw your note on {{recent_post_hook}}.

Quick question: how much time did you waste last week searching WhatsApp for one decision?

I built Searchable — local AI search over WhatsApp (chats never leave your Mac/PC). 15s demo: {{loom_url}}

Happy to send the install link if useful — reply DEMO.
```

### Day 3 — nudge

```
{{first_name}} — curious if WhatsApp is basically your CRM.

If yes, here’s the download (14-day Pro trial for AI search):
{{download_utm_url}}

If not relevant, all good — ignore me.
```

### Day 7 — break-up

```
Closing the loop. If you want Searchable later: {{download_utm_url}}

Either way, appreciate your time.
```

## Weekly operating cadence

1. Post 3×/week (problem stories + blurred search clips + privacy line: “we bill for the search brain, not your chats”).
2. Comment on 10 ICP posts/day before DMing.
3. Build a **200-person** list/week in Sales Navigator (or free search).
4. Track in a sheet: Name | Company | Role | Stage (`replied` / `downloaded` / `trial` / `paid`) | Notes.
5. Review funnel Friday: LinkedIn replies → `/analytics` downloads by OS → control-plane users → Stripe.

## Content angles that convert

- “WhatsApp is the CRM nobody admits they use”
- “I indexed 4k business messages locally — here’s what AI found”
- “Your chats never leave your machine — we only bill for the search brain”

## Conversion path

LinkedIn → UTM download → install → account gate (email) → import/link WhatsApp → AI search → trial → Stripe paywall.
