import { describe, expect, test } from '@jest/globals';
import { displayChatTitle, isResolvedChatName } from '../public/js/format.js';

describe('isResolvedChatName', () => {
  const pn = '919876543210@s.whatsapp.net';
  const group = '120363202440432920@g.us';

  test('treats a real contact or group name as resolved', () => {
    expect(isResolvedChatName(pn, 'Mahesh Mittal')).toBe(true);
    expect(isResolvedChatName(group, "Sovrenn Family AA Dec' 23")).toBe(true);
  });

  test('treats names that only restate the JID or number as unresolved', () => {
    expect(isResolvedChatName(pn, '')).toBe(false);
    expect(isResolvedChatName(pn, pn)).toBe(false);
    expect(isResolvedChatName(pn, '919876543210')).toBe(false);
    expect(isResolvedChatName(pn, '+91 9876543210')).toBe(false);
    expect(isResolvedChatName(pn, 'Contact (1212)')).toBe(false);
    // A group whose "name" is just its opaque id carries nothing the JID did not.
    expect(isResolvedChatName(group, '120363202440432920')).toBe(false);
    expect(isResolvedChatName(group, group)).toBe(false);
  });
});

describe('sidebar title stability across sync previews', () => {
  // Mirrors the precedence rule in mergeSyncChatsPreview, which cannot be imported
  // because it touches the DOM. A preview must never downgrade a resolved title.
  const nameAfterPreview = (chatJid, existingName, previewName) => (
    !isResolvedChatName(chatJid, previewName) && isResolvedChatName(chatJid, existingName)
      ? existingName
      : previewName
  );

  const pn = '919876543210@s.whatsapp.net';
  const group = '120363202440432920@g.us';

  test('keeps the resolved name when an unresolved preview arrives', () => {
    expect(nameAfterPreview(pn, 'Mahesh Mittal', pn)).toBe('Mahesh Mittal');
    expect(nameAfterPreview(pn, 'Mahesh Mittal', '')).toBe('Mahesh Mittal');
    expect(nameAfterPreview(group, 'Sovrenn Family', '120363202440432920')).toBe('Sovrenn Family');
  });

  test('accepts a preview that resolves a previously unresolved name', () => {
    expect(nameAfterPreview(pn, pn, 'Mahesh Mittal')).toBe('Mahesh Mittal');
    expect(nameAfterPreview(group, '120363202440432920', 'Sovrenn Family')).toBe('Sovrenn Family');
  });

  test('repeated unresolved previews cannot make the title oscillate', () => {
    let name = 'Mahesh Mittal';
    for (const preview of [pn, '919876543210', '', 'Contact (12)', pn]) {
      name = nameAfterPreview(pn, name, preview);
    }
    expect(name).toBe('Mahesh Mittal');
    expect(displayChatTitle(pn, name)).toBe('Mahesh Mittal');
  });

  test('an unresolved chat still falls back to the formatted number, not the raw JID', () => {
    expect(displayChatTitle(pn, nameAfterPreview(pn, pn, pn))).toBe('+91 9876543210');
  });
});

describe('imported chat title stability', () => {
  const importJid = 'import_whatsapp_chat_-_sovrenn_family_aa_dec_23@imported';

  test('strips export boilerplate and never falls back to the synthetic slug', () => {
    expect(displayChatTitle(importJid, "WhatsApp Chat - Sovrenn Family AA Dec' 23"))
      .toBe("Sovrenn Family AA Dec' 23");
    expect(displayChatTitle(importJid, '')).toBe('Imported chat');
    expect(displayChatTitle(importJid, 'import')).toBe('import');
  });

  test('a resolved export title is not downgraded by an unresolved preview', () => {
    const existing = "Sovrenn Family AA Dec' 23";
    const keep = isResolvedChatName(importJid, existing) && !isResolvedChatName(importJid, 'import')
      ? existing
      : 'import';
    expect(keep).toBe(existing);
    expect(displayChatTitle(importJid, keep)).toBe(existing);
  });
});
