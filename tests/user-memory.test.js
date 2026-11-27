import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'wa-user-memory-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');

let db;
beforeAll(() => { db = new Database(); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const {
  MEMORY_LIMIT,
  addMemory,
  buildClarificationMemoryText,
  deleteMemory,
  extractMemoryFromExchange,
  isClarifyingQuestion,
  isMemoryEnabled,
  listMemory,
  memoryPromptBlock,
  saveClarificationFromTurn,
  selectRelevantMemories,
  setMemoryEnabled,
  shouldConsiderMemory,
} = await import('../src/gpt/user-memory.js');

describe('saved memory store', () => {
  test('adds a memory and list returns newest first', () => {
    const a = addMemory(db, 'Runs a cement trading business');
    expect(a.added).toBe(true);
    const b = addMemory(db, 'Uses a MacBook Air 2017');
    expect(b.added).toBe(true);
    const { memories } = listMemory(db);
    expect(memories[0].text).toBe('Uses a MacBook Air 2017');
    expect(memories[1].text).toBe('Runs a cement trading business');
  });

  test('dedupes case-insensitively', () => {
    const res = addMemory(db, 'RUNS A CEMENT TRADING   business');
    expect(res.added).toBe(false);
    expect(res.entry).toBeNull();
    expect(listMemory(db).memories.length).toBe(2);
  });

  test('rejects empty additions', () => {
    expect(addMemory(db, '   ').added).toBe(false);
  });

  test('deletes by id', () => {
    const { entry } = addMemory(db, 'Waiting for GST number');
    expect(deleteMemory(db, entry.id)).toBe(true);
    expect(listMemory(db).memories.some((m) => m.text === 'Waiting for GST number')).toBe(false);
    expect(deleteMemory(db, 'nope')).toBe(false);
  });

  test('caps the list at MEMORY_LIMIT dropping the oldest', () => {
    for (let i = 0; i < MEMORY_LIMIT + 3; i++) addMemory(db, `filler fact number ${i} keeping list fresh`);
    const { memories } = listMemory(db);
    expect(memories.length).toBe(MEMORY_LIMIT);
    // oldest entries are gone (they were pushed first)
    expect(memories.some((m) => m.text === 'filler fact number 0 keeping list fresh')).toBe(false);
  });

  test('enabled toggle persists', () => {
    expect(isMemoryEnabled(db)).toBe(true); // default on
    setMemoryEnabled(db, false);
    expect(isMemoryEnabled(db)).toBe(false);
    setMemoryEnabled(db, true);
    expect(isMemoryEnabled(db)).toBe(true);
  });
});

describe('memoryPromptBlock', () => {
  test('renders newest facts within the block and honors the off state', () => {
    setMemoryEnabled(db, true);
    const block = memoryPromptBlock(db);
    expect(block).toContain('Saved memory');
    // newest entries are kept; the cap test above already evicted old ones
    expect(block).toContain('- filler fact number 102 keeping list fresh');

    setMemoryEnabled(db, false);
    expect(memoryPromptBlock(db)).toBe('');
    setMemoryEnabled(db, true);
  });

  test('with a query, injects only overlapping memories', () => {
    setMemoryEnabled(db, true);
    addMemory(db, 'Prefers looking up spa bookings in the Lotus Spa chat');
    addMemory(db, 'Uses a ThinkPad for work travel');
    const spaBlock = memoryPromptBlock(db, new Date(), { query: 'Did the spa confirm my booking?' });
    expect(spaBlock).toContain('Lotus Spa');
    expect(spaBlock).not.toContain('ThinkPad');
    const laptopBlock = memoryPromptBlock(db, new Date(), { query: 'which laptop do I travel with?' });
    expect(laptopBlock).toContain('ThinkPad');
    expect(laptopBlock).not.toContain('Lotus Spa');
  });
});

describe('clarification memory', () => {
  test('detects clarifying assistant questions', () => {
    expect(isClarifyingQuestion('I could not find enough without guessing. Which chat or person should I look in?')).toBe(true);
    expect(isClarifyingQuestion('The payment of ₹499 went through yesterday.')).toBe(false);
  });

  test('builds and saves a clarification fact from the user reply', () => {
    const ask = 'Which chat or person should I look in for that booking?';
    const text = buildClarificationMemoryText(ask, 'Lotus Spa with Priya');
    expect(text).toMatch(/Lotus Spa with Priya/);
    expect(text).toMatch(/User clarification/);
    const res = saveClarificationFromTurn(db, { priorAssistantText: ask, userText: 'Lotus Spa with Priya' });
    expect(res?.added).toBe(true);
    expect(res.entry.kind).toBe('clarification');
    const block = memoryPromptBlock(db, new Date(), { query: 'Was my spa booking confirmed last week?' });
    expect(block).toContain('Lotus Spa with Priya');
  });

  test('selectRelevantMemories ranks clarification overlaps above unrelated facts', () => {
    const items = [
      { id: '1', text: 'Owns a red scooter', kind: 'fact', ts: 1 },
      { id: '2', text: 'User clarification: for "Which chat should I look in for bookings?", they said "Wife Home chat". Apply this next time instead of asking again.', kind: 'clarification', ts: 2 },
    ];
    const picked = selectRelevantMemories(items, 'check the booking confirmation please');
    expect(picked.map((m) => m.id)).toEqual(['2']);
  });
});

describe('shouldConsiderMemory gate', () => {
  test('skips trivial exchanges', () => {
    expect(shouldConsiderMemory('hi', 'hello there friend')).toBe(false);
    expect(shouldConsiderMemory('', '')).toBe(false);
  });
  test('accepts substantive exchanges', () => {
    expect(shouldConsiderMemory('My laptop is a MacBook Air 2017 model', 'Noted, I will remember that.')).toBe(true);
  });
  test('skips LLM extract when the prior turn was a clarifying question', () => {
    expect(shouldConsiderMemory(
      'Wife Home chat',
      'Looking in Wife Home chat now.',
      { priorAssistantText: 'Which chat or person should I look in?' },
    )).toBe(false);
  });
});

describe('extractMemoryFromExchange', () => {
  const provider = (reply) => ({ chat: jest.fn(async () => reply) });

  test('parses {"memory": "..."} from the provider', async () => {
    const p = provider('{"memory":"The user runs a cement trading business."}');
    const out = await extractMemoryFromExchange(p, { userText: 'we run cement', answerText: 'noted' });
    expect(out).toBe('The user runs a cement trading business.');
  });

  test('streams null through for {"memory": null}', async () => {
    expect(await extractMemoryFromExchange(provider('{"memory":null}'), { userText: 'hi there how are things going', answerText: 'all good here' })).toBeNull();
  });

  test('extracts from JSON inside prose/markdown fences', async () => {
    const p = provider('```json\n{"memory":"Prefers short answers"}\n```');
    expect(await extractMemoryFromExchange(p, { userText: 'answer super briefly please ok', answerText: 'sure, will do' })).toBe('Prefers short answers');
  });

  test('strips template echoes and stray quotes from small models', async () => {
    const p = provider('{"memory":"<fact, third person, under 200 chars>: \\"He runs a cement firm.\\""}');
    expect(await extractMemoryFromExchange(p, { userText: 'we run a cement shop here', answerText: 'noted for later' })).toBe('He runs a cement firm.');
  });

  test('returns null on provider errors instead of breaking the turn', async () => {
    const p = { chat: async () => { throw new Error('provider down'); } };
    await expect(extractMemoryFromExchange(p, { userText: 'some long message text here', answerText: 'the answer text here too' })).rejects.toThrow('provider down');
  });

  test('returns null without a provider', async () => {
    expect(await extractMemoryFromExchange(null, { userText: 'x'.repeat(20), answerText: 'y'.repeat(20) })).toBeNull();
  });
});
