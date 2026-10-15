import { describe, expect, test } from '@jest/globals';
import { GROUP_SUBJECT_MAX_LEN, normalizeGroupCreateInput } from '../src/whatsapp/group-create.js';

describe('normalizeGroupCreateInput', () => {
  test('requires a subject and at least one personal contact', () => {
    expect(normalizeGroupCreateInput({ subject: '  ', participantJids: ['a@s.whatsapp.net'] }).ok).toBe(false);
    expect(normalizeGroupCreateInput({ subject: 'Trip', participantJids: [] }).ok).toBe(false);
    expect(normalizeGroupCreateInput({
      subject: '  Weekend trip ',
      participantJids: ['9199@s.whatsapp.net', '9199@s.whatsapp.net', 'abc@lid'],
    })).toEqual({
      ok: true,
      subject: 'Weekend trip',
      participantJids: ['9199@s.whatsapp.net', 'abc@lid'],
    });
  });

  test('rejects groups, imports, and overlong names', () => {
    expect(normalizeGroupCreateInput({
      subject: 'X',
      participantJids: ['120363@g.us'],
    }).error).toMatch(/personal/i);
    expect(normalizeGroupCreateInput({
      subject: 'a'.repeat(GROUP_SUBJECT_MAX_LEN + 1),
      participantJids: ['9199@s.whatsapp.net'],
    }).error).toMatch(/characters/i);
  });
});
