# End-to-End User Testing Guidelines (Speed + Accuracy)

All UI, search, chat, and Ask AI changes must be verified from a real end-user perspective against the live local server (`http://localhost:3000` and `/gpt`) with Browser DevTools (Console + Network) open.

**Core Principle:** Never ship "fast but wrong" or "accurate but slow." Every core flow must satisfy **both** perceived speed and strict factual accuracy, with zero uncaught Console exceptions or HTTP 500s.

---

## 1. Chat List & Contact Loading (Speed + Completeness)
- **Initial Load:** Hard-refresh `http://localhost:3000` and verify the WhatsApp chat roster renders and becomes interactive quickly.
- **Full Roster Scroll:** Scroll rapidly down both the **WhatsApp** and **Imported** tabs. Confirm all chats load smoothly with no blank rows, broken avatars, or frozen scroll.
- **Contact & Name Resolution:** Confirm contacts and group subjects resolve to real human/group names (no raw `@s.whatsapp.net` or `@lid` strings where a name is known) and there is **no sender-name flickering** inside group chats or sidebar previews.
- **Instant Chat Switching:** Click rapidly across 5–10 chats (large groups, 1:1 chats, media-heavy chats). Switching must feel near-instant without stale messages or blocking spinners.
- **Search Filter Speed:** Typing in **Search or start a new chat** must filter results immediately on keystroke.

## 2. Buttons, Dropdowns & Interactive Controls (Zero Dead Clicks)
Click every visible interactive control and verify immediate first-click response:
- **Header & Modals:** `WhatsApp` / `Imported` tabs, refresh button, `Import chats` modal open/close, Settings gear open/close.
- **In-Chat Controls:** Scroll-up history load, message dropdown (`v`) → **Copy message**, emoji reaction picker (open, react, outside-click dismiss), reply/quote button, image/PDF click-to-enlarge lightbox + download + close (no lingering invisible overlays or PDF iframe bleed).
- **Ask AI Composer:** Prompt input, `@ Add context`, `/ Skill`, model selector, and send button must all register on the first click with popups closing cleanly on outside click.

## 3. Ask AI — Magical Quality (Fast AND Grounded)
Measure **Time to First Token / Progress** and **Total Response Time**, and cross-check every claim against actual messages:
1. **Single-Chat Scoped Query (Strict Isolation + Speed):**
   - Scope Ask AI to a specific 1:1 or group chat. Confirm the context pill and placeholder display the **human chat title** (never a raw JID).
   - Ask about facts/dates/decisions in that chat. Verify fast response, 100% factual accuracy, and **zero leakage** from unrelated chats.
2. **Cross-Chat Needle-in-a-Haystack Query (Recall + Precision):**
   - Query across `All chats` for a fact living in a single older chat. Confirm it retrieves the right chat/messages, cites accurately, and avoids filler/hallucinations.
3. **Underspecified Multi-Turn Follow-up:**
   - Send a short follow-up (e.g., *"when was that?"*, *"who else replied?"*, *"final amount?"*) and verify it preserves context/scope quickly without re-scanning irrelevant chats.
4. **Media / Document / Receipt Search (OCR + Action Cards):**
   - Search for text inside an image or PDF (e.g., payment amount, invoice, ticket). Verify matching image/PDF cards appear quickly and **View in chat** jumps directly to the exact message.
5. **Adversarial "Doesn't Exist" Check (Anti-Hallucination):**
   - Ask about a non-existent person or booking. Confirm Ask AI reports nothing was found rather than fabricating details.

## 4. Required Test Report Format
When reporting E2E verification before merge, include:
- **Latency Observations:** Rough timings for page load, chat switching, UI interactions, and Ask AI turns.
- **Accuracy Verdict:** Pass/Fail for contacts, chat completeness, scoping isolation, factual grounding, and media search.
- **Console / Network Check:** Confirmation of zero uncaught JS errors and zero unexpected 4xx/5xx responses.
