import { SYSTEM_SKILLS } from './system-skills.js';

export function skillKey(skill) {
  return `${String(skill?.namespace || '').toLowerCase()}/${String(skill?.slug || '').toLowerCase()}`;
}

/** User skill with the same namespace and slug replaces the system skill. */
export function mergeSkills(systemSkills = [], userSkills = []) {
  const merged = new Map();
  for (const skill of systemSkills) merged.set(skillKey(skill), skill);
  for (const skill of userSkills) merged.set(skillKey(skill), skill);
  return [...merged.values()];
}

export function skillFromUserRow(row) {
  if (!row) return null;
  const frontmatter = row.frontmatter && typeof row.frontmatter === 'object' ? row.frontmatter : {};
  return {
    namespace: String(row.namespace || '').toLowerCase(),
    slug: String(row.slug || '').toLowerCase(),
    name: frontmatter.name || row.slug,
    description: frontmatter.description || '',
    kind: 'user',
    version: Number(row.version) || 1,
    needsCompleteness: !!frontmatter.needsCompleteness,
    inputs: frontmatter.inputs || {},
    body: row.body || '',
  };
}

/**
 * @param {string} query text after the slash, e.g. "accountant/exp"
 * @param {object[]} skills
 * @param {number} [limit]
 */
export function matchSkills(query, skills, limit = 12) {
  const q = String(query || '').trim().toLowerCase().replace(/^\//, '');
  const ranked = !q
    ? skills
    : skills.filter((skill) => {
      const path = skillKey(skill);
      return path.includes(q)
        || skill.slug.includes(q)
        || String(skill.name || '').toLowerCase().includes(q)
        || String(skill.description || '').toLowerCase().includes(q);
    });
  return ranked.slice(0, limit);
}

export function resolveSkill(invocation, skills) {
  if (!invocation?.slug) return null;
  if (invocation.namespace) {
    return skills.find((skill) => skill.namespace === invocation.namespace && skill.slug === invocation.slug) || null;
  }
  const hits = skills.filter((skill) => skill.slug === invocation.slug);
  return hits.length === 1 ? hits[0] : null;
}

export function ambiguousSlug(invocation, skills) {
  if (!invocation?.slug || invocation.namespace) return [];
  return skills.filter((skill) => skill.slug === invocation.slug);
}

export function skillsInNamespace(namespace, skills) {
  const ns = String(namespace || '').toLowerCase();
  return skills.filter((skill) => skill.namespace === ns);
}

export function listVisibleSkills(db) {
  const userRows = typeof db?.listUserSkills === 'function' ? db.listUserSkills() : [];
  return mergeSkills(SYSTEM_SKILLS, userRows.map(skillFromUserRow).filter(Boolean));
}
