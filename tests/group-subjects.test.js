import { describe, expect, test } from '@jest/globals';
import { groupSubjectUpdates } from '../src/whatsapp/group-subjects.js';

const GROUP_A = '120363202440432920@g.us';
const GROUP_B = '120363417968323534@g.us';

describe('groupSubjectUpdates', () => {
  test('returns the subject for each joined group', () => {
    expect(groupSubjectUpdates({
      [GROUP_A]: { id: GROUP_A, subject: "Sovrenn Family AA Dec' 23" },
      [GROUP_B]: { id: GROUP_B, subject: 'Weekend Football' },
    })).toEqual([
      { jid: GROUP_A, subject: "Sovrenn Family AA Dec' 23" },
      { jid: GROUP_B, subject: 'Weekend Football' },
    ]);
  });

  test('skips groups whose subject says no more than the JID already does', () => {
    expect(groupSubjectUpdates({
      // Numeric id as subject is what the sidebar already shows.
      [GROUP_A]: { id: GROUP_A, subject: '120363202440432920' },
      [GROUP_B]: { id: GROUP_B, subject: '   ' },
      'x@g.us': { id: 'x@g.us' },
    })).toEqual([]);
  });

  test('trims surrounding whitespace from a subject', () => {
    expect(groupSubjectUpdates({
      [GROUP_A]: { id: GROUP_A, subject: '  Sovrenn Family  ' },
    })).toEqual([{ jid: GROUP_A, subject: 'Sovrenn Family' }]);
  });

  test('falls back to the map key when metadata omits id', () => {
    expect(groupSubjectUpdates({
      [GROUP_A]: { subject: 'Sovrenn Family' },
    })).toEqual([{ jid: GROUP_A, subject: 'Sovrenn Family' }]);
  });

  test('emits each group once even if the key and id disagree', () => {
    expect(groupSubjectUpdates({
      [GROUP_A]: { id: GROUP_A, subject: 'Sovrenn Family' },
      'stale-alias': { id: GROUP_A, subject: 'Sovrenn Family' },
    })).toEqual([{ jid: GROUP_A, subject: 'Sovrenn Family' }]);
  });

  test('tolerates an empty or missing response', () => {
    expect(groupSubjectUpdates({})).toEqual([]);
    expect(groupSubjectUpdates(null)).toEqual([]);
    expect(groupSubjectUpdates(undefined)).toEqual([]);
  });
});
