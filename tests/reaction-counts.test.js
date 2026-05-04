import { describe, test, expect } from '@jest/globals';
import {
  aggregateReactionCountsFromProtoList,
  reactionParticipantSlotKey,
} from '../src/whatsapp/reaction-counts.js';

describe('aggregateReactionCountsFromProtoList', () => {
  test('aggregates non-empty reaction texts', () => {
    expect(
      aggregateReactionCountsFromProtoList([
        { text: '👍' },
        { text: '👍' },
        { text: '❤️' },
      ]),
    ).toEqual({ '👍': 2, '❤️': 1 });
  });

  test('returns null for empty or missing', () => {
    expect(aggregateReactionCountsFromProtoList(null)).toBeNull();
    expect(aggregateReactionCountsFromProtoList([])).toBeNull();
    expect(aggregateReactionCountsFromProtoList([{ text: '' }, { text: '  ' }])).toBeNull();
  });
});

describe('reactionParticipantSlotKey', () => {
  test('prefers groupingKey', () => {
    expect(reactionParticipantSlotKey('abc', { participant: 'x@g.us' })).toBe('g:abc');
  });

  test('falls back to participant then dm', () => {
    expect(reactionParticipantSlotKey('', { participant: '99@g.us' })).toBe('p:99@g.us');
    expect(reactionParticipantSlotKey(undefined, { fromMe: true })).toBe('dm:1');
    expect(reactionParticipantSlotKey(undefined, { fromMe: false })).toBe('dm:0');
  });
});
