import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  EMOJI_CATEGORIES,
  EMOJI_CATALOG,
  searchEmojis,
  getRecentEmojis,
  recordRecentEmoji,
} from '../public/js/emoji-data.js';
import { insertEmojiAtCursor } from '../public/js/emoji-picker.js';

describe('WhatsApp Emoji Catalog & Search Engine (emoji-data.js)', () => {
  it('contains all 8 standard WhatsApp categories', () => {
    const expectedIds = ['smileys', 'people', 'nature', 'food', 'travel', 'activities', 'objects', 'symbols'];
    const ids = EMOJI_CATEGORIES.map((c) => c.id);
    for (const expected of expectedIds) {
      expect(ids).toContain(expected);
    }
  });

  it('contains unique and well-formed emoji definitions', () => {
    expect(EMOJI_CATALOG.length).toBeGreaterThan(150);
    const seen = new Set();
    for (const item of EMOJI_CATALOG) {
      expect(item.emoji).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(item.category).toBeTruthy();
      expect(Array.isArray(item.keywords)).toBe(true);
      expect(item.keywords.length).toBeGreaterThan(0);
      expect(seen.has(item.emoji)).toBe(false);
      seen.add(item.emoji);
    }
  });

  it('searches emojis by exact keyword', () => {
    // "laugh" should find laughing emojis
    const laughHits = searchEmojis('laugh');
    expect(laughHits.length).toBeGreaterThan(0);
    const laughEmojis = laughHits.map((h) => h.emoji);
    expect(laughEmojis).toContain('😂');

    // "heart" should find heart emojis
    const heartHits = searchEmojis('heart');
    expect(heartHits.length).toBeGreaterThan(0);
    const heartEmojis = heartHits.map((h) => h.emoji);
    expect(heartEmojis).toContain('❤️');

    // "fire" should find fire
    const fireHits = searchEmojis('fire');
    expect(fireHits.map((h) => h.emoji)).toContain('🔥');

    // "dog" should find dog
    const dogHits = searchEmojis('dog');
    expect(dogHits.map((h) => h.emoji)).toContain('🐶');
  });

  it('searches emojis by prefix keyword', () => {
    const prefixHits = searchEmojis('lau'); // prefix of "laugh"
    expect(prefixHits.map((h) => h.emoji)).toContain('😂');

    const smileHits = searchEmojis('smi'); // prefix of "smile"
    expect(smileHits.map((h) => h.emoji)).toContain('😀');
  });

  it('searches emojis by name substring', () => {
    const hits = searchEmojis('tears of joy');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].emoji).toBe('😂');
  });

  it('filters emojis by category', () => {
    const foodHits = searchEmojis('', { category: 'food' });
    expect(foodHits.length).toBeGreaterThan(20);
    for (const item of foodHits) {
      expect(item.category).toBe('food');
    }

    const pizzaInFood = searchEmojis('pizza', { category: 'food' });
    expect(pizzaInFood.map((i) => i.emoji)).toContain('🍕');

    const pizzaInNature = searchEmojis('pizza', { category: 'nature' });
    expect(pizzaInNature.length).toBe(0);
  });

  it('ranks exact keyword matches higher than substring matches', () => {
    const hits = searchEmojis('cat');
    expect(hits.length).toBeGreaterThan(0);
    // Cat face should be ranked first among cat matches
    expect(hits[0].emoji).toBe('🐱');
  });

  it('returns empty array when query does not match anything', () => {
    const hits = searchEmojis('xyznonexistentquery999');
    expect(hits).toEqual([]);
  });
});

describe('Recent Emojis Persistence', () => {
  let fakeStorage = {};

  beforeEach(() => {
    fakeStorage = {};
    global.localStorage = {
      getItem: (key) => fakeStorage[key] || null,
      setItem: (key, val) => { fakeStorage[key] = String(val); },
      removeItem: (key) => { delete fakeStorage[key]; },
      clear: () => { fakeStorage = {}; },
    };
  });

  it('returns empty array initially', () => {
    expect(getRecentEmojis()).toEqual([]);
  });

  it('records recently used emojis without duplicates', () => {
    recordRecentEmoji('👍');
    recordRecentEmoji('❤️');
    recordRecentEmoji('🔥');
    expect(getRecentEmojis()).toEqual(['🔥', '❤️', '👍']);

    // Re-recording '❤️' moves it to front
    recordRecentEmoji('❤️');
    expect(getRecentEmojis()).toEqual(['❤️', '🔥', '👍']);
  });
});

describe('insertEmojiAtCursor (emoji-picker.js)', () => {
  it('inserts emoji into an input at cursor position and fires input event', () => {
    let eventFired = false;
    const fakeInput = {
      value: 'Hello world',
      selectionStart: 5,
      selectionEnd: 5,
      focus: () => {},
      dispatchEvent: (event) => {
        if (event.type === 'input') eventFired = true;
      },
    };

    insertEmojiAtCursor(fakeInput, ' 😊');
    expect(fakeInput.value).toBe('Hello 😊 world');
    expect(fakeInput.selectionStart).toBe(8);
    expect(fakeInput.selectionEnd).toBe(8);
    expect(eventFired).toBe(true);
  });

  it('appends emoji at end if selection is at end', () => {
    const fakeInput = {
      value: 'Great job',
      selectionStart: 9,
      selectionEnd: 9,
      focus: () => {},
      dispatchEvent: () => {},
    };

    insertEmojiAtCursor(fakeInput, ' 👏');
    expect(fakeInput.value).toBe('Great job 👏');
    expect(fakeInput.selectionStart).toBe(12);
  });
});
