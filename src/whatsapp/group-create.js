/**
 * Normalize a Create Group request before calling Baileys.
 * WhatsApp needs a non-empty subject and at least one other participant.
 */

/** WhatsApp's documented group subject length limit. */
export const GROUP_SUBJECT_MAX_LEN = 100;

/**
 * @param {{ subject?: unknown, participantJids?: unknown }} input
 * @returns {{ ok: true, subject: string, participantJids: string[] } | { ok: false, error: string }}
 */
export function normalizeGroupCreateInput(input = {}) {
  const subject = String(input.subject ?? '').trim().replace(/\s+/g, ' ');
  if (!subject) return { ok: false, error: 'Enter a group name' };
  if (subject.length > GROUP_SUBJECT_MAX_LEN) {
    return { ok: false, error: `Group name must be ${GROUP_SUBJECT_MAX_LEN} characters or fewer` };
  }

  const raw = Array.isArray(input.participantJids) ? input.participantJids : [];
  const seen = new Set();
  const participantJids = [];
  for (const item of raw) {
    const jid = String(item || '').trim();
    if (!jid || seen.has(jid)) continue;
    if (jid.endsWith('@g.us') || jid.endsWith('@imported') || jid.endsWith('@broadcast')
      || jid.endsWith('@newsletter') || jid.endsWith('@bot')) {
      return { ok: false, error: 'Groups can only include personal WhatsApp contacts' };
    }
    if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@hosted')
      || jid.endsWith('@hosted.lid'))) {
      return { ok: false, error: 'Pick contacts that are on WhatsApp' };
    }
    seen.add(jid);
    participantJids.push(jid);
  }
  if (!participantJids.length) {
    return { ok: false, error: 'Add at least one contact to the group' };
  }
  return { ok: true, subject, participantJids };
}
