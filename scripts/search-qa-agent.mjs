#!/usr/bin/env node
/**
 * Parallel QA agent for WhatsApp Search:
 * - Search path: Groq cloud (QA_SEARCH_PROVIDER=groq, GROQ_API_KEY)
 * - Summary path smoke: Ollama local qwen3.5:4b (small; QA_SUMMARY_PROVIDER=ollama, QA_SUMMARY_MODEL)
 *
 * Usage:
 *   GROQ_API_KEY=... npm run qa:search
 *   QA_USE_HTTP=1 npm run qa:search   # hit http://localhost:WEB_PORT (server must be up)
 *
 * Exits 1 if any critical check fails.
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load .env before config (same as app)
await import(resolve(ROOT, 'src/config.js'));

const { default: Database } = await import('../src/storage/database.js');
const { default: SmartSearch } = await import('../src/search/smart-search.js');
const { createProvider, clearProviderCache } = await import('../src/llm/provider.js');

const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const BASE = process.env.QA_BASE_URL || `http://127.0.0.1:${WEB_PORT}`;

const SEARCH_PROV = process.env.QA_SEARCH_PROVIDER || 'groq';
const SEARCH_KEY = process.env.GROQ_API_KEY || process.env.QA_GROQ_API_KEY || '';
const SEARCH_MODEL = process.env.QA_SEARCH_MODEL || 'llama-3.3-70b-versatile';

const SUMMARY_PROV = process.env.QA_SUMMARY_PROVIDER || 'ollama';
const SUMMARY_KEY = process.env.QA_SUMMARY_API_KEY || '';
const SUMMARY_MODEL = process.env.QA_SUMMARY_MODEL || 'qwen3.5:4b';

const USE_HTTP = process.env.QA_USE_HTTP === '1' || process.env.QA_USE_HTTP === 'true';

const bugs = [];
const flags = [];
const passed = [];

function flag(msg, severity = 'warn') {
  const line = `[${severity}] ${msg}`;
  flags.push(line);
  if (severity === 'error') bugs.push(line);
  console.error(line);
}

function ok(msg) {
  passed.push(msg);
  console.log(`[ok] ${msg}`);
}

function assertResultShape(result, label) {
  if (!result || typeof result !== 'object') {
    flag(`${label}: result is not an object`, 'error');
    return false;
  }
  if (typeof result.answer !== 'string') {
    flag(`${label}: missing string answer`, 'error');
    return false;
  }
  if (!Array.isArray(result.sources)) {
    flag(`${label}: sources is not an array`, 'error');
    return false;
  }
  return true;
}

async function runSearchHttp(query, chatJid = null) {
  const res = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, chatJid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function runSearchDirect(engine, query, chatJid = null) {
  return engine.search(query, chatJid);
}

async function parallelSearchTests(runSearch) {
  const cases = [
    { id: 'empty', query: '   ', expectNoThrow: true, allowEmptySources: true },
    { id: 'keyword', query: 'hello', expectNoThrow: true },
    { id: 'stopwords', query: 'the a an', expectNoThrow: true },
    { id: 'unicode', query: 'café 测试', expectNoThrow: true },
    { id: 'special', query: 'test <tag> & "quotes"', expectNoThrow: true },
    { id: 'long', query: 'word '.repeat(80).trim(), expectNoThrow: true },
  ];

  const tasks = cases.map(async (c) => {
    const t0 = Date.now();
    try {
      const result = await runSearch(c.query, null);
      const ms = Date.now() - t0;
      if (!assertResultShape(result, c.id)) return { id: c.id, ms, ok: false };
      if (c.id === 'empty' && result.answer && !result.answer.includes('Enter')) {
        flag(`empty query should prompt user (got: ${String(result.answer).slice(0, 80)})`, 'error');
        return { id: c.id, ms, ok: false };
      }
      ok(`${c.id} (${ms}ms)`);
      return { id: c.id, ms, ok: true };
    } catch (e) {
      flag(`${c.id}: ${e.message}`, 'error');
      return { id: c.id, ok: false, err: e.message };
    }
  });

  return Promise.all(tasks);
}

async function summaryProviderSmoke() {
  try {
    clearProviderCache();
    const p = await createProvider(SUMMARY_PROV, SUMMARY_KEY, SUMMARY_MODEL);
    const healthy = await p.checkHealth();
    if (!healthy) {
      flag(`Summary provider ${SUMMARY_PROV}/${p.model} health check failed`, 'warn');
      return;
    }
    ok(`Summary provider ready: ${SUMMARY_PROV} (${p.model})`);
    const reply = await p.chat(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      { temperature: 0, maxTokens: 16 },
    );
    if (!reply || String(reply).length < 1) {
      flag('Summary provider chat returned empty', 'warn');
    } else {
      ok('Summary provider mini chat OK');
    }
  } catch (e) {
    flag(`Summary provider smoke: ${e.message}`, 'warn');
  }
}

async function searchProviderParallelSmoke(searchProvider) {
  const n = 4;
  const t0 = Date.now();
  const chats = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      searchProvider.chat(
        [{ role: 'user', content: `Say only the digit ${i % 10}` }],
        { temperature: 0, maxTokens: 8 },
      ),
    ),
  );
  const ms = Date.now() - t0;
  if (chats.some((c) => !c || String(c).length === 0)) {
    flag('Parallel Groq chat smoke: empty response', 'warn');
  } else {
    ok(`Parallel search-provider chats (${n} concurrent, ${ms}ms)`);
  }
}

async function main() {
  console.log('WhatsApp Search QA agent\n');
  console.log(`Mode: ${USE_HTTP ? `HTTP ${BASE}` : 'in-process SmartSearch'}`);
  console.log(`Search: ${SEARCH_PROV} / ${SEARCH_MODEL}`);
  console.log(`Summary smoke: ${SUMMARY_PROV} / ${SUMMARY_MODEL}\n`);

  const runSearch = USE_HTTP
    ? (q, jid) => runSearchHttp(q, jid)
    : null;

  if (!USE_HTTP && !SEARCH_KEY && SEARCH_PROV !== 'ollama') {
    flag('GROQ_API_KEY (or QA_GROQ_API_KEY) missing — search LLM tests will fail. Set key or use QA_USE_HTTP=1 with server configured.', 'warn');
  }

  await summaryProviderSmoke();

  let searchEngine = null;
  if (!USE_HTTP) {
    clearProviderCache();
    const db = new Database();
    let searchProvider = null;
    try {
      searchProvider = await createProvider(SEARCH_PROV, SEARCH_KEY, SEARCH_MODEL);
    } catch (e) {
      flag(`Search provider init: ${e.message}`, 'error');
    }
    searchEngine = new SmartSearch(db, searchProvider);
    if (searchProvider) {
      const healthy = await searchProvider.checkHealth().catch(() => false);
      if (!healthy) {
        flag('Search provider not reachable — hierarchical + synthesis may fall back', 'warn');
      } else {
        await searchProviderParallelSmoke(searchProvider);
      }
    }
    await parallelSearchTests((q, jid) => runSearchDirect(searchEngine, q, jid));
    db.close();
  } else {
    await parallelSearchTests((q, jid) => runSearchHttp(q, jid));
  }

  console.log('\n--- Report ---');
  console.log(`Passed: ${passed.length}`);
  console.log(`Flags: ${flags.length}`);
  console.log(`Errors: ${bugs.length}`);
  if (flags.length) {
    console.log('\nAll flags:');
    for (const f of flags) console.log(f);
  }

  if (bugs.length > 0) {
    console.error('\nQA finished with errors.');
    process.exit(1);
  }
  console.log('\nQA passed (warnings only or clean).');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
