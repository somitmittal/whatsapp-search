/**
 * End-user style UI smoke for /gpt — roster speed, chat switch, Ask AI grounding.
 * Run against a live server: WEB_PORT=3000 node scripts/e2e-ui-askai-parity.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const out = { ok: true, steps: [], errors: [] };

function step(name, data = {}) {
  out.steps.push({ name, ...data, at: Date.now() });
  console.log(`✓ ${name}`, data.ms != null ? `${data.ms}ms` : '', data.detail || '');
}

function fail(name, err) {
  out.ok = false;
  out.errors.push({ name, err: String(err?.message || err) });
  console.error(`✗ ${name}:`, err?.message || err);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message || e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

try {
  const t0 = Date.now();
  await page.goto(`${BASE}/gpt`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#gpt-chat-list, #gpt-app', { timeout: 60000 });
  step('load /gpt', { ms: Date.now() - t0 });

  const rowSel = '#gpt-chat-list .chat-item[data-jid]';
  await page.waitForSelector(rowSel, { timeout: 60000 });
  const rowCount = await page.locator(rowSel).count();
  step('roster rows rendered', { detail: `${rowCount} rows` });
  if (rowCount < 5) fail('roster rows', `only ${rowCount} rows`);

  const switchTimes = [];
  const n = Math.min(8, rowCount);
  for (let i = 0; i < n; i++) {
    const row = page.locator(rowSel).nth(i);
    const t = Date.now();
    await row.click({ timeout: 10000 });
    await page.waitForTimeout(300);
    switchTimes.push(Date.now() - t);
  }
  const avgSwitch = Math.round(switchTimes.reduce((a, b) => a + b, 0) / switchTimes.length);
  step('chat switch x' + n, { ms: avgSwitch, detail: `times=${switchTimes.join(',')}` });

  const titles = await page.locator(rowSel).evaluateAll((els) =>
    els.slice(0, 12).map((el) => (el.querySelector('.chat-name, .name, .title')?.textContent || el.textContent || '').trim().slice(0, 80)),
  );
  const rawJidTitles = titles.filter((t) => /@s\.whatsapp\.net|@g\.us|@lid/.test(t));
  step('contact names', { detail: rawJidTitles.length ? `raw JIDs: ${rawJidTitles.slice(0, 3).join(' | ')}` : 'ok human names' });
  if (rawJidTitles.length > 3) fail('contact names', `${rawJidTitles.length} raw JID titles`);

  // End-user: open a chat, confirm bubbles + WA cluster/tail classes, scroll transcript
  await page.locator(rowSel).first().click({ timeout: 10000 });
  await page.waitForSelector('#gpt-wa-view .msg-block, #gpt-wa-view .empty-messages-state', { timeout: 30000 });
  // Let open-chat stick-to-bottom rAF + layout settle before asserting.
  await page.waitForTimeout(450);
  const transcriptStats = await page.evaluate(() => {
    const view = document.querySelector('#gpt-wa-view');
    if (!view) return null;
    const blocks = view.querySelectorAll('.msg-block');
    const tails = view.querySelectorAll('.msg-block.tail');
    const continued = view.querySelectorAll('.msg-block.continued');
    const spacers = view.querySelectorAll('.msg-vt-spacer');
    const openGap = view.scrollHeight - view.scrollTop - view.clientHeight;
    const openNearBottom = openGap < 140 || view.scrollHeight <= view.clientHeight + 40;
    const before = view.scrollTop;
    view.scrollTop = Math.max(0, view.scrollTop - Math.min(800, view.scrollHeight));
    const afterUp = view.scrollTop;
    view.scrollTop = view.scrollHeight;
    return {
      blocks: blocks.length,
      tails: tails.length,
      continued: continued.length,
      spacers: spacers.length,
      openGap,
      openNearBottom,
      scrolledUp: before !== afterUp || view.scrollHeight > view.clientHeight + 40,
      nearBottom: view.scrollHeight - view.scrollTop - view.clientHeight < 140,
    };
  });
  step('transcript paint + scroll', { detail: JSON.stringify(transcriptStats) });
  if (!transcriptStats) {
    fail('transcript paint', 'gpt-wa-view missing');
  } else if (transcriptStats.blocks < 1) {
    const empty = await page.locator('#gpt-wa-view .empty-messages-state').count();
    if (!empty) fail('transcript paint', 'no message blocks after opening chat');
  } else if (transcriptStats.tails < 1) {
    fail('WA cluster tails', 'expected .msg-block.tail on open chat');
  } else if (transcriptStats.blocks >= 1 && !transcriptStats.openNearBottom) {
    fail('open chat scroll bottom', `gap=${transcriptStats.openGap} after open (expected near bottom)`);
  }

  // Scroll to top to pull older pages; windowed paint should introduce spacers once > initial limit.
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const view = document.querySelector('#gpt-wa-view');
      if (view) view.scrollTop = 0;
    });
    await page.waitForTimeout(500);
  }
  const virtStats = await page.evaluate(() => {
    const view = document.querySelector('#gpt-wa-view');
    if (!view) return null;
    return {
      blocks: view.querySelectorAll('.msg-block').length,
      spacers: view.querySelectorAll('.msg-vt-spacer').length,
      scrollHeight: view.scrollHeight,
    };
  });
  step('virtualized window after scroll-up', { detail: JSON.stringify(virtStats) });

  const menuToggle = page.locator('#gpt-wa-view .msg-block .wa-msg-menu-toggle').first();
  if (await menuToggle.count()) {
    await page.locator('#gpt-wa-view .msg-block').first().hover({ timeout: 5000 }).catch(() => null);
    await menuToggle.click({ timeout: 5000, force: true }).catch(() => null);
    const menuVisible = await page.locator('#gpt-wa-view .wa-msg-menu:not([hidden])').count();
    step('message menu open', { detail: menuVisible ? 'visible' : 'hidden' });
    if (!menuVisible) fail('message menu open', 'menu did not open after chevron click');
    await page.keyboard.press('Escape').catch(() => null);
    await page.locator('body').click({ position: { x: 8, y: 8 } }).catch(() => null);
  } else {
    step('message menu open', { detail: 'no toggle (empty or media-only)' });
  }

  // Prefer global Ask AI for a clean unscoped anti-hallucination check
  const globalInput = page.locator('#gpt-global-search-input');
  if (await globalInput.count()) {
    await globalInput.fill('Did Zorpblat Qanex confirm a booking for 999888777 rupees as my wife?');
    await page.locator('#gpt-global-search-btn').click();
    step('submit global Ask AI');
  } else {
    const composerEarly = page.locator('#gpt-input');
    await composerEarly.fill('Did Zorpblat Qanex confirm a booking for 999888777 rupees as my wife?');
    await page.locator('#gpt-send').click();
    step('submit composer Ask AI');
  }

  const tAsk = Date.now();
  // Wait for an assistant message bubble (not the query sitting in the input)
  await page.waitForSelector('.gpt-msg.gpt-assistant', { timeout: 180000 }).catch(() => null);
  await page.waitForFunction(() => {
    const nodes = [...document.querySelectorAll('.gpt-msg.gpt-assistant')];
    const text = nodes.map((n) => n.innerText || '').join('\n');
    if (!text || text.length < 12) return false;
    if (/Gathering context|Writing the answer…|Searching “/i.test(text) && text.length < 80) return false;
    // Live stream replaced by final message (no .live class) or finished text present
    const live = document.querySelector('.gpt-msg.gpt-assistant.live');
    return !live || /which chat|which person|could not|not found|without guessing|Zorpblat|no /i.test(text);
  }, { timeout: 180000 }).catch(() => null);

  const answerText = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.gpt-msg.gpt-assistant:not(.live)')];
    const list = nodes.length ? nodes : [...document.querySelectorAll('.gpt-msg.gpt-assistant')];
    return list.map((n) => n.innerText || '').join('\n---\n');
  });
  const askMs = Date.now() - tAsk;
  const lower = String(answerText).toLowerCase();
  const excerpt = String(answerText).replace(/\s+/g, ' ').slice(0, 280);
  const affirmsWife = /\b(is|as|was|are)\b[^.\n]{0,40}\bwife\b|\bwife\b[^.\n]{0,40}\b(of|to)\b/i.test(answerText)
    && !/\b(not|no|never|without|which|could not|don't|do not)\b/i.test(answerText);
  const deniesOrClarifies = /which chat|which person|could not find|without guessing|not found|no message|look in|does not|don't|do not|never|no mention|nothing|no evidence|not in your chats/i.test(lower);
  step('Ask AI anti-hallucination', {
    ms: askMs,
    detail: deniesOrClarifies
      ? `refused/clarified :: ${excerpt}`
      : (affirmsWife ? `POSSIBLE wife hallucination :: ${excerpt}` : `inspect :: ${excerpt}`),
  });
  if (affirmsWife && !deniesOrClarifies) fail('Ask AI anti-hallucination', `Invented wife relationship: ${excerpt}`);
  if (!answerText || answerText.length < 10) fail('Ask AI response', 'No assistant answer text found');

  const composer = page.locator('#gpt-input');
  await composer.click({ timeout: 10000 });
  const focused = await composer.evaluate((el) => document.activeElement === el);
  step('composer clickable', { detail: focused ? 'focused' : 'not focused' });
  if (!focused) fail('composer clickable', 'composer did not take focus');

} catch (err) {
  fail('fatal', err);
} finally {
  if (consoleErrors.length) {
    out.errors.push({ name: 'console', err: consoleErrors.slice(0, 8).join(' || ') });
    // Soft: some console noise is ok; mark fail only if many
    if (consoleErrors.length > 5) out.ok = false;
    console.log('console errors:', consoleErrors.slice(0, 8));
  }
  await browser.close();
}

console.log('\n=== E2E SUMMARY ===');
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
