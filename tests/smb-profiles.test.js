import { describe, expect, it } from '@jest/globals';
import {
  detectSmbLibraryMismatch,
  getSearchPrompts,
  listSmbProfileOptions,
  resolveSmbProfile,
  synthesisSystemAddon,
} from '../src/smb/profiles.js';

describe('smb profiles', () => {
  it('resolves known profiles and falls back to personal', () => {
    expect(resolveSmbProfile('clinic').id).toBe('clinic');
    expect(resolveSmbProfile('real_estate').isBusiness).toBe(true);
    expect(resolveSmbProfile('unknown').id).toBe('personal');
  });

  it('lists all profile options', () => {
    const opts = listSmbProfileOptions();
    expect(opts.length).toBe(4);
    expect(opts.map((o) => o.id)).toContain('d2c');
  });

  it('returns vertical search prompts only for business profiles', () => {
    expect(getSearchPrompts(resolveSmbProfile('personal'))).toEqual([]);
    const clinic = getSearchPrompts(resolveSmbProfile('clinic'));
    expect(clinic.length).toBeGreaterThan(2);
    expect(clinic[0]).toHaveProperty('label');
    expect(clinic[0]).toHaveProperty('query');
  });

  it('adds synthesis context for business profiles', () => {
    expect(synthesisSystemAddon(resolveSmbProfile('personal'))).toBe('');
    expect(synthesisSystemAddon(resolveSmbProfile('d2c'))).toMatch(/D2C/i);
  });

  it('flags business profile mismatch for imported group libraries', () => {
    const db = {
      getSetting: () => 'clinic',
      getChatStats: () => [
        { chatJid: 'import_college@imported', participantCount: 129, messageCount: 400 },
        { chatJid: 'import_alumni@imported', participantCount: 144, messageCount: 2800 },
      ],
    };
    expect(detectSmbLibraryMismatch(db).mismatch).toBe(true);
    const personalDb = { getSetting: () => 'personal', getChatStats: () => db.getChatStats() };
    expect(detectSmbLibraryMismatch(personalDb).mismatch).toBe(false);
  });
});
