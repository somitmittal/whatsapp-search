const TOKEN = '[a-z0-9]+(?:-[a-z0-9]+)*';
const INVOCATION = new RegExp(`^\\/(${TOKEN})(?:\\/(${TOKEN}))?(?:\\s+([\\s\\S]*))?$`, 'i');

/**
 * A skill command is a message that starts with /slug or /namespace/slug.
 * Returns null when the message is ordinary chat, including a slash later in the text.
 * @returns {{ namespace: string|null, slug: string, rest: string } | null}
 */
export function parseSkillInvocation(text) {
  const match = String(text || '').trim().match(INVOCATION);
  if (!match) return null;
  const rest = String(match[3] || '').trim();
  if (match[2]) {
    return { namespace: match[1].toLowerCase(), slug: match[2].toLowerCase(), rest };
  }
  return { namespace: null, slug: match[1].toLowerCase(), rest };
}

export function skillCommand(skill) {
  return `/${skill.namespace}/${skill.slug}`;
}

/** A whole message that means "run the last skill again", with no extra instructions. */
const RETRY = /^(?:(?:please|pls|plz)\s+)?(?:try(?:\s+it)?\s+again|retry|run(?:\s+it)?\s+again|do\s+it\s+again)[.!]?$/i;

export function isRetryPhrase(text) {
  return RETRY.test(String(text || '').trim());
}
