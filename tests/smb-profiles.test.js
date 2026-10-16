import { describe, expect, it } from '@jest/globals';
import {
  detectSmbLibraryMismatch,
  getSearchPrompts,
  isConstructionExpenseAgentEnabled,
  isConstructionExpenseSiteAllowed,
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
    expect(opts.length).toBe(5);
    expect(opts.map((o) => o.id)).toContain('d2c');
    expect(opts.map((o) => o.id)).toContain('construction');
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

  it('provides construction expense grounding and prompts', () => {
    const construction = resolveSmbProfile('construction');
    expect(construction.factAddon).toMatch(/source_message_id/);
    expect(construction.searchPrompts.map((p) => p.label)).toContain('Today’s expenses');
    expect(synthesisSystemAddon(construction)).toMatch(/construction sites/i);
  });

  it('runs the expense agent only on Construction with the agent toggled on', () => {
    const db = (settings) => ({ getSetting: (key) => settings[key] || '' });
    expect(isConstructionExpenseAgentEnabled(db({ smb_profile: 'construction', construction_expense_agent: '1' }))).toBe(true);
    expect(isConstructionExpenseAgentEnabled(db({ smb_profile: 'construction' }))).toBe(false);
    expect(isConstructionExpenseAgentEnabled(db({ smb_profile: 'clinic', construction_expense_agent: '1' }))).toBe(false);
  });

  it('auto-runs only for selected site groups', () => {
    const db = {
      getSetting: (key) => ({
        construction_expense_site_jids: JSON.stringify(['site-a@g.us', 'not-a-group']),
      })[key] || '',
    };
    expect(isConstructionExpenseSiteAllowed(db, 'site-a@g.us')).toBe(true);
    expect(isConstructionExpenseSiteAllowed(db, 'site-b@g.us')).toBe(false);
    expect(isConstructionExpenseSiteAllowed(db, 'person@s.whatsapp.net')).toBe(false);
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
