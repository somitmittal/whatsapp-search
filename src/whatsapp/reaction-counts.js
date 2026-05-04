/**
 * Reaction helpers: aggregate counts from sync/history protos and stable participant slots for live updates.
 */

/**
 * Count emoji occurrences from WebMessageInfo.reactions (history / sync).
 * @param {Array<{ text?: string|null }>|null|undefined} reactions
 * @returns {Record<string, number>|null}
 */
export function aggregateReactionCountsFromProtoList(reactions) {
  if (!Array.isArray(reactions) || reactions.length === 0) return null;
  const counts = {};
  for (const r of reactions) {
    const t = r?.text != null ? String(r.text).trim() : '';
    if (!t) continue;
    counts[t] = (Number(counts[t]) || 0) + 1;
  }
  return Object.keys(counts).length ? counts : null;
}

/**
 * Stable key per reactor so adds / changes / removals update the same logical slot.
 * Prefer WhatsApp groupingKey; else group participant; else 1:1 fromMe flag.
 * @param {string|number|Long|null|undefined} groupingKey
 * @param {{ participant?: string|null, fromMe?: boolean|null }|null|undefined} reactionMessageKey — key of the reaction message (reactor perspective)
 * @returns {string}
 */
export function reactionParticipantSlotKey(groupingKey, reactionMessageKey) {
  const gk = groupingKey != null ? String(groupingKey).trim() : '';
  if (gk) return `g:${gk}`;
  const rk = reactionMessageKey || {};
  if (rk.participant) return `p:${rk.participant}`;
  return `dm:${rk.fromMe ? '1' : '0'}`;
}
