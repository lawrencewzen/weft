import { useEffect, useMemo, useState } from 'react';
import {
  createWorkspace,
  listGitBranches,
  listGitProjects,
  listWorkspaceDirs,
  getWorkspaceRoot,
  type GitBranch,
  type GitProject,
  type Workspace,
  type WorkspaceDirEntry,
  type WorkspaceDirs,
} from '../data/api';
import { dirBasename, isGitlabKind } from '../data/gitSettings';
import type { Lang } from '../data/lang';
import { draftPath, navigate } from '../data/nav';
import { writeActiveWorkspace } from '../data/layout';
import { useExtensions } from '../data/useExtensions';
import { t } from '../i18n';

type Props = {
  lang: Lang;
  onClose: () => void;
  onToast: (message: string) => void;
  onCreated?: (ws: Workspace) => void;
};

type Tab = 'local' | 'git';
type GitSource = 'pick' | 'address';

function failText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function WorkspaceDialog({ lang, onClose, onToast, onCreated }: Props) {
  const { gitConnections, ready } = useExtensions();
  const [tab, setTab] = useState<Tab>('local');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [path, setPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [source, setSource] = useState<GitSource>('pick');
  const [connId, setConnId] = useState('');
  const [search, setSearch] = useState('');
  const [projects, setProjects] = useState<GitProject[]>([]);
  const [projectsError, setProjectsError] = useState('');
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectId, setProjectId] = useState<string>('');
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const [connOpen, setConnOpen] = useState(false);
  const [dirs, setDirs] = useState<WorkspaceDirs | null>(null);
  const [dirError, setDirError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [root, setRoot] = useState('');

  const gitlabConns = useMemo(
    () => gitConnections.filter((item) => isGitlabKind(item.kind)),
    [gitConnections],
  );
  const conn = gitlabConns.find((item) => item.id === connId) || gitlabConns[0] || null;
  const selected = projects.find((item) => String(item.id) === projectId) || null;

  useEffect(() => {
    let cancelled = false;
    getWorkspaceRoot(lang).then((res) => {
      if (cancelled) return;
      setRoot(res.root);
      return listWorkspaceDirs(undefined, lang);
    }).then((listed) => {
      if (cancelled || !listed) return;
      setDirs(listed);
    }).catch((err) => {
      if (!cancelled) setDirError(failText(err));
    });
    return () => { cancelled = true; };
  }, [lang]);

  const connIdForProjects = conn?.id;
  useEffect(() => {
    if (!connIdForProjects) {
      setProjects([]);
      setProjectsError('');
      return;
    }
    let cancelled = false;
    setProjectsLoading(true);
    setProjectsError('');
    listGitProjects(connIdForProjects, search, lang).then((res) => {
      if (cancelled) return;
      setProjects(res.projects || []);
      setProjectsLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setProjects([]);
      setProjectsError(failText(err));
      setProjectsLoading(false);
    });
    return () => { cancelled = true; };
  }, [connIdForProjects, search, lang]);

  const selectedProjectId = selected?.id;
  const selectedDefaultBranch = selected?.defaultBranch;
  useEffect(() => {
    if (!connIdForProjects || !selectedProjectId) {
      setBranches([]);
      setDefaultBranch('');
      return;
    }
    let cancelled = false;
    listGitBranches(connIdForProjects, selectedProjectId, lang).then((res) => {
      if (cancelled) return;
      setBranches(res.branches || []);
      setDefaultBranch(res.defaultBranch || selectedDefaultBranch || '');
    }).catch(() => {
      if (!cancelled) {
        setBranches([]);
        setDefaultBranch(selectedDefaultBranch || '');
      }
    });
    return () => { cancelled = true; };
  }, [connIdForProjects, selectedProjectId, selectedDefaultBranch, lang]);

  useEffect(() => {
    if (tab !== 'git' || source !== 'pick' || !selected || nameTouched) return;
    setName(dirBasename(selected.path));
  }, [tab, source, selected, nameTouched]);

  useEffect(() => {
    if (!defaultBranch) return;
    setBranch((current) => {
      if (current && branches.some((item) => item.name === current)) return current;
      return defaultBranch;
    });
  }, [defaultBranch, branches]);

  async function enterDir(nextPath: string) {
    setDirError('');
    try {
      const listed = await listWorkspaceDirs(nextPath, lang);
      setDirs(listed);
    } catch (err) {
      setDirError(failText(err));
    }
  }

  function chooseDir(entry: WorkspaceDirEntry | { path: string; name: string }) {
    setPath(entry.path);
    if (!nameTouched) setName(entry.name || dirBasename(entry.path));
  }

  async function submit() {
    const wsName = name.trim();
    if (!wsName) {
      setError(t(lang, 'ws_name_required'));
      return;
    }
    if (tab === 'local' && !path.trim()) {
      setError(t(lang, 'ws_path_required'));
      return;
    }
    if (tab === 'git' && source === 'address' && !gitUrl.trim()) {
      setError(t(lang, 'ws_git_required'));
      return;
    }
    if (tab === 'git' && source === 'pick' && !selected) {
      setError(t(lang, 'git_need_project'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      let ws: Workspace;
      if (tab === 'local') {
        ws = await createWorkspace({ name: wsName, source: 'local', path: path.trim() }, lang);
      } else if (source === 'address') {
        const body: { name: string; source: 'git'; gitUrl: string; branch?: string } = {
          name: wsName,
          source: 'git',
          gitUrl: gitUrl.trim(),
        };
        if (branch.trim()) body.branch = branch.trim();
        ws = await createWorkspace(body, lang);
      } else {
        const body: {
          name: string;
          source: 'git';
          connectionId: string;
          projectId: string | number;
          branch?: string;
        } = {
          name: wsName,
          source: 'git',
          connectionId: conn!.id,
          projectId: selected!.id,
        };
        if (branch.trim()) body.branch = branch.trim();
        ws = await createWorkspace(body, lang);
      }
      writeActiveWorkspace(ws.id);
      onCreated?.(ws);
      onToast(t(lang, 'ws_created', { name: ws.name }));
      navigate(draftPath(ws.id));
      onClose();
    } catch (err) {
      setError(failText(err));
    } finally {
      setBusy(false);
    }
  }

  const cloningLabel = tab === 'git' && busy
    ? (name.trim() && branch.trim()
      ? t(lang, 'git_cloning_named', { name: name.trim(), branch: branch.trim() })
      : t(lang, 'git_cloning'))
    : t(lang, 'ws_creating');

  return (
    <div
      className="modal-overlay"
      data-testid="next-ws-dialog"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget && !busy) onClose();
      }}
    >
      <div className={`modal-dialog ns-ws-dialog${busy ? ' is-busy' : ''}`} role="dialog" aria-modal="true">
        <h3>
          {t(lang, 'new_workspace')}
          <button type="button" className="confirm-close" onClick={onClose} aria-label={t(lang, 'btn_cancel')}>×</button>
        </h3>
        <div className="ns-seg">
          <button
            type="button"
            className={tab === 'local' ? 'is-on' : ''}
            data-testid="next-ws-tab-local"
            onClick={() => { setTab('local'); setError(''); }}
          >
            {t(lang, 'ws_local_tab')}
          </button>
          <button
            type="button"
            className={tab === 'git' ? 'is-on' : ''}
            data-testid="next-ws-tab-git"
            onClick={() => { setTab('git'); setError(''); }}
          >
            {t(lang, 'ws_git_tab')}
          </button>
        </div>
        <div className="ns-ws-body">
          {tab === 'local' ? (
            <>
              <div className="ns-field">
                <label>{t(lang, 'ws_name_label')}</label>
                <input
                  className="ns-input"
                  data-testid="next-ws-name"
                  value={name}
                  placeholder={t(lang, 'ws_name_placeholder')}
                  onChange={(ev) => {
                    setName(ev.target.value);
                    setNameTouched(true);
                  }}
                />
              </div>
              <div className="ns-field">
                <label>{t(lang, 'ws_path_label')}</label>
                <input
                  className="ns-input is-mono"
                  data-testid="next-ws-path"
                  value={path}
                  readOnly
                  placeholder={t(lang, 'ws_path_placeholder')}
                />
                <div className="ns-field-hint">{t(lang, 'ws_path_hint', { root: dirs?.root || root })}</div>
              </div>
              <div className="ns-dir-browser">
                <div className="ns-dir-bar">
                  <span className="mono ns-dir-now" title={dirs?.path || root}>{dirs?.path || root}</span>
                  {dirs?.parent ? (
                    <button
                      type="button"
                      className="ns-btn ns-btn-sm"
                      data-testid="next-dir-up"
                      onClick={() => { void enterDir(dirs.parent as string); }}
                    >
                      {t(lang, 'ws_dir_up')}
                    </button>
                  ) : null}
                  {dirs?.selectable ? (
                    <button
                      type="button"
                      className="ns-btn ns-btn-sm"
                      data-testid="next-dir-choose-current"
                      onClick={() => chooseDir({ path: dirs.path, name: dirBasename(dirs.path) })}
                    >
                      {t(lang, 'ws_dir_choose_current')}
                    </button>
                  ) : null}
                </div>
                {dirError ? <div className="ns-inline-err">{dirError}</div> : null}
                <div className="ns-dir-list">
                  {(dirs?.entries || []).map((entry) => (
                    <div
                      key={entry.path}
                      className={`ns-dir-row${path === entry.path ? ' is-on' : ''}`}
                      data-testid="next-dir-row"
                      data-path={entry.path}
                    >
                      <button
                        type="button"
                        className="ns-dir-name"
                        onClick={() => { void enterDir(entry.path); }}
                        onDoubleClick={() => chooseDir(entry)}
                      >
                        {entry.name}
                      </button>
                      <button
                        type="button"
                        className="ns-dir-pick"
                        data-testid="next-dir-choose"
                        onClick={() => chooseDir(entry)}
                      >
                        {t(lang, 'ws_dir_choose')}
                      </button>
                    </div>
                  ))}
                  {dirs && dirs.entries.length === 0 ? (
                    <div className="ns-dir-empty">{t(lang, 'ws_dir_empty')}</div>
                  ) : null}
                </div>
                {dirs?.truncated ? <p className="ns-field-hint">{t(lang, 'ws_dir_truncated')}</p> : null}
              </div>
            </>
          ) : (
            <>
              <div className="ns-seg">
                <button
                  type="button"
                  className={source === 'pick' ? 'is-on' : ''}
                  data-testid="next-ws-source-pick"
                  onClick={() => { setSource('pick'); setError(''); }}
                >
                  {t(lang, 'git_pick')}
                </button>
                <button
                  type="button"
                  className={source === 'address' ? 'is-on' : ''}
                  data-testid="next-ws-source-address"
                  onClick={() => { setSource('address'); setError(''); }}
                >
                  {t(lang, 'git_address')}
                </button>
              </div>
              {source === 'address' ? (
                <>
                  <div className="ns-field">
                    <label>{t(lang, 'ws_name_label')}</label>
                    <input
                      className="ns-input"
                      data-testid="next-ws-name"
                      value={name}
                      onChange={(ev) => { setName(ev.target.value); setNameTouched(true); }}
                    />
                  </div>
                  <div className="ns-field">
                    <label>{t(lang, 'ws_git_url_label')}</label>
                    <input
                      className="ns-input is-mono"
                      data-testid="next-ws-git-url"
                      value={gitUrl}
                      placeholder={t(lang, 'ws_git_url_placeholder')}
                      spellCheck={false}
                      onChange={(ev) => setGitUrl(ev.target.value)}
                    />
                  </div>
                  <div className="ns-field">
                    <label>{t(lang, 'ws_branch_label')}</label>
                    <input
                      className="ns-input is-mono"
                      data-testid="next-ws-branch"
                      value={branch}
                      placeholder={t(lang, 'ws_branch_placeholder')}
                      spellCheck={false}
                      onChange={(ev) => setBranch(ev.target.value)}
                    />
                  </div>
                  <p className="ns-field-hint">
                    {t(lang, 'git_addr_hint_before')}
                    <span className="mono">.git/config</span>
                    {t(lang, 'git_addr_hint_after')}
                  </p>
                </>
              ) : !ready ? (
                <div className="ns-dir-empty">{t(lang, 'loading')}</div>
              ) : !conn ? (
                <div className="ns-dir-empty">{t(lang, 'git_no_conn')}</div>
              ) : (
                <>
                  <div className="ns-field">
                    <label>{t(lang, 'git_conn')}</label>
                    <div className="ns-pick">
                      <button
                        type="button"
                        className="ns-pick-btn"
                        data-testid="next-git-conn"
                        onClick={() => { setConnOpen((v) => !v); setBranchOpen(false); }}
                      >
                        <span className={`ns-dot ${conn.lastTest?.ok ? 'is-ok' : ''}`} />
                        <span className="ns-pick-main">{conn.name}</span>
                        <span className="ns-pick-from">{conn.lastTest?.username || ''}</span>
                      </button>
                      {connOpen ? (
                        <div className="ns-pop ns-pop-in">
                          {gitlabConns.map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              className={`ns-pop-item${item.id === conn.id ? ' is-on' : ''}`}
                              onClick={() => {
                                setConnId(item.id);
                                setConnOpen(false);
                                setProjectId('');
                                setNameTouched(false);
                              }}
                            >
                              {item.name}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <div className="ns-field">
                    <label>{t(lang, 'git_search')}</label>
                    <input
                      className="ns-input"
                      data-testid="next-git-search"
                      value={search}
                      placeholder={t(lang, 'git_search_ph')}
                      onChange={(ev) => setSearch(ev.target.value)}
                    />
                  </div>
                  <div className="ns-projects">
                    {projectsLoading ? (
                      <div className="ns-dir-empty">{t(lang, 'git_loading')}</div>
                    ) : projectsError ? (
                      <div className="ns-inline-err">{projectsError}</div>
                    ) : projects.length === 0 ? (
                      <div className="ns-dir-empty">{t(lang, 'git_no_match')}</div>
                    ) : projects.map((item) => (
                      <button
                        key={String(item.id)}
                        type="button"
                        className={`ns-proj${String(item.id) === projectId ? ' is-on' : ''}`}
                        data-testid="next-git-project"
                        onClick={() => {
                          setProjectId(String(item.id));
                          setNameTouched(false);
                          setBranchOpen(false);
                        }}
                      >
                        <b className="mono">{item.path}</b>
                        {item.description ? <span>{item.description}</span> : null}
                        <span className="ns-ext-meta">
                          {t(lang, 'git_default_branch', { branch: item.defaultBranch })}
                        </span>
                      </button>
                    ))}
                  </div>
                  {selected ? (
                    <>
                      <div className="ns-field">
                        <label>{t(lang, 'git_branch')}</label>
                        <div className="ns-pick">
                          <button
                            type="button"
                            className="ns-pick-btn"
                            data-testid="next-git-branch"
                            onClick={() => { setBranchOpen((v) => !v); setConnOpen(false); }}
                          >
                            <span className="mono ns-pick-main">{branch || defaultBranch}</span>
                            {branch === defaultBranch ? (
                              <span className="ns-pick-from">{t(lang, 'git_default')}</span>
                            ) : null}
                          </button>
                          {branchOpen ? (
                            <div className="ns-pop ns-pop-in ns-pop-up" data-testid="next-git-branch-pop">
                              {(branches.length ? branches : [{ name: defaultBranch || 'main', default: true }]).map((item) => (
                                <button
                                  key={item.name}
                                  type="button"
                                  className={`ns-pop-item${item.name === branch ? ' is-on' : ''}`}
                                  onClick={() => {
                                    setBranch(item.name);
                                    setBranchOpen(false);
                                  }}
                                >
                                  <span className="mono">{item.name}</span>
                                  {item.default || item.name === defaultBranch ? (
                                    <span className="ns-pick-from">{t(lang, 'git_default')}</span>
                                  ) : null}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="ns-field">
                        <label>{t(lang, 'ws_name_label')}</label>
                        <input
                          className="ns-input"
                          data-testid="next-git-import-name"
                          value={name}
                          onChange={(ev) => { setName(ev.target.value); setNameTouched(true); }}
                        />
                        <div className="ns-field-hint">{t(lang, 'git_name_hint')}</div>
                      </div>
                    </>
                  ) : (
                    <p className="ns-field-hint">{t(lang, 'git_pick_wait')}</p>
                  )}
                </>
              )}
            </>
          )}
        </div>
        {error ? <div className="ns-inline-err" data-testid="next-ws-error">{error}</div> : null}
        {busy ? (
          <div className="ns-ws-progress">
            <span className="ns-spin" />
            <span>{cloningLabel}</span>
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" data-testid="next-ws-cancel" disabled={busy} onClick={onClose}>
            {t(lang, 'btn_cancel')}
          </button>
          <button
            type="button"
            className="btn p"
            data-testid="next-ws-create"
            disabled={busy}
            onClick={() => { void submit(); }}
          >
            {busy ? cloningLabel : t(lang, 'btn_create')}
          </button>
        </div>
      </div>
    </div>
  );
}
