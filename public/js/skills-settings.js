/**
 * Skills manager for Settings → Skills (add / edit / delete slash skills).
 */
import { $, esc, escAttr } from './util.js';

const state = {
  skills: [],
  skillFilter: '',
  selectedSkillPath: null,
  skillDraftNew: false,
};

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (window.SearchableAccount) Object.assign(h, window.SearchableAccount.authHeaders());
  return h;
}

function setSkillStatus(msg) {
  const el = $('#gpt-skill-status');
  if (el) el.textContent = msg || '';
}

function updateSkillPathPreview() {
  const ns = ($('#gpt-skill-namespace')?.value || 'namespace').trim().toLowerCase() || 'namespace';
  const slug = ($('#gpt-skill-slug')?.value || 'slug').trim().toLowerCase() || 'slug';
  const el = $('#gpt-skill-path-preview');
  if (el) el.textContent = `/${ns}/${slug}`;
}

function renderSkillsList() {
  const list = $('#gpt-skills-list');
  if (!list) return;
  const q = state.skillFilter.trim().toLowerCase();
  const rows = state.skills.filter((s) => {
    if (!q) return true;
    return s.path.includes(q)
      || String(s.name || '').toLowerCase().includes(q)
      || String(s.description || '').toLowerCase().includes(q);
  });
  list.innerHTML = rows.length
    ? rows.map((s) => {
      const on = !state.skillDraftNew && s.path === state.selectedSkillPath ? ' on' : '';
      const tag = s.hasOverride ? 'customized' : (s.isBuiltin ? 'builtin' : 'custom');
      return `<button type="button" class="gpt-skill-item${on}" role="option" data-skill-path="${escAttr(s.path)}">
        <span class="nm">${esc(s.name || s.slug)}</span>
        <span class="sub">/${esc(s.path)} · ${esc(tag)}</span>
      </button>`;
    }).join('')
    : '<p class="muted skill-empty-hint">No skills match.</p>';
}

function fillSkillEditor(skill, { isNew = false } = {}) {
  const editor = $('#gpt-skill-editor');
  const empty = $('#gpt-skill-empty');
  if (!editor || !empty) return;
  if (!skill && !isNew) {
    editor.hidden = true;
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  editor.hidden = false;
  const ns = skill?.namespace || 'custom';
  const slug = skill?.slug || '';
  $('#gpt-skill-editor-title').textContent = isNew ? 'New skill' : (skill.name || skill.slug);
  const badge = $('#gpt-skill-badge');
  if (isNew) {
    badge.hidden = false;
    badge.textContent = 'new';
  } else if (skill.hasOverride) {
    badge.hidden = false;
    badge.textContent = skill.isBuiltin ? 'customized builtin' : 'custom';
  } else if (skill.isBuiltin) {
    badge.hidden = false;
    badge.textContent = 'builtin';
  } else {
    badge.hidden = true;
  }
  $('#gpt-skill-name').value = skill?.name || '';
  $('#gpt-skill-namespace').value = ns;
  $('#gpt-skill-slug').value = slug;
  $('#gpt-skill-namespace').readOnly = !isNew && !!skill?.isBuiltin;
  $('#gpt-skill-slug').readOnly = !isNew && !!skill?.isBuiltin;
  $('#gpt-skill-description').value = skill?.description || '';
  $('#gpt-skill-body').value = skill?.body || '';
  updateSkillPathPreview();
  const del = $('#gpt-skill-delete');
  del.hidden = isNew || !skill?.canDelete;
  del.textContent = skill?.isBuiltin ? 'Revert to builtin' : 'Delete';
  setSkillStatus('');
}

function selectSkill(path) {
  state.skillDraftNew = false;
  state.selectedSkillPath = path;
  const skill = state.skills.find((s) => s.path === path) || null;
  fillSkillEditor(skill);
  renderSkillsList();
}

function startNewSkill() {
  state.skillDraftNew = true;
  state.selectedSkillPath = null;
  fillSkillEditor({
    namespace: 'custom',
    slug: '',
    name: '',
    description: '',
    body: '',
    isBuiltin: false,
    canDelete: false,
  }, { isNew: true });
  renderSkillsList();
  $('#gpt-skill-name')?.focus();
}

export async function loadManagedSkills() {
  if (!$('#gpt-skills-list')) return;
  try {
    const res = await fetch('/api/skills/managed', { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load skills');
    state.skills = data.items || [];
  } catch (err) {
    state.skills = [];
    setSkillStatus(err.message || 'Failed to load skills');
  }
  renderSkillsList();
  if (state.skillDraftNew) {
    fillSkillEditor(null, { isNew: true });
    return;
  }
  const selected = state.skills.find((s) => s.path === state.selectedSkillPath) || state.skills[0] || null;
  if (selected) selectSkill(selected.path);
  else {
    state.selectedSkillPath = null;
    fillSkillEditor(null);
  }
}

async function saveSkillEditor(e) {
  e?.preventDefault?.();
  const payload = {
    name: $('#gpt-skill-name').value.trim(),
    namespace: $('#gpt-skill-namespace').value.trim().toLowerCase(),
    slug: $('#gpt-skill-slug').value.trim().toLowerCase(),
    description: $('#gpt-skill-description').value.trim(),
    body: $('#gpt-skill-body').value,
  };
  if (!payload.name || !payload.namespace || !payload.slug) {
    setSkillStatus('Name, namespace, and slug are required.');
    return;
  }
  const saveBtn = $('#gpt-skill-save');
  if (saveBtn) saveBtn.disabled = true;
  setSkillStatus('Saving…');
  try {
    const res = await fetch('/api/skills', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    state.skillDraftNew = false;
    state.selectedSkillPath = data.skill?.path || `${payload.namespace}/${payload.slug}`;
    await loadManagedSkills();
    setSkillStatus('Saved.');
  } catch (err) {
    setSkillStatus(err.message || 'Save failed');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function deleteSelectedSkill() {
  const skill = state.skills.find((s) => s.path === state.selectedSkillPath);
  if (!skill?.canDelete) return;
  const label = skill.isBuiltin ? 'Revert this skill to the builtin version?' : `Delete /${skill.path}?`;
  if (!window.confirm(label)) return;
  setSkillStatus(skill.isBuiltin ? 'Reverting…' : 'Deleting…');
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skill.namespace)}/${encodeURIComponent(skill.slug)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    state.selectedSkillPath = skill.isBuiltin ? skill.path : null;
    await loadManagedSkills();
    setSkillStatus(skill.isBuiltin ? 'Reverted to builtin.' : 'Deleted.');
  } catch (err) {
    setSkillStatus(err.message || 'Delete failed');
  }
}

export function initSkillsSettings() {
  if (!$('#gpt-skills-list')) return;
  $('#gpt-skills-filter')?.addEventListener('input', (e) => {
    state.skillFilter = e.target.value || '';
    renderSkillsList();
  });
  $('#gpt-skills-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-skill-path]');
    if (item) selectSkill(item.dataset.skillPath);
  });
  $('#gpt-skill-new')?.addEventListener('click', startNewSkill);
  $('#gpt-skill-editor')?.addEventListener('submit', (e) => { void saveSkillEditor(e); });
  $('#gpt-skill-delete')?.addEventListener('click', () => { void deleteSelectedSkill(); });
  $('#gpt-skill-namespace')?.addEventListener('input', updateSkillPathPreview);
  $('#gpt-skill-slug')?.addEventListener('input', updateSkillPathPreview);
}
