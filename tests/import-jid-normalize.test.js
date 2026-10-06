import { describe, expect, test } from '@jest/globals';
import {
  isImportedChatJid,
  shouldPreserveRawChatJid,
} from '../src/whatsapp/jid-filters.js';
import {
  fallbackTitleForOneOnOneJid,
  prettyImportedChatTitle,
} from '../src/whatsapp/chat-display-name.js';

/**
 * Mirrors Baileys' jidNormalizedUser local-part rule: strip after the first `_` or `:`.
 * Documented here so we do not pull the full Baileys ESM package into Jest.
 */
function baileysLikeNormalize(jid) {
  const [user, server] = String(jid || '').split('@');
  if (!server) return jid;
  const bare = user.split(/[_:]/)[0];
  return `${bare}@${server}`;
}

describe('import JID safety around Baileys normalize', () => {
  const sovrenn = 'import_whatsapp_chat_-_sovrenn_family_aa_dec_23@imported';
  const iiitm = 'import_whatsapp_chat_-_iiitm_gwalior@imported';

  test('Baileys-like normalize collapses distinct import archives (the bug we guard against)', () => {
    expect(baileysLikeNormalize(sovrenn)).toBe('import@imported');
    expect(baileysLikeNormalize(iiitm)).toBe('import@imported');
    expect(baileysLikeNormalize(sovrenn)).toBe(baileysLikeNormalize(iiitm));
  });

  test('shouldPreserveRawChatJid keeps import archives verbatim', () => {
    expect(isImportedChatJid(sovrenn)).toBe(true);
    expect(shouldPreserveRawChatJid(sovrenn)).toBe(true);
    expect(shouldPreserveRawChatJid(iiitm)).toBe(true);
    expect(shouldPreserveRawChatJid('status@broadcast')).toBe(true);
    expect(shouldPreserveRawChatJid('919876543210@s.whatsapp.net')).toBe(false);
    expect(shouldPreserveRawChatJid('120363202440432920@g.us')).toBe(false);
  });

  test('canonical merge must not collapse two imports when preserve is respected', () => {
    const resolveCanonical = (jid) => {
      if (!jid || shouldPreserveRawChatJid(jid) || String(jid).endsWith('@g.us')) return jid;
      return baileysLikeNormalize(jid) || jid;
    };
    const a = resolveCanonical(sovrenn);
    const b = resolveCanonical(iiitm);
    expect(a).toBe(sovrenn);
    expect(b).toBe(iiitm);
    expect(a).not.toBe(b);
  });
});

describe('prettyImportedChatTitle', () => {
  test('strips WhatsApp export boilerplate', () => {
    expect(prettyImportedChatTitle("WhatsApp Chat - Sovrenn Family AA Dec' 23"))
      .toBe("Sovrenn Family AA Dec' 23");
    expect(prettyImportedChatTitle('WhatsApp Chat with Alice')).toBe('Alice');
    expect(prettyImportedChatTitle('Family Group')).toBe('Family Group');
  });

  test('fallback title for import JIDs is empty (never invent "import")', () => {
    expect(fallbackTitleForOneOnOneJid('import_family@imported')).toBe('');
    expect(fallbackTitleForOneOnOneJid('import@imported')).toBe('');
  });
});
