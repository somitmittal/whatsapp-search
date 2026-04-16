import { describe, it, expect } from '@jest/globals';
import { parseFactsFromLlm, buildSearchText } from '../src/search/fact-extract.js';

describe('parseFactsFromLlm', () => {
  it('parses JSON array from noisy output', () => {
    const raw = 'Here you go:\n[{"type":"plan","topic":"Goa","search_text":"Goa trip"}]\n';
    const facts = parseFactsFromLlm(raw);
    expect(facts).toHaveLength(1);
    expect(facts[0].type).toBe('plan');
    expect(facts[0].topic).toBe('Goa');
  });

  it('returns empty on invalid JSON', () => {
    expect(parseFactsFromLlm('not json')).toEqual([]);
  });
});

describe('buildSearchText', () => {
  it('flattens nested fields', () => {
    const t = buildSearchText({ type: 'conflict', people: ['A', 'B'], topic: 'money' });
    expect(t).toContain('A');
    expect(t).toContain('money');
  });
});
