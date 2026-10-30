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

describe('smb profiles (retired verticals)', () => {
  it('always resolves to personal', () => {
    expect(resolveSmbProfile('clinic').id).toBe('personal');
    expect(resolveSmbProfile('construction').id).toBe('personal');
    expect(resolveSmbProfile('unknown').id).toBe('personal');
  });

  it('lists only the personal stub', () => {
    const opts = listSmbProfileOptions();
    expect(opts).toEqual([
      expect.objectContaining({ id: 'personal', isBusiness: false }),
    ]);
  });

  it('has no vertical search prompts or synthesis addons', () => {
    expect(getSearchPrompts(resolveSmbProfile('personal'))).toEqual([]);
    expect(synthesisSystemAddon(resolveSmbProfile('personal'))).toBe('');
  });

  it('keeps the expense agent always enabled', () => {
    const db = (settings) => ({ getSetting: (key) => settings[key] || '' });
    expect(isConstructionExpenseAgentEnabled(db({}))).toBe(true);
    expect(isConstructionExpenseAgentEnabled(db({ smb_profile: 'personal' }))).toBe(true);
    expect(isConstructionExpenseAgentEnabled(null)).toBe(true);
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

  it('never flags a library mismatch after profiles were removed', () => {
    const db = {
      getSetting: () => 'clinic',
      getChatStats: () => [
        { chatJid: 'import_college@imported', participantCount: 129, messageCount: 400 },
      ],
    };
    expect(detectSmbLibraryMismatch(db).mismatch).toBe(false);
  });
});
