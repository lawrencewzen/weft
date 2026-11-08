import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createWorkspace,
  listGitBranches,
  listGitProjects,
  listWorkspaceDirs,
  getWorkspaceRoot,
  pickWorkspaceRoot,
  type GitBranch,
  type GitProject,
  type Workspace,
  type WorkspaceDirs,
  type WorkspacePickResult,
} from '../data/api';
import { dirBasename, isGitlabKind } from '../data/gitSettings';
import type { Lang } from '../data/lang';
import { draftPath, navigate } from '../data/nav';
import { writeActiveWorkspace } from '../data/layout';
import { useExtensions } from '../data/useExtensions';
import { splitBreadcrumbs } from '../data/workspacePath';
import { t } from '../i18n';
import { FOLDER_ICON } from './SidebarIcons';

const GIT_IMPORT_ENABLED = false;

type Props = {
  lang: Lang;
  onClose: () => void;
  onToast: (message: string) => void;
  onCreated?: (ws: Workspace) => void;
  /** 「浏览…」的实现，默认走服务端系统选文件夹对话框；桌面壳可替换成自己的对话框。 */
  pickFolder?: () => Promise<WorkspacePickResult>;
};

type Tab = 'local' | 'git';
type GitSource = 'pick' | 'address';

function failText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function WorkspaceDialog({ lang, onClose, onToast, onCreated, pickFolder }: Props) {
  const { gitConnections, ready } = useExtensions();
  const [tab, setTab] = useState<Tab>('local');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [checked, setChecked] = useState<WorkspaceDirs | null>(null);
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
  const [picking, setPicking] = useState(false);
  const [pickUnsupported, setPickUnsupported] = useState(false);
  const pathRef = useRef<HTMLInputElement>(null);
  const pickingRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    pathRef.current?.focus();
    return () => { aliveRef.current = false; };
  }, []);

  const gitlabConns = useMemo(
    () => gitConnections.filter((item) => isGitlabKind(item.kind)),
    [gitConnections],
  );
  const conn = gitlabConns.find((item) => item.id === connId) || gitlabConns[0] || null;
  const selected = projects.find((item) => String(item.id) === projectId) || null;

  // 页内目录浏览只在系统选文件夹不可用时才需要，到那时再加载起始目录。
  useEffect(() => {
    if (!pickUnsupported) return;
    let cancelled = false;
    getWorkspaceRoot(lang).then((res) => {
      if (cancelled) return;
      setRoot(res.root);
      return listWorkspaceDirs(undefined, lang);
    }).then((listed) => {
      if (cancelled || !listed) return;
      setDirs((current) => current || listed);
    }).catch((err) => {
      if (!cancelled) setDirError(failText(err));
    });
    return () => { cancelled = true; };
  }, [lang, pickUnsupported]);

  const connIdForProjects = conn?.id;
  useEffect(() => {
    if (!GIT_IMPORT_ENABLED || !connIdForProjects) {
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
    if (!GIT_IMPORT_ENABLED || !connIdForProjects || !selectedProjectId) {
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
    if (!GIT_IMPORT_ENABLED || tab !== 'git' || source !== 'pick' || !selected || nameTouched) return;
    setName(dirBasename(selected.path));
  }, [tab, source, selected, nameTouched]);

  useEffect(() => {
    if (!GIT_IMPORT_ENABLED || !defaultBranch) return;
    setBranch((current) => {
      if (current && branches.some((item) => item.name === current)) return current;
      return defaultBranch;
    });
  }, [defaultBranch, branches]);

  async function enterDir(nextPath: string) {
    setDirError('');
    setError('');
    try {
      const listed = await listWorkspaceDirs(nextPath, lang);
      setDirs(listed);
      setChecked(listed);
      setPathInput(listed.path);
    } catch (err) {
      setChecked(null);
      setDirError(failText(err));
    }
  }

  async function handlePathJump(rawPath: string): Promise<WorkspaceDirs | null> {
    const target = rawPath.trim();
    if (!target) return null;
    setDirError('');
    setError('');
    try {
      const listed = await listWorkspaceDirs(target, lang);
      setDirs(listed);
      setChecked(listed);
      setPathInput(listed.path);
      return listed;
    } catch (err) {
      setChecked(null);
      setDirError(failText(err));
      return null;
    }
  }

  async function handleBrowse() {
    if (pickingRef.current || busy) return;
    pickingRef.current = true;
    setPicking(true);
    setError('');
    try {
      const res = await (pickFolder ? pickFolder() : pickWorkspaceRoot(lang));
      if (!aliveRef.current) return;
      if (res.status === 'picked') {
        setPathInput(res.path);
        if (!nameTouched) setName(dirBasename(res.path) || res.path);
        await handlePathJump(res.path);
      } else if (res.status === 'unsupported') {
        setPickUnsupported(true);
        pathRef.current?.focus();
      }
    } catch (err) {
      if (aliveRef.current) setError(failText(err));
    } finally {
      pickingRef.current = false;
      if (aliveRef.current) setPicking(false);
    }
  }

  const breadcrumbs = useMemo(() => {
    return splitBreadcrumbs(dirs?.path || root);
  }, [dirs?.path, root]);

  const typedPath = pathInput.trim();
  const pathPending = typedPath !== '' && typedPath !== checked?.path;
  const confirmed = !pathPending && typedPath !== '' && checked?.selectable ? checked : null;
  const blocked = !pathPending && typedPath !== '' && checked && !checked.selectable;
  const pathError = dirError || (blocked ? t(lang, 'ws_path_blocked') : '') || error;
  const localReady = !busy && typedPath !== '' && (pathPending || Boolean(confirmed));
  const canCreate = GIT_IMPORT_ENABLED
    ? (tab === 'git' || localReady)
    : localReady;

  async function submit() {
    if (!GIT_IMPORT_ENABLED || tab === 'local') {
      if (!canCreate) return;
      setBusy(true);
      setError('');
      try {
        let target = checked;
        if (pathPending || !target) {
          target = await handlePathJump(typedPath);
          if (!target || !target.selectable) return;
        }
        const targetPath = target.path;
        const wsName = dirBasename(targetPath) || targetPath;
        const ws = await createWorkspace({ name: wsName, source: 'local', path: targetPath }, lang);
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
      return;
    }

    const wsName = name.trim();
    if (!wsName) {
      setError(t(lang, 'ws_name_required'));
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
      if (source === 'address') {
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
          {t(lang, 'add_project')}
          <button type="button" className="confirm-close" onClick={onClose} aria-label={t(lang, 'btn_cancel')}>×</button>
        </h3>
        {GIT_IMPORT_ENABLED ? (
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
        ) : null}
        <div className="ns-ws-body">
          {(!GIT_IMPORT_ENABLED || tab === 'local') ? (
            <>
              <div className="ns-field ns-path-field">
                <div className={`ns-path-box${pathError ? ' is-bad' : ''}`}>
                  <input
                    ref={pathRef}
                    className="ns-path-input"
                    data-testid="next-ws-path"
                    value={pathInput}
                    placeholder={t(lang, 'ws_path_placeholder')}
                    spellCheck={false}
                    aria-invalid={pathError ? true : undefined}
                    onChange={(ev) => { setPathInput(ev.target.value); setDirError(''); setError(''); }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') {
                        ev.preventDefault();
                        void handlePathJump(pathInput);
                      }
                    }}
                  />
                  {pickUnsupported ? null : (
                    <button
                      type="button"
                      className="btn ns-browse-btn"
                      data-testid="next-ws-browse"
                      aria-busy={picking}
                      disabled={picking || busy}
                      onClick={() => { void handleBrowse(); }}
                    >
                      {picking ? <span className="sb-spin" aria-hidden="true" /> : FOLDER_ICON}
                      {t(lang, 'ws_browse')}
                    </button>
                  )}
                </div>
                {pathError ? (
                  <div
                    className="ns-path-msg is-bad"
                    data-testid={dirError || blocked ? 'next-ws-dir-error' : 'next-ws-error'}
                  >
                    {pathError}
                  </div>
                ) : confirmed ? (
                  <div className="ns-path-msg is-ok" data-testid="next-ws-confirm">
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3.5 8.5l3 3 6-7" />
                    </svg>
                    <span>{t(lang, 'ws_project_name')} <b data-testid="next-ws-confirm-name">{dirBasename(confirmed.path) || confirmed.path}</b></span>
                    {confirmed.git ? <span className="ns-git-badge" data-testid="next-ws-confirm-git">Git</span> : null}
                  </div>
                ) : null}
              </div>
              {pickUnsupported ? (
              <div className="ns-dir-browser">
                <div className="ns-dir-bar">
                  <nav className="ns-breadcrumbs" aria-label="Breadcrumb" data-testid="next-breadcrumbs">
                    {breadcrumbs.map((crumb, idx) => {
                      const isLast = idx === breadcrumbs.length - 1;
                      return (
                        <span key={crumb.path} className="ns-breadcrumb-item-wrap">
                          {idx > 0 ? <span className="ns-breadcrumb-sep">/</span> : null}
                          <button
                            type="button"
                            className={`ns-breadcrumb-item${isLast ? ' is-current' : ''}`}
                            data-testid="next-breadcrumb-item"
                            disabled={isLast || busy}
                            onClick={() => { void enterDir(crumb.path); }}
                            title={crumb.path}
                          >
                            {crumb.name}
                          </button>
                        </span>
                      );
                    })}
                  </nav>
                </div>
                <div className="ns-dir-list">
                  {(dirs?.entries || []).map((entry) => (
                    <div
                      key={entry.path}
                      className="ns-dir-row"
                      data-testid="next-dir-row"
                      data-path={entry.path}
                      role="button"
                      tabIndex={0}
                      onClick={() => { void enterDir(entry.path); }}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          void enterDir(entry.path);
                        }
                      }}
                    >
                      <span className="ns-dir-name">{entry.name}</span>
                      {entry.git ? <span className="ns-git-badge" data-testid="next-dir-git-badge">Git</span> : null}
                      <span className="ns-dir-arrow" aria-hidden="true">›</span>
                    </div>
                  ))}
                  {dirs && dirs.entries.length === 0 ? (
                    <div className="ns-dir-empty">{t(lang, 'ws_dir_empty')}</div>
                  ) : null}
                </div>
                {dirs?.truncated ? <p className="ns-field-hint">{t(lang, 'ws_dir_truncated')}</p> : null}
              </div>
              ) : null}
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
        {error && tab === 'git' && GIT_IMPORT_ENABLED ? <div className="ns-inline-err" data-testid="next-ws-error">{error}</div> : null}
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
            disabled={!canCreate || busy}
            onClick={() => { void submit(); }}
          >
            {busy ? cloningLabel : t(lang, 'ws_btn_add')}
          </button>
        </div>
      </div>
    </div>
  );
}
