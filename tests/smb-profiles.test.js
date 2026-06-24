import { describe, expect, it } from '@jest/globals';
import {
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
});
