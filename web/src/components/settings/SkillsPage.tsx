import { useState } from 'react';
import { createSkill, deleteSkill, patchSkill, type Skill } from '../../data/api';
import type { Lang } from '../../data/lang';
import { useExtensions } from '../../data/useExtensions';
import { t, type I18nKey } from '../../i18n';
import type { ConfirmOpts } from '../ConfirmDialog';

type Props = {
  lang: Lang;
  onToast: (message: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
};

type Form = { id: string; name: string; description: string; body: string };
type Drawer = { mode: 'add' } | { mode: 'edit'; id: string };

function failText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sourceKey(source: string): I18nKey {
  if (source === 'bundled' || source === 'builtin') return 'skill_source_builtin';
  return 'skill_source_user';
}

function initial(skill: Skill): string {
  const ch = (skill.name || skill.id || '?').trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

function emptyForm(): Form {
  return { id: '', name: '', description: '', body: '' };
}

export function SkillsPage({ lang, onToast, onConfirm }: Props) {
  const { skills, ready } = useExtensions();
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const editing = drawer?.mode === 'edit' ? skills.find((item) => item.id === drawer.id) : null;

  function openAdd() {
    setForm(emptyForm());
    setError('');
    setDrawer({ mode: 'add' });
  }

  function openEdit(skill: Skill) {
    setForm({ id: skill.id, name: skill.name, description: skill.description, body: '' });
    setError('');
    setDrawer({ mode: 'edit', id: skill.id });
  }

  async function save() {
    const name = form.name.trim();
    if (!name) {
      setError(t(lang, 'skill_name_required'));
      return;
    }
    if (drawer?.mode === 'add' && !form.body.trim()) {
      setError(t(lang, 'skill_body_required'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (drawer?.mode === 'edit') {
        const body: { name: string; description: string; body?: string } = {
          name,
          description: form.description.trim(),
        };
        if (form.body.trim()) body.body = form.body;
        await patchSkill(drawer.id, body, lang);
        onToast(t(lang, 'skill_saved'));
      } else {
        const payload: { name: string; description: string; body: string; id?: string } = {
          name,
          description: form.description.trim(),
          body: form.body,
        };
        if (form.id.trim()) payload.id = form.id.trim();
        const created = await createSkill(payload, lang);
        onToast(t(lang, 'skill_created', { name: created.name || name }));
      }
      setDrawer(null);
    } catch (err) {
      setError(failText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(skill: Skill) {
    try {
      await patchSkill(skill.id, { enabled: !skill.enabled }, lang);
    } catch (err) {
      onToast(failText(err));
    }
  }

  async function remove(skill: Skill) {
    const ok = await onConfirm({
      title: t(lang, 'confirm_delete_title'),
      message: t(lang, 'skill_confirm_delete', { name: skill.name }),
      confirmLabel: t(lang, 'skill_delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkill(skill.id);
      onToast(t(lang, 'skill_deleted'));
      if (drawer?.mode === 'edit' && drawer.id === skill.id) setDrawer(null);
    } catch (err) {
      onToast(failText(err));
    }
  }

  return (
    <div className="next-settings-content ns-git-page" data-testid="next-settings-skills">
      <div className="next-settings-head">
        <div>
          <h2>{t(lang, 'skill_title')}</h2>
          <p className="next-settings-sub">{t(lang, 'skill_subtitle')}</p>
        </div>
        <button type="button" className="ns-btn" data-testid="next-skill-add" onClick={openAdd}>
          {t(lang, 'skill_add')}
        </button>
      </div>
      <div className="ns-git-scroll">
        {!ready ? (
          <div className="ns-empty">{t(lang, 'loading')}</div>
        ) : skills.length === 0 ? (
          <div className="ns-empty">{t(lang, 'skill_none')}</div>
        ) : (
          <div className="ns-card-grid">
            {skills.map((skill) => (
              <div
                key={skill.id}
                className="ns-ext-card"
                data-testid="next-skill-row"
                data-id={skill.id}
              >
                <div className="ns-ext-card-top">
                  <span className="ns-ext-mark">{initial(skill)}</span>
                  <b>{skill.name}</b>
                  <button
                    type="button"
                    className={`ns-switch${skill.enabled ? ' is-on' : ''}`}
                    data-testid="next-skill-toggle"
                    aria-pressed={skill.enabled}
                    onClick={() => { void toggle(skill); }}
                  />
                </div>
                <div className="ns-ext-desc">{skill.description}</div>
                <div className="ns-ext-meta">
                  <span className="mono">{skill.id}</span>
                  <span>·</span>
                  <span>{t(lang, sourceKey(skill.source))}</span>
                </div>
                <div className="ns-ext-acts">
                  {skill.deletable ? (
                    <>
                      <button
                        type="button"
                        className="ns-btn ns-btn-sm"
                        data-testid="next-skill-edit"
                        onClick={() => openEdit(skill)}
                      >
                        {t(lang, 'btn_edit')}
                      </button>
                      <button
                        type="button"
                        className="ns-btn ns-btn-sm"
                        data-testid="next-skill-delete"
                        onClick={() => { void remove(skill); }}
                      >
                        {t(lang, 'skill_delete')}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {drawer ? (
        <>
          <div className="ns-drawer-scrim" onClick={() => setDrawer(null)} />
          <div className="ns-drawer" data-testid="next-skill-drawer">
            <div className="ns-drawer-head">
              <b>
                {drawer.mode === 'edit'
                  ? t(lang, 'skill_edit_title', { name: editing?.name || form.name })
                  : t(lang, 'skill_new_title')}
              </b>
              <button type="button" className="ns-btn ns-btn-ghost" onClick={() => setDrawer(null)}>✕</button>
            </div>
            <div className="ns-drawer-body">
              {drawer.mode === 'add' ? (
                <div className="ns-field">
                  <label>{t(lang, 'skill_id_label')}</label>
                  <input
                    className="ns-input is-mono"
                    data-testid="next-skill-id"
                    value={form.id}
                    placeholder={t(lang, 'skill_id_placeholder')}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(ev) => setForm((prev) => ({ ...prev, id: ev.target.value }))}
                  />
                </div>
              ) : (
                <div className="ns-field">
                  <label>{t(lang, 'skill_id_label')}</label>
                  <input className="ns-input is-mono" value={form.id} readOnly />
                </div>
              )}
              <div className="ns-field">
                <label>{t(lang, 'skill_name_label')}</label>
                <input
                  className="ns-input"
                  data-testid="next-skill-name"
                  value={form.name}
                  placeholder={t(lang, 'skill_name_placeholder')}
                  autoComplete="off"
                  onChange={(ev) => setForm((prev) => ({ ...prev, name: ev.target.value }))}
                />
              </div>
              <div className="ns-field">
                <label>{t(lang, 'skill_desc_label')}</label>
                <input
                  className="ns-input"
                  data-testid="next-skill-desc"
                  value={form.description}
                  placeholder={t(lang, 'skill_desc_placeholder')}
                  autoComplete="off"
                  onChange={(ev) => setForm((prev) => ({ ...prev, description: ev.target.value }))}
                />
              </div>
              <div className="ns-field">
                <label>{t(lang, 'skill_body_label')}</label>
                <textarea
                  className="ns-textarea"
                  data-testid="next-skill-body"
                  value={form.body}
                  placeholder={t(lang, 'skill_body_placeholder')}
                  rows={10}
                  onChange={(ev) => setForm((prev) => ({ ...prev, body: ev.target.value }))}
                />
                {drawer.mode === 'edit' ? (
                  <div className="ns-field-hint">{t(lang, 'skill_body_hint')}</div>
                ) : null}
              </div>
              {error ? <div className="ns-inline-err">{error}</div> : null}
            </div>
            <div className="ns-drawer-foot">
              {drawer.mode === 'edit' && editing?.deletable ? (
                <button
                  type="button"
                  className="ns-btn ns-btn-danger"
                  onClick={() => { void remove(editing); }}
                >
                  {t(lang, 'skill_delete')}
                </button>
              ) : null}
              <button type="button" className="ns-btn ns-btn-ghost" onClick={() => setDrawer(null)}>
                {t(lang, 'btn_cancel')}
              </button>
              <button
                type="button"
                className="ns-btn ns-btn-primary"
                data-testid="next-skill-save"
                disabled={busy}
                onClick={() => { void save(); }}
              >
                {drawer.mode === 'edit' ? t(lang, 'btn_save') : t(lang, 'btn_create')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
