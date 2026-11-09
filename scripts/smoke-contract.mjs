#!/usr/bin/env node
/**
 * scripts/smoke-contract.mjs — Layer 3 Smoke & Contract Verification Gate
 * (from walkinglabs/learn-harness-engineering Module 09: Three-Layer Termination)
 *
 * Verifies key architectural contracts without starting external network services:
 * 1. Database instantiation & schema migration.
 * 2. GptService and tools module contracts.
 * 3. Express server route contracts (especially /api/chats and /api/gpt).
 * 4. Grounding and retrieval contracts.
 *
 * Exits 0 on success; exits 1 on contract breakage.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check('Database initialization & in-memory migration', async () => {
  const { default: Database } = await import('../src/storage/database.js');
  const db = new Database(':memory:');
  const tableCount = db._db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table'").get()?.count || 0;
  if (tableCount < 5) throw new Error(`Expected at least 5 tables, got ${tableCount}`);
  db.close();
});

check('GPT limits & agent exports contract', async () => {
  const { GPT_LIMITS } = await import('../src/gpt/limits.js');
  if (!GPT_LIMITS.maxSteps || !GPT_LIMITS.contextTokens) {
    throw new Error('GPT_LIMITS missing essential budgets');
  }
  const { parseToolCalls, runAgent } = await import('../src/gpt/agent.js');
  if (typeof parseToolCalls !== 'function' || typeof runAgent !== 'function') {
    throw new Error('src/gpt/agent.js missing expected exports');
  }
});

check('Skills catalog contract', async () => {
  const { listManagedSkills } = await import('../src/skills/catalog.js');
  const { SYSTEM_SKILLS } = await import('../src/skills/system-skills.js');
  if (!Array.isArray(SYSTEM_SKILLS) || SYSTEM_SKILLS.length === 0) {
    throw new Error('SYSTEM_SKILLS missing or empty');
  }
  if (typeof listManagedSkills !== 'function') {
    throw new Error('listManagedSkills is not a function');
  }
});

check('Grounding & citation contract', async () => {
  const { enforceGroundedAnswer, UNGROUNDED_NOTICE } = await import('../src/search/grounding.js');
  if (typeof enforceGroundedAnswer !== 'function' || !UNGROUNDED_NOTICE) {
    throw new Error('Grounding contract violated');
  }
  // Fast test: answer with [m1] should keep grounded text
  const res = enforceGroundedAnswer('Sample [m1]', 'Sample message body [m1]');
  if (!res.text.includes('Sample')) throw new Error('enforceGroundedAnswer failed basic sanity');
});

check('Anti-regression: WhatsApp chats route contract exists in web server', async () => {
  const fs = await import('node:fs');
  const serverSrc = fs.readFileSync(resolve(ROOT, 'src/web/server.js'), 'utf8');
  if (!serverSrc.includes("'/api/chats'") && !serverSrc.includes('"/api/chats"')) {
    throw new Error('src/web/server.js missing critical /api/chats route mounting');
  }
  if (!serverSrc.includes("'/api/gpt/conversations'") && !serverSrc.includes('"/api/gpt/conversations"')) {
    throw new Error('src/web/server.js missing /api/gpt/conversations route mounting');
  }
});

async function run() {
  console.log('[Smoke Contract] Running Layer 3 structural contract checks...');
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`\n[Smoke Contract] ${failed} contract(s) failed!`);
    process.exit(1);
  }
  console.log('\n[Smoke Contract] All Layer 3 contract checks passed cleanly.');
}

run().catch((err) => {
  console.error('[Smoke Contract] Fatal:', err);
  process.exit(1);
});
