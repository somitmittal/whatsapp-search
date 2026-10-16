import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'gpt-models-'));
process.env.DATA_DIR = scratch;
delete process.env.OPENAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_API_KEY;

const { default: Database } = await import('../src/storage/database.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');
const {
  listModelCatalog, providerForSelection, resolveProviderKey, setProviderKey,
} = await import('../src/gpt/model-registry.js');
const { default: GptService } = await import('../src/gpt/gpt-service.js');

const TENANT = 'tenant-models';
let db;
beforeAll(() => {
  db = new Database();
  runWithTenant(TENANT, () => {
    db.setSetting('llm_provider', 'groq');
    db.setSetting('llm_model', 'llama-3.3-70b-versatile');
    db.setSetting('llm_api_key', 'groq-key-from-settings');
  });
});
afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('resolveProviderKey', () => {
  test('reuses the Settings key for the active provider and none for others', () => {
    runWithTenant(TENANT, () => {
      expect(resolveProviderKey(db, 'groq')).toBe('groq-key-from-settings');
      expect(resolveProviderKey(db, 'openai')).toBe('');
    });
  });

  test('picker keys win and can be cleared', () => {
    runWithTenant(TENANT, () => {
      setProviderKey(db, 'openai', ' sk-test ');
      expect(resolveProviderKey(db, 'openai')).toBe('sk-test');
      setProviderKey(db, 'openai', '');
      expect(resolveProviderKey(db, 'openai')).toBe('');
      expect(() => setProviderKey(db, 'nope', 'x')).toThrow(/Unknown provider/);
    });
  });
});

describe('listModelCatalog', () => {
  test('marks configured providers and reports the default selection', async () => {
    await runWithTenant(TENANT, async () => {
      const cat = await listModelCatalog(db);
      expect(cat.default).toEqual({ provider: 'groq', model: 'llama-3.3-70b-versatile' });
      const byId = Object.fromEntries(cat.providers.map((p) => [p.id, p]));
      expect(byId.groq.configured).toBe(true);
      expect(byId.groq.keySource).toBe('settings');
      expect(byId.claude.configured).toBe(false);
      expect(byId.claude.models.length).toBeGreaterThan(0);
    });
  });
});

describe('providerForSelection', () => {
  test('falls back to the default provider for Auto', async () => {
    const fallback = { name: 'fake' };
    const out = await providerForSelection(db, null, fallback);
    expect(out).toEqual({ provider: fallback, selection: null });
  });

  test('refuses a provider without a key instead of silently using another', async () => {
    await runWithTenant(TENANT, async () => {
      await expect(providerForSelection(db, { provider: 'claude', model: 'claude-sonnet-5-5' }, { name: 'fake' }))
        .rejects.toThrow(/no API key/);
    });
  });

  test('builds the picked provider with its key and model', async () => {
    await runWithTenant(TENANT, async () => {
      setProviderKey(db, 'openai', 'sk-pick');
      const out = await providerForSelection(db, { provider: 'openai', model: 'gpt-6-luna' }, null);
      expect(out.provider.name).toBe('openai');
      expect(out.provider.model).toBe('gpt-6-luna');
      expect(out.selection).toEqual({ provider: 'openai', model: 'gpt-6-luna' });
    });
  });
});

describe('GptService per-thread model', () => {
  function fakeProvider(name, model) {
    return {
      name, model,
      async chat() { return ''; },
      async *chatStream() { yield `answer from ${model}`; },
    };
  }

  test('remembers the picked model across turns and returns to Auto on null', async () => {
    await runWithTenant(TENANT, async () => {
      db.insertMessageBatch([{ messageId: 'x1', chatJid: 'c@g.us', chatName: 'C', sender: 'A', text: 'hello there', timestamp: 1_700_000_000 }]);
      const auto = fakeProvider('fake-default', 'default-model');
      const seen = [];
      const resolveProvider = async (_db, selection, fallback) => {
        seen.push(selection);
        if (!selection) return { provider: fallback, selection: null };
        return { provider: fakeProvider(selection.provider, selection.model), selection };
      };
      const svc = new GptService({ db, getProvider: () => auto, resolveProvider });
      const pick = { provider: 'openai', model: 'gpt-6-luna' };

      const first = await svc.handleTurn({ message: 'hello', model: pick });
      expect(first.model).toEqual(pick);
      expect(first.conversation.model).toEqual(pick);
      expect(first.answer).toContain('answer from gpt-6-luna');

      // No `model` in the request → the thread keeps its pick.
      const second = await svc.handleTurn({ conversationId: first.conversationId, message: 'more' });
      expect(seen.at(-1)).toEqual(pick);
      expect(second.model).toEqual(pick);

      const back = await svc.handleTurn({ conversationId: first.conversationId, message: 'again', model: null });
      expect(back.model).toEqual({ provider: 'fake-default', model: 'default-model' });
      expect(db.getConversationModel(first.conversationId)).toBeNull();
      expect(back.messages.at(-1).payload.model).toEqual({ provider: 'fake-default', model: 'default-model' });
    });
  });
});
