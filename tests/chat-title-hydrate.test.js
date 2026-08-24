import { describe, expect, test } from '@jest/globals';
import { groupSubjectUpdates } from '../src/whatsapp/group-subjects.js';
import { sidebarTabForJid } from '../src/whatsapp/jid-filters.js';

/**
 * Mirrors the preview rows WaClient.hydrateGroupTitlesForUi() emits at connect. The
 * method itself cannot be imported here because wa-client.js pulls in Baileys via
 * require(), so the shape and filtering are asserted through the same helpers it uses.
 */
function titlePreviewRows(allGroups) {
  return groupSubjectUpdates(allGroups).map(({ jid, subject }) => ({
    chatJid: jid,
    chatName: subject,
    sidebarTab: sidebarTabForJid(jid),
    messageCount: 0,
    lastMessageTs: 0,
    summarizedCount: 0,
    participantCount: 2,
  }));
}

const GROUP = '120363202440432920@g.us';
const OTHER = '120363417968323534@g.us';

describe('titles-first group hydration', () => {
  test('emits a named sidebar row for every joined group before any message arrives', () => {
    const rows = titlePreviewRows({
      [GROUP]: { id: GROUP, subject: "Sovrenn Family AA Dec' 23" },
      [OTHER]: { id: OTHER, subject: 'KWR - Moved-In Families' },
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.chatName)).toEqual([
      "Sovrenn Family AA Dec' 23",
      'KWR - Moved-In Families',
    ]);
    // Groups must land in the WhatsApp tab, not feeds, or the roster renders in the wrong list.
    expect(rows.every((r) => r.sidebarTab === 'chat')).toBe(true);
    expect(rows.every((r) => r.messageCount === 0)).toBe(true);
  });

  test('omits groups with no usable subject rather than showing a numeric row', () => {
    expect(titlePreviewRows({
      [GROUP]: { id: GROUP, subject: '120363202440432920' },
      [OTHER]: { id: OTHER },
    })).toEqual([]);
  });
});

describe('merging a titles-only preview into existing sidebar rows', () => {
  // Mirrors mergeSyncChatsPreview in public/index.html, which cannot be imported
  // because it touches the DOM.
  const mergeRow = (existing, p) => {
    const merged = { ...existing, ...p };
    if ((existing.messageCount || 0) > (p.messageCount || 0)) {
      merged.messageCount = existing.messageCount;
      merged.lastMessageTs = existing.lastMessageTs || p.lastMessageTs;
    }
    if ((existing.summarizedCount || 0) > (p.summarizedCount || 0)) {
      merged.summarizedCount = existing.summarizedCount;
    }
    return merged;
  };

  test('applies the title without discarding counts the preview never looked up', () => {
    const existing = {
      chatJid: GROUP,
      chatName: '120363202440432920',
      messageCount: 412,
      lastMessageTs: 1756000000,
      summarizedCount: 37,
    };
    const [preview] = titlePreviewRows({ [GROUP]: { id: GROUP, subject: 'Sovrenn Family' } });

    expect(mergeRow(existing, preview)).toMatchObject({
      chatName: 'Sovrenn Family',
      messageCount: 412,
      lastMessageTs: 1756000000,
      summarizedCount: 37,
    });
  });
});
