/**
 * Selecting storable group titles from WhatsApp group metadata (no Baileys dependency).
 *
 * Group subjects never appear in the phone book, so contact sync alone leaves groups
 * labelled with their numeric JID. `groupFetchAllParticipating()` returns every joined
 * group in one response, which this module filters down to titles worth persisting.
 */

import { isPlausibleHumanChatTitle } from './chat-display-name.js';

/**
 * Usable `{ jid, subject }` pairs from a `groupFetchAllParticipating()` response.
 *
 * Entries can be missing a subject, or carry the group's own numeric id as its subject.
 * Neither says more than the JID already does, so neither may overwrite a stored name.
 *
 * @param {Record<string, { id?: string, subject?: string }>} allGroups metadata keyed by group JID
 * @returns {Array<{ jid: string, subject: string }>}
 */
export function groupSubjectUpdates(allGroups) {
  const updates = [];
  const seen = new Set();
  for (const [key, meta] of Object.entries(allGroups || {})) {
    const jid = meta?.id || key;
    const subject = typeof meta?.subject === 'string' ? meta.subject.trim() : '';
    if (!jid || !subject || seen.has(jid)) continue;
    if (!isPlausibleHumanChatTitle(subject, jid)) continue;
    seen.add(jid);
    updates.push({ jid, subject });
  }
  return updates;
}
