import { useState } from 'react';
import {
  createGitConnection,
  deleteGitConnection,
  patchGitConnection,
  testGitConnection,
  testGitConnectionDraft,
  type GitConnection,
} from '../../data/api';
import {
  emptyGitForm,
  formFromConnection,
  GIT_KINDS,
  gitlabComUrl,
  gitlabTokenPage,
  gitWriteBody,
  hostLabel,
  type GitForm,
  type GitKind,
} from '../../data/gitSettings';
import type { Lang } from '../../data/lang';
import { useExtensions } from '../../data/useExtensions';
import { t, type I18nKey } from '../../i18n';
import type { ConfirmOpts } from '../ConfirmDialog';

type Props = {
  lang: Lang;
  onToast: (message: string) => void;
  onConfirm: (opts: ConfirmOpts) => Promise<boolean>;
};

type Drawer = { mode: 'add' } | { mode: 'edit'; id: string };

type TestState =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; username: string; text: string }
  | { phase: 'fail'; text: string };

const KIND_KEY: Record<GitKind, I18nKey> = {
  'gitlab-self': 'git_kind_self',
  'gitlab-com': 'git_kind_com',
  other: 'git_kind_other',
};

const KIND_HINT: Record<GitKind, I18nKey> = {
  'gitlab-self': 'git_kind_hint_self',
  'gitlab-com': 'git_kind_hint_com',
  other: 'git_kind_hint_other',
};

function failText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function rowDot(conn: GitConnection, testing: boolean): string {
  if (testing) return 'is-warn';
  if (conn.lastTest?.ok) return 'is-ok';
  if (conn.lastTest && conn.lastTest.ok === false) return 'is-bad';
  return '';
}

function TokenMask({ token, hasToken }: { token: string; hasToken: boolean }) {
  if (!hasToken || !token) return null;
  return (
    <>
      <span className="ns-sep">·</span>
      <span className="mono">{token}</span>
    </>
  );
}

export function GitPage({ lang, onToast, onConfirm }: Props) {
  const { gitConnections, ready } = useExtensions();
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [form, setForm] = useState<GitForm>(emptyGitForm);
  const [advanced, setAdvanced] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const [rowTesting, setRowTesting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editing = drawer?.mode === 'edit' ? gitConnections.find((item) => item.id === drawer.id) : null;
  const displayUrl = form.kind === 'gitlab-com' ? gitlabComUrl() : form.baseUrl;
  const tokenLink = gitlabTokenPage(displayUrl);

  function openAdd() {
    setForm(emptyGitForm());
    setAdvanced(false);
    setTest({ phase: 'idle' });
    setDrawer({ mode: 'add' });
  }

  function openEdit(conn: GitConnection) {
    setForm(formFromConnection(conn));
    setAdvanced(Boolean(conn.caFile));
    setTest({ phase: 'idle' });
    setDrawer({ mode: 'edit', id: conn.id });
  }

  function setKind(kind: GitKind) {
    setForm((prev) => ({
      ...prev,
      kind,
      baseUrl: kind === 'gitlab-com' ? gitlabComUrl() : (kind === prev.kind ? prev.baseUrl : prev.baseUrl),
      allowHttp: kind === 'gitlab-self' ? prev.allowHttp : false,
    }));
    setTest({ phase: 'idle' });
  }

  async function runFormTest() {
    setTest({ phase: 'testing' });
    try {
      const includeToken = Boolean(form.token.trim());
      const body = gitWriteBody(form, {
        includeToken,
        id: drawer?.mode === 'edit' ? drawer.id : undefined,
      });
      const result = await testGitConnectionDraft(body, lang);
      if (result.ok) {
        setTest({ phase: 'ok', username: result.username || '', text: result.statusText || t(lang, 'git_test_ok') });
      } else {
        setTest({ phase: 'fail', text: result.statusText || t(lang, 'git_test') });
      }
    } catch (err) {
      setTest({ phase: 'fail', text: failText(err) });
    }
  }

  async function runRowTest(conn: GitConnection) {
    setRowTesting(conn.id);
    try {
      await testGitConnection(conn.id, lang);
    } catch (err) {
      onToast(failText(err));
    } finally {
      setRowTesting(null);
    }
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const includeToken = drawer?.mode === 'add' || Boolean(form.token.trim());
      const body = gitWriteBody(form, { includeToken });
      if (drawer?.mode === 'edit') {
        await patchGitConnection(drawer.id, body, lang);
      } else {
        await createGitConnection(body, lang);
      }
      setDrawer(null);
      setTest({ phase: 'idle' });
    } catch (err) {
      setTest({ phase: 'fail', text: failText(err) });
    } finally {
      setSaving(false);
    }
  }

  async function remove(conn: GitConnection) {
    const ok = await onConfirm({
      title: t(lang, 'git_delete_title', { name: conn.name }),
      message: t(lang, 'git_delete_body'),
      confirmLabel: t(lang, 'btn_delete'),
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteGitConnection(conn.id);
      setDrawer(null);
    } catch (err) {
      onToast(failText(err));
    }
  }

  const okN = gitConnections.filter((item) => item.lastTest?.ok).length;
  const badN = gitConnections.filter((item) => item.lastTest && item.lastTest.ok === false).length;

  return (
    <div className="next-settings-content ns-git-page" data-testid="next-settings-git">
      <div className="next-settings-head">
        <div>
          <h2>
            {t(lang, 'git_title')}
            <span className="next-settings-aside">{t(lang, 'git_aside')}</span>
          </h2>
          <p className="next-settings-sub">{t(lang, 'git_lead')}</p>
        </div>
        <button type="button" className="ns-btn" data-testid="next-git-add" onClick={openAdd}>
          {t(lang, 'git_add')}
        </button>
      </div>
      <div className="ns-git-scroll">
        {!ready ? (
          <div className="ns-empty">{t(lang, 'loading')}</div>
        ) : gitConnections.length === 0 ? (
          <div className="ns-empty-block" data-testid="next-git-empty">
            <b>{t(lang, 'git_empty_title')}</b>
            <p>{t(lang, 'git_empty_body')}</p>
            <p className="ns-empty-foot">{t(lang, 'git_empty_reserved')}</p>
          </div>
        ) : (
          <>
            <div className="ns-section-title">
              <b>{t(lang, 'git_section')}</b>
              <span>{t(lang, 'git_section_meta', { ok: okN, bad: badN })}</span>
            </div>
            <div className="ns-git-list">
              {gitConnections.map((conn) => {
                const testing = rowTesting === conn.id;
                return (
                  <div
                    key={conn.id}
                    className="ns-git-row"
                    data-testid="next-git-row"
                    data-id={conn.id}
                  >
                    <span className={`ns-dot ${rowDot(conn, testing)}`} />
                    <div className="ns-git-main">
                      <div className="ns-git-name">
                        <b>{conn.name}</b>
                        <span className="ns-tag is-key">{t(lang, KIND_KEY[conn.kind])}</span>
                      </div>
                      <div className="ns-git-meta">
                        {testing ? (
                          <>
                            <span className="ns-spin" />
                            <span>{t(lang, 'git_testing')}</span>
                          </>
                        ) : conn.lastTest?.ok ? (
                          <>
                            <span className="mono">{hostLabel(conn.baseUrl)}</span>
                            <TokenMask token={conn.token} hasToken={conn.hasToken} />
                            <span className="ns-sep">·</span>
                            <span>{conn.lastTest.username}</span>
                            <span className="ns-sep">·</span>
                            <span>{t(lang, 'git_connected')}</span>
                          </>
                        ) : conn.lastTest && conn.lastTest.ok === false ? (
                          <>
                            <span className="mono">{hostLabel(conn.baseUrl)}</span>
                            <TokenMask token={conn.token} hasToken={conn.hasToken} />
                            <span className="ns-sep">·</span>
                            <span className="ns-why">{conn.lastTest.errorText}</span>
                          </>
                        ) : (
                          <>
                            <span className="mono">{hostLabel(conn.baseUrl)}</span>
                            <TokenMask token={conn.token} hasToken={conn.hasToken} />
                            <span className="ns-sep">·</span>
                            <span>{t(lang, 'git_untested')}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="ns-git-acts">
                      <button
                        type="button"
                        className="ns-btn ns-btn-sm"
                        data-testid="next-git-row-test"
                        disabled={testing}
                        onClick={() => { void runRowTest(conn); }}
                      >
                        {t(lang, 'git_row_test')}
                      </button>
                      <button
                        type="button"
                        className="ns-btn ns-btn-sm"
                        data-testid="next-git-edit"
                        onClick={() => openEdit(conn)}
                      >
                        {t(lang, 'git_row_edit')}
                      </button>
                      <button
                        type="button"
                        className="ns-btn ns-btn-sm"
                        data-testid="next-git-delete"
                        onClick={() => { void remove(conn); }}
                      >
                        {t(lang, 'git_row_delete')}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="ns-git-foot">
              {t(lang, 'git_footnote_before')}
              <span className="mono">.git/config</span>
              {t(lang, 'git_footnote_after')}
            </p>
          </>
        )}
      </div>

      {drawer ? (
        <>
          <div className="ns-drawer-scrim" onClick={() => setDrawer(null)} />
          <div className="ns-drawer" data-testid="next-git-drawer">
            <div className="ns-drawer-head">
              <b>
                {drawer.mode === 'edit'
                  ? t(lang, 'git_edit_title', { name: editing?.name || form.name })
                  : t(lang, 'git_add_title')}
              </b>
              <button type="button" className="ns-btn ns-btn-ghost" onClick={() => setDrawer(null)}>✕</button>
            </div>
            <div className="ns-drawer-body">
              <div className="ns-field">
                <label>{t(lang, 'git_kind')}</label>
                <div className="ns-kinds">
                  {GIT_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={`ns-kind${form.kind === kind ? ' is-on' : ''}`}
                      data-testid={`next-git-kind-${kind}`}
                      onClick={() => setKind(kind)}
                    >
                      {t(lang, KIND_KEY[kind])}
                    </button>
                  ))}
                </div>
                <div className="ns-field-hint">{t(lang, KIND_HINT[form.kind])}</div>
              </div>
              <div className="ns-field">
                <label>{t(lang, 'git_name')}</label>
                <input
                  className="ns-input"
                  data-testid="next-git-name"
                  value={form.name}
                  placeholder={t(lang, 'git_name_ph')}
                  autoComplete="off"
                  onChange={(ev) => setForm((prev) => ({ ...prev, name: ev.target.value }))}
                />
              </div>
              <div className="ns-field">
                <label>{t(lang, 'git_url')}</label>
                <input
                  className="ns-input is-mono"
                  data-testid="next-git-url"
                  value={displayUrl}
                  placeholder={t(lang, 'git_url_ph')}
                  spellCheck={false}
                  autoComplete="off"
                  readOnly={form.kind === 'gitlab-com'}
                  onChange={(ev) => setForm((prev) => ({ ...prev, baseUrl: ev.target.value }))}
                />
                <div className="ns-field-hint">
                  {t(lang, form.kind === 'gitlab-com' ? 'git_url_com_hint' : 'git_url_hint')}
                </div>
              </div>
              <div className="ns-field">
                <label>{t(lang, 'git_token')}</label>
                <input
                  className="ns-input is-mono"
                  data-testid="next-git-token"
                  type="password"
                  value={form.token}
                  placeholder={drawer.mode === 'edit' ? t(lang, 'git_token_keep') : t(lang, 'git_token_ph')}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(ev) => setForm((prev) => ({ ...prev, token: ev.target.value }))}
                />
                <div className="ns-field-hint">
                  {t(lang, 'git_token_need')}
                  {' '}
                  <span className="mono">read_repository</span>
                  {' '}
                  {t(lang, 'git_token_and')}
                  {' '}
                  <span className="mono">read_api</span>
                  {t(lang, 'git_token_mid')}
                  <span className="mono">.git/config</span>
                  {t(lang, 'git_token_end')}
                </div>
                <div className="ns-field-hint">
                  {t(lang, drawer.mode === 'edit' ? 'git_token_hint_edit' : (form.kind === 'other' ? 'git_token_hint_other' : 'git_token_hint_new'))}
                </div>
                <div className="ns-field-hint">
                  <a
                    className={`ns-field-link${tokenLink ? '' : ' is-off'}`}
                    href={tokenLink || '#'}
                    target="_blank"
                    rel="noreferrer"
                    id="git-token-link"
                    onClick={(ev) => { if (!tokenLink) ev.preventDefault(); }}
                  >
                    {t(lang, 'git_token_link')}
                  </a>
                </div>
              </div>
              {form.kind === 'gitlab-self' ? (
                <label className="ns-chk">
                  <input
                    type="checkbox"
                    data-testid="next-git-http"
                    checked={form.allowHttp}
                    onChange={(ev) => setForm((prev) => ({ ...prev, allowHttp: ev.target.checked }))}
                  />
                  <span>
                    {t(lang, 'git_http')}
                    <span className="ns-field-hint">{t(lang, 'git_http_hint')}</span>
                  </span>
                </label>
              ) : null}
              <button type="button" className="ns-adv-toggle" onClick={() => setAdvanced((v) => !v)}>
                <span className={`ns-caret-tiny${advanced ? ' is-open' : ''}`} />
                {t(lang, 'git_advanced')}
              </button>
              {advanced ? (
                <div className="ns-field">
                  <label>{t(lang, 'git_ca')}</label>
                  <input
                    className="ns-input is-mono"
                    data-testid="next-git-ca"
                    value={form.caFile}
                    placeholder={t(lang, 'git_ca_ph')}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(ev) => setForm((prev) => ({ ...prev, caFile: ev.target.value }))}
                  />
                  <div className="ns-field-hint">{t(lang, 'git_ca_hint')}</div>
                </div>
              ) : null}
              <div className="ns-test-row">
                <button
                  type="button"
                  className="ns-btn"
                  data-testid="next-git-test"
                  disabled={test.phase === 'testing'}
                  onClick={() => { void runFormTest(); }}
                >
                  {t(lang, 'git_test')}
                </button>
              </div>
              {test.phase !== 'idle' ? (
                <div className="ns-test-card is-git" data-testid="next-git-test-result">
                  {test.phase === 'testing' ? (
                    <div className="ns-git-line">
                      <span className="ns-spin" />
                      <span>{t(lang, 'git_testing')}</span>
                    </div>
                  ) : test.phase === 'ok' ? (
                    <>
                      <div className="ns-git-line is-ok">
                        <span>✓</span>
                        <b>{test.username}</b>
                      </div>
                      <div className="ns-field-hint">{test.text}</div>
                    </>
                  ) : (
                    <div className="ns-why">{test.text}</div>
                  )}
                </div>
              ) : null}
            </div>
            <div className="ns-drawer-foot">
              {drawer.mode === 'edit' && editing ? (
                <button
                  type="button"
                  className="ns-btn ns-btn-danger"
                  onClick={() => { void remove(editing); }}
                >
                  {t(lang, 'btn_delete')}
                </button>
              ) : null}
              <button type="button" className="ns-btn ns-btn-ghost" onClick={() => setDrawer(null)}>
                {t(lang, 'btn_cancel')}
              </button>
              <button
                type="button"
                className="ns-btn ns-btn-primary"
                data-testid="next-git-save"
                disabled={saving}
                onClick={() => { void save(); }}
              >
                {drawer.mode === 'edit' ? t(lang, 'btn_save') : t(lang, 'git_save_add')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
