import { describe, it, expect } from '@jest/globals';
import {
  NO_GROUNDED_ANSWER,
  UNGROUNDED_NOTICE,
  buildGroundingIndex,
  dropUnsupportedQuotes,
  enforceGroundedAnswer,
  entityWords,
  filterGroundedFacts,
  groundAnswer,
  isPhraseGrounded,
  isTokenGrounded,
} from '../src/search/grounding.js';

const STOCK_TRANSCRIPT = [
  '[1] Sandeep (Aug 12, 9:04 AM): Cpplus looking strong today',
  '[2] Rakesh (Aug 12, 9:11 AM): Gvpil and Kernex both breaking out',
  '[3] Sandeep (Aug 12, 9:40 AM): BSE chart is clean, jewellery stocks showing strength',
].join('\n');

describe('buildGroundingIndex', () => {
  it('matches tokens case- and punctuation-insensitively', () => {
    const index = buildGroundingIndex(STOCK_TRANSCRIPT);
    expect(isTokenGrounded('cpplus', index)).toBe(true);
    expect(isTokenGrounded('Kernex', index)).toBe(true);
    expect(isTokenGrounded('Bollywood', index)).toBe(false);
  });

  it('treats plurals and numbers as grounded', () => {
    const index = buildGroundingIndex('Rahul shared the report');
    expect(isTokenGrounded('reports', index)).toBe(true);
    expect(isTokenGrounded('42', index)).toBe(true);
  });

  it('checks phrases as contiguous text', () => {
    const index = buildGroundingIndex(STOCK_TRANSCRIPT);
    expect(isPhraseGrounded('jewellery stocks showing strength', index)).toBe(true);
    expect(isPhraseGrounded('Bollywood Stock Exchange', index)).toBe(false);
  });
});

describe('entityWords', () => {
  it('ignores words capitalised only because they start a sentence', () => {
    expect(entityWords('Stocks were discussed by Sandeep today.')).toEqual(['Sandeep']);
  });

  it('keeps the first word when the text is a list item, not a sentence', () => {
    expect(entityWords('Kernex', { skipSentenceStart: false })).toEqual(['Kernex']);
  });

  it('always treats all-caps tokens as entities', () => {
    expect(entityWords('BSE was mentioned')).toEqual(['BSE']);
  });
});

describe('enforceGroundedAnswer', () => {
  it('strips an invented acronym expansion but keeps the acronym', () => {
    const answer = '3. BSE (Bollywood Stock Exchange)';
    const { text, removed } = enforceGroundedAnswer(answer, STOCK_TRANSCRIPT);
    expect(text).toBe('3. BSE');
    expect(removed).toContain('Bollywood Stock Exchange');
  });

  it('drops list items naming a stock that is not in the chat', () => {
    const answer = [
      '1. Cpplus',
      '2. Gvpil',
      '3. Reliance Power',
    ].join('\n');
    const { text } = enforceGroundedAnswer(answer, STOCK_TRANSCRIPT);
    expect(text).toBe('1. Cpplus\n2. Gvpil');
  });

  it('keeps list items whose terms all appear in the chat', () => {
    const answer = '- Jewellery stocks showing strength';
    const { text, removed } = enforceGroundedAnswer(answer, STOCK_TRANSCRIPT);
    expect(text).toBe('- Jewellery stocks showing strength');
    expect(removed).toEqual([]);
  });

  it('drops prose sentences that introduce an unknown entity', () => {
    const answer = 'Sandeep discussed Cpplus. Rakesh compared it to Adani Ports.';
    const { text } = enforceGroundedAnswer(answer, STOCK_TRANSCRIPT);
    expect(text).toBe('Sandeep discussed Cpplus.');
  });

  it('leaves markdown headings intact', () => {
    const answer = '**Summary**\nSandeep discussed Cpplus.';
    const { text } = enforceGroundedAnswer(answer, STOCK_TRANSCRIPT);
    expect(text).toBe('**Summary**\nSandeep discussed Cpplus.');
  });
});

describe('dropUnsupportedQuotes', () => {
  const messageTexts = ['Cpplus looking strong today', 'Gvpil and Kernex both breaking out'];

  it('keeps a bullet whose quote is verbatim in the cited message', () => {
    const answer = '- [1] Sandeep: "Cpplus looking strong today" — bullish call';
    expect(dropUnsupportedQuotes(answer, messageTexts).text).toBe(answer);
  });

  it('drops a bullet whose quote is not in the cited message', () => {
    const answer = '- [1] Sandeep: "target price is 450" — invented';
    const { text, removed } = dropUnsupportedQuotes(answer, messageTexts);
    expect(text).toBe('');
    expect(removed).toContain('target price is 450');
  });

  it('drops a bullet citing a message number that does not exist', () => {
    const answer = '- [9] Ghost: "something entirely made up"';
    expect(dropUnsupportedQuotes(answer, messageTexts).text).toBe('');
  });
});

describe('groundAnswer', () => {
  const messageTexts = [
    'Cpplus looking strong today',
    'Gvpil and Kernex both breaking out',
    'BSE chart is clean, jewellery stocks showing strength',
  ];

  it('cleans the answer and warns that something was removed', () => {
    const answer = [
      '**Summary**',
      'Sandeep and Rakesh discussed Cpplus, Gvpil and BSE (Bollywood Stock Exchange).',
      '',
      '**Key Messages**',
      '- [1] Sandeep: "Cpplus looking strong today" — opening call',
    ].join('\n');

    const result = groundAnswer(answer, { transcript: STOCK_TRANSCRIPT, messageTexts });
    expect(result.text).toContain('Cpplus, Gvpil and BSE.');
    expect(result.text).not.toContain('Bollywood');
    expect(result.text).toContain('"Cpplus looking strong today"');
    expect(result.text).toContain(UNGROUNDED_NOTICE);
  });

  it('returns a refusal when nothing survives verification', () => {
    const answer = 'The Nifty Bank index rallied after Infosys results.';
    const result = groundAnswer(answer, { transcript: STOCK_TRANSCRIPT, messageTexts });
    expect(result.empty).toBe(true);
    expect(result.text).toBe(NO_GROUNDED_ANSWER);
  });

  it('passes a fully grounded answer through unchanged', () => {
    const answer = '**Summary**\nSandeep flagged Cpplus and Rakesh flagged Kernex.';
    const result = groundAnswer(answer, { transcript: STOCK_TRANSCRIPT, messageTexts });
    expect(result.text).toBe(answer);
    expect(result.removed).toEqual([]);
  });
});

describe('filterGroundedFacts', () => {
  const transcript = '[9:04 AM] Sandeep: booked 20 shares of Cpplus at 480';

  it('keeps a fact whose values are copied from the transcript', () => {
    const facts = [{
      type: 'recommendation',
      item: 'Cpplus',
      by: 'Sandeep',
      search_text: 'Sandeep Cpplus 480',
    }];
    expect(filterGroundedFacts(facts, transcript)).toEqual(facts);
  });

  it('drops a fact naming something absent from the transcript', () => {
    const facts = [{ type: 'recommendation', item: 'Tata Motors', by: 'Sandeep' }];
    expect(filterGroundedFacts(facts, transcript)).toEqual([]);
  });

  it('drops invented keywords from search_text instead of the whole fact', () => {
    const facts = [{
      type: 'recommendation',
      item: 'Cpplus',
      by: 'Sandeep',
      search_text: 'Sandeep Cpplus Bollywood Exchange',
    }];
    expect(filterGroundedFacts(facts, transcript)[0].search_text).toBe('Sandeep Cpplus');
  });

  it('drops a fact whose person list contains an invented name', () => {
    const facts = [{ type: 'plan', topic: 'trade', people: ['Sandeep', 'Ramesh'] }];
    expect(filterGroundedFacts(facts, transcript)).toEqual([]);
  });
});
