/** v2 routes for new workspaces, plugins, skills, and Git connections. */

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { TOOLS as BUILTIN_TOOLS } from '../../core/config.mjs';
import {
  createGitConnection,
  publicGitConnection,
  recordGitTest,
  updateGitConnection,
} from '../../core/git-connections.mjs';
import { cloneGitRepo, stripGitUrlCredentials } from '../../core/git-import.mjs';
import { listGitlabBranches, listGitlabProjects, testGitlabConnection } from '../../core/gitlab-api.mjs';
import { describePlugins, installPlugin, PLUGIN_ID } from '../../core/plugins.mjs';
import { createSkill, deleteSkill, listSkillRecords, listSkills, SKILL_ID, updateSkill } from '../../core/skills.mjs';
import { defaultWorkspaceRoot, listBrowsableDirs, resolveAllowedWorkspacePath } from '../../core/workspace-guard.mjs';
import { usesConnectionClone } from '../../core/workspace-git.mjs';
import { phrase, type Lang } from '../phrases/index.ts';
import { workspaceView } from '../views/sidebar.ts';
import {
  catalogErrorView,
  gitCloneFailureView,
  gitConnectionView,
  gitTestResultView,
  pathErrorView,
  pluginView,
  skillView,
  workspaceDirsView,
} from '../views/extensions.ts';
import type { ExtensionsSnapshot } from '../stream/extensions-topic.ts';
import { normalizeLang } from '../stream/hub.ts';
import type { components } from '../contract.gen.ts';

type V2Error = components['schemas']['V2Error'];
type Workspace = components['schemas']['Workspace'];

export type ExtensionsSettings = {
  plugins?: Record<string, boolean>;
  skills?: Record<string, boolean>;
  gitConnections?: unknown[];
  [key: string]: unknown;
};

export type WorkspaceRecord = {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  source?: unknown;
  gitUrl?: unknown;
  branch?: unknown;
  [key: string]: unknown;
};

export type GitConnectionRecord = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  token: string;
  allowHttp?: boolean;
  caFile?: string;
  lastTest?: unknown;
  [key: string]: unknown;
};

export type ExtensionsHost = {
  dataDir: string;
  rootDir: string;
  pluginDirs: string[];
  userPlugins: string;
  skillDirs: string[];
  userSkills: string;
  createWorkspace: (fields: {
    id?: string;
    name: string;
    path: string;
    source: string;
    gitUrl?: string | null;
    branch?: string | null;
    rootPath?: string;
    worktrees?: unknown[];
  }) => Promise<WorkspaceRecord>;
  restoreWorkspaceByPath: (wsPath: string, name: string) => Promise<WorkspaceRecord | null | undefined>;
  getSettings: () => Promise<ExtensionsSettings>;
  putSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  reloadPlugins: () => Promise<void>;
  planWorkspaceGit: (body: Record<string, unknown>) => Promise<{
    connection: GitConnectionRecord | null;
    gitUrl: string;
    branch: string;
  }>;
};

export type SendV2Fn = (
  res: ServerResponse,
  requestPath: string,
  method: string,
  status: number,
  body: object,
) => void;

export type ReadObjectBodyFn = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
) => Promise<Record<string, unknown> | null>;

const MAX_CONNECTIONS = 50;

type GitBuilt =
  | { ok: true; value: GitConnectionRecord }
  | { ok: false; errors: string[] };

const cloneRepo = cloneGitRepo as (opts: {
  url: string;
  branch?: string;
  dest: string;
  connection?: GitConnectionRecord | null;
}) => Promise<string>;

const installFromPath = installPlugin as (
  sourcePath: unknown,
  destRoot: string,
  opts?: { existingIds?: Set<string>; existingToolNames?: Set<string>; baseDir?: string },
) => Promise<{ id: string; [key: string]: unknown }>;

function requestLang(url: URL): Lang {
  return normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
}

function asGitList(settings: ExtensionsSettings): GitConnectionRecord[] {
  return Array.isArray(settings.gitConnections) ? settings.gitConnections as GitConnectionRecord[] : [];
}

async function saveConnections(host: ExtensionsHost, list: GitConnectionRecord[]): Promise<GitConnectionRecord[]> {
  await host.putSettings({ gitConnections: list });
  return asGitList(await host.getSettings());
}

async function testConnectionRecord(connection: GitConnectionRecord): Promise<{ ok: boolean; username: string; code: string }> {
  const result = await testGitlabConnection(connection);
  return { ok: result.ok === true, username: result.username || '', code: result.ok ? '' : (result.code || 'unknown') };
}

function catalogStatus(err: { status?: unknown }): number {
  const status = Number(err?.status);
  return Number.isFinite(status) && status >= 400 ? status : 500;
}

function sendCatalog(sendV2: SendV2Fn, res: ServerResponse, pathname: string, method: string, lang: Lang, err: { status?: unknown; message?: unknown; catalogCode?: unknown }): void {
  const status = catalogStatus(err);
  if (status >= 500) {
    sendV2(res, pathname, method, 500, { error: 'server error', code: 'E_INTERNAL' } satisfies V2Error);
    return;
  }
  sendV2(res, pathname, method, status, catalogErrorView(lang, err));
}

function createdWorkspaceView(ws: WorkspaceRecord): Workspace {
  return workspaceView({ workspace: ws, conversations: [] });
}

export async function loadExtensionsSnapshot(host: ExtensionsHost): Promise<ExtensionsSnapshot> {
  const settings = await host.getSettings();
  const plugins = await describePlugins(host.pluginDirs, settings.plugins || {});
  const skills = await listSkills(host.skillDirs, settings.skills || {}, host.userSkills);
  const connections = asGitList(settings).map((item) => publicGitConnection(item));
  return { plugins, skills, connections };
}

export async function handleExtensionsApi(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  method: string;
  sendV2: SendV2Fn;
  readObjectBody: ReadObjectBodyFn;
  host?: ExtensionsHost;
  onSidebarChanged?: () => void;
  onExtensionsChanged?: () => void;
}): Promise<boolean> {
  const { req, res, url, pathname, method, sendV2, readObjectBody } = opts;
  const host = opts.host;
  const lang = requestLang(url);

  const isExtensionsPath = pathname === '/api/v2/workspaces' && method === 'POST'
    || pathname === '/api/v2/workspace-root'
    || pathname === '/api/v2/workspace-root/dirs'
    || pathname.startsWith('/api/v2/git/connections')
    || pathname === '/api/v2/plugins'
    || pathname.startsWith('/api/v2/plugins/')
    || pathname === '/api/v2/skills'
    || pathname.startsWith('/api/v2/skills/');
  if (!isExtensionsPath) return false;

  if (!host) {
    sendV2(res, pathname, method, 500, { error: 'store not ready', code: 'E_INTERNAL' } satisfies V2Error);
    return true;
  }

  if (method === 'POST' && pathname === '/api/v2/workspaces') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      sendV2(res, pathname, method, 400, { error: phrase(lang, 'ws_name_required'), code: 'E_BAD_REQUEST' } satisfies V2Error);
      return true;
    }
    const source = typeof body.source === 'string' ? body.source.trim() : '';
    if (source !== 'local' && source !== 'git') {
      sendV2(res, pathname, method, 400, { error: phrase(lang, 'ws_err_generic'), code: 'E_BAD_REQUEST' } satisfies V2Error);
      return true;
    }
    if (source === 'git') {
      const id = randomUUID();
      const dest = path.join(host.dataDir, 'workspaces', id, 'repo');
      try {
        const planned = await host.planWorkspaceGit(body);
        let gitUrl = planned.gitUrl;
        let branch = planned.branch || '';
        const connection = usesConnectionClone(planned.connection, gitUrl) ? planned.connection : null;
        try {
          await cloneRepo({ url: gitUrl, branch, dest, connection });
        } catch (err) {
          if (connection && err && typeof err === 'object' && !(err as { via?: unknown }).via) {
            (err as { via?: string }).via = 'connection';
          }
          throw err;
        }
        gitUrl = stripGitUrlCredentials(gitUrl);
        const ws = await host.createWorkspace({
          id,
          name,
          path: dest,
          source: 'git',
          gitUrl,
          branch: branch || null,
          rootPath: dest,
          worktrees: [],
        });
        opts.onSidebarChanged?.();
        sendV2(res, pathname, method, 201, createdWorkspaceView(ws));
      } catch (err) {
        const status = Number((err as { status?: number })?.status) || 400;
        if (status === 404) {
          sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
          return true;
        }
        sendV2(res, pathname, method, status >= 400 ? status : 400, gitCloneFailureView(lang, err as { message?: unknown; gitCode?: unknown; detail?: unknown; via?: unknown }));
      }
      return true;
    }
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!rawPath) {
      const id = randomUUID();
      const dest = path.join(host.dataDir, 'workspaces', id, 'repo');
      await mkdir(dest, { recursive: true });
      const ws = await host.createWorkspace({
        id,
        name,
        path: dest,
        source: 'local',
        rootPath: dest,
        worktrees: [],
      });
      opts.onSidebarChanged?.();
      sendV2(res, pathname, method, 201, createdWorkspaceView(ws));
      return true;
    }
    let resolved: string;
    try {
      resolved = await resolveAllowedWorkspacePath(rawPath, { dataDir: host.dataDir });
    } catch (err) {
      const status = Number((err as { status?: number })?.status) || 400;
      sendV2(res, pathname, method, status, pathErrorView(lang, err as { message?: unknown }, defaultWorkspaceRoot()));
      return true;
    }
    const ws = (await host.restoreWorkspaceByPath(resolved, name))
      || await host.createWorkspace({ name, path: resolved, source: 'local', rootPath: resolved, worktrees: [] });
    opts.onSidebarChanged?.();
    sendV2(res, pathname, method, 201, createdWorkspaceView(ws));
    return true;
  }

  if (method === 'GET' && pathname === '/api/v2/workspace-root') {
    sendV2(res, pathname, method, 200, { root: defaultWorkspaceRoot() });
    return true;
  }

  if (method === 'GET' && pathname === '/api/v2/workspace-root/dirs') {
    try {
      const listed = await listBrowsableDirs(url.searchParams.get('path'));
      sendV2(res, pathname, method, 200, workspaceDirsView(listed));
    } catch (err) {
      const status = Number((err as { status?: number })?.status) || 400;
      sendV2(res, pathname, method, status, pathErrorView(lang, err as { message?: unknown }, defaultWorkspaceRoot()));
    }
    return true;
  }

  if (pathname.startsWith('/api/v2/git/connections')) {
    return handleGit(opts, host, lang);
  }
  if (pathname === '/api/v2/plugins' || pathname.startsWith('/api/v2/plugins/')) {
    return handlePlugins(opts, host, lang);
  }
  if (pathname === '/api/v2/skills' || pathname.startsWith('/api/v2/skills/')) {
    return handleSkills(opts, host, lang);
  }
  return false;
}

async function handleGit(
  opts: Parameters<typeof handleExtensionsApi>[0],
  host: ExtensionsHost,
  lang: Lang,
): Promise<boolean> {
  const { req, res, url, pathname, method, sendV2, readObjectBody } = opts;

  if (pathname === '/api/v2/git/connections' && method === 'GET') {
    const list = asGitList(await host.getSettings());
    sendV2(res, pathname, method, 200, {
      connections: list.map((item) => gitConnectionView(lang, publicGitConnection(item))),
    });
    return true;
  }
  if (pathname === '/api/v2/git/connections' && method === 'POST') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    const list = asGitList(await host.getSettings());
    if (list.length >= MAX_CONNECTIONS) {
      sendV2(res, pathname, method, 400, {
        error: phrase(lang, 'git_conn_too_many'),
        errors: ['too many connections'],
      });
      return true;
    }
    const built = createGitConnection(body) as GitBuilt;
    if (!built.ok) {
      sendV2(res, pathname, method, 400, {
        error: phrase(lang, 'git_conn_invalid'),
        errors: built.errors,
      });
      return true;
    }
    list.push(built.value);
    await saveConnections(host, list);
    opts.onExtensionsChanged?.();
    sendV2(res, pathname, method, 201, gitConnectionView(lang, publicGitConnection(built.value)));
    return true;
  }
  if (pathname === '/api/v2/git/connections/test' && method === 'POST') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    let connection: GitConnectionRecord;
    if (body.id) {
      const current = asGitList(await host.getSettings()).find((item) => item.id === String(body.id));
      if (!current) {
        sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
        return true;
      }
      const updated = updateGitConnection(current, body) as GitBuilt;
      if (!updated.ok) {
        const code = updated.errors.includes('token required') ? 'auth_failed' : 'unknown';
        sendV2(res, pathname, method, 200, gitTestResultView(lang, { ok: false, code }));
        return true;
      }
      connection = updated.value;
    } else {
      const built = createGitConnection(body) as GitBuilt;
      if (!built.ok) {
        const code = built.errors.includes('token required') ? 'auth_failed' : 'unknown';
        sendV2(res, pathname, method, 200, gitTestResultView(lang, { ok: false, code }));
        return true;
      }
      connection = built.value;
    }
    const result = await testConnectionRecord(connection);
    sendV2(res, pathname, method, 200, gitTestResultView(lang, result));
    return true;
  }

  let match = /^\/api\/v2\/git\/connections\/([^/]+)\/projects\/([^/]+)\/branches$/.exec(pathname);
  if (match && method === 'GET') {
    const connectionId = decodeURIComponent(match[1]);
    const projectId = decodeURIComponent(match[2]);
    const connection = asGitList(await host.getSettings()).find((item) => item.id === connectionId);
    if (!connection) {
      sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
      return true;
    }
    const result = await listGitlabBranches(connection, projectId);
    if (!result.ok) {
      sendV2(res, pathname, method, 400, gitCloneFailureView(lang, {
        message: 'git clone failed',
        gitCode: result.code || 'unknown',
        via: 'connection',
      }));
      return true;
    }
    sendV2(res, pathname, method, 200, {
      branches: result.branches,
      defaultBranch: result.defaultBranch || '',
    });
    return true;
  }
  match = /^\/api\/v2\/git\/connections\/([^/]+)\/projects$/.exec(pathname);
  if (match && method === 'GET') {
    const connectionId = decodeURIComponent(match[1]);
    const connection = asGitList(await host.getSettings()).find((item) => item.id === connectionId);
    if (!connection) {
      sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
      return true;
    }
    const result = await listGitlabProjects(connection, url.searchParams.get('search') || '');
    if (!result.ok) {
      sendV2(res, pathname, method, 400, gitCloneFailureView(lang, {
        message: 'git clone failed',
        gitCode: result.code || 'unknown',
        via: 'connection',
      }));
      return true;
    }
    sendV2(res, pathname, method, 200, { projects: result.projects });
    return true;
  }
  match = /^\/api\/v2\/git\/connections\/([^/]+)\/test$/.exec(pathname);
  if (match && method === 'POST') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    const id = decodeURIComponent(match[1]);
    const list = asGitList(await host.getSettings());
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) {
      sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
      return true;
    }
    const result = await testConnectionRecord(list[index]);
    list[index] = recordGitTest(list[index], result);
    await saveConnections(host, list);
    opts.onExtensionsChanged?.();
    sendV2(res, pathname, method, 200, gitTestResultView(lang, result, publicGitConnection(list[index])));
    return true;
  }
  match = /^\/api\/v2\/git\/connections\/([^/]+)$/.exec(pathname);
  if (match && method === 'PATCH') {
    const id = decodeURIComponent(match[1]);
    const list = asGitList(await host.getSettings());
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) {
      sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
      return true;
    }
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    const updated = updateGitConnection(list[index], body) as GitBuilt;
    if (!updated.ok) {
      sendV2(res, pathname, method, 400, {
        error: phrase(lang, 'git_conn_invalid'),
        errors: updated.errors,
      });
      return true;
    }
    list[index] = updated.value;
    await saveConnections(host, list);
    opts.onExtensionsChanged?.();
    sendV2(res, pathname, method, 200, gitConnectionView(lang, publicGitConnection(updated.value)));
    return true;
  }
  if (match && method === 'DELETE') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    const id = decodeURIComponent(match[1]);
    const list = asGitList(await host.getSettings());
    if (!list.some((item) => item.id === id)) {
      sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
      return true;
    }
    await saveConnections(host, list.filter((item) => item.id !== id));
    opts.onExtensionsChanged?.();
    sendV2(res, pathname, method, 200, { ok: true as const, id });
    return true;
  }
  return false;
}

async function handlePlugins(
  opts: Parameters<typeof handleExtensionsApi>[0],
  host: ExtensionsHost,
  lang: Lang,
): Promise<boolean> {
  const { req, res, pathname, method, sendV2, readObjectBody } = opts;

  if (pathname === '/api/v2/plugins' && method === 'GET') {
    const settings = await host.getSettings();
    const plugins = await describePlugins(host.pluginDirs, settings.plugins || {});
    sendV2(res, pathname, method, 200, { plugins: plugins.map((plugin) => pluginView(lang, plugin)) });
    return true;
  }
  if (pathname === '/api/v2/plugins' && method === 'POST') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    try {
      const settings = await host.getSettings();
      const current = await describePlugins(host.pluginDirs, settings.plugins || {});
      const existingToolNames = new Set(BUILTIN_TOOLS);
      for (const plugin of current) {
        if (plugin.enabled && plugin.loaded) {
          for (const tool of plugin.tools || []) existingToolNames.add(tool.name);
        }
      }
      const installed = await installFromPath(body?.path, host.userPlugins, {
        existingIds: new Set(current.map((plugin) => plugin.id)),
        existingToolNames,
        baseDir: host.rootDir,
      });
      await host.putSettings({ plugins: { [installed.id]: true } });
      await host.reloadPlugins();
      opts.onExtensionsChanged?.();
      sendV2(res, pathname, method, 201, pluginView(lang, installed));
    } catch (err) {
      sendCatalog(sendV2, res, pathname, method, lang, err as { status?: unknown; message?: unknown; catalogCode?: unknown });
    }
    return true;
  }
  const match = /^\/api\/v2\/plugins\/([^/]+)$/.exec(pathname);
  if (match && method === 'PATCH') {
    const id = decodeURIComponent(match[1]);
    if (!PLUGIN_ID.test(id)) {
      sendV2(res, pathname, method, 400, catalogErrorView(lang, { catalogCode: 'err_plugin_invalid', message: 'invalid plugin id' }));
      return true;
    }
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    const settings = await host.getSettings();
    const current = await describePlugins(host.pluginDirs, settings.plugins || {});
    if (!current.some((plugin) => plugin.id === id)) {
      sendV2(res, pathname, method, 404, catalogErrorView(lang, { catalogCode: 'err_plugin_not_found', message: 'plugin not found' }));
      return true;
    }
    const enabled = body?.enabled !== false;
    await host.putSettings({ plugins: { [id]: enabled } });
    await host.reloadPlugins();
    const next = await describePlugins(host.pluginDirs, (await host.getSettings()).plugins || {});
    opts.onExtensionsChanged?.();
    const found = next.find((plugin) => plugin.id === id) || { id, enabled, name: id, description: '', version: '', source: 'local', loaded: false, error: null, errorCode: null, tools: [] };
    sendV2(res, pathname, method, 200, pluginView(lang, found));
    return true;
  }
  return false;
}

async function handleSkills(
  opts: Parameters<typeof handleExtensionsApi>[0],
  host: ExtensionsHost,
  lang: Lang,
): Promise<boolean> {
  const { req, res, pathname, method, sendV2, readObjectBody } = opts;

  if (pathname === '/api/v2/skills' && method === 'GET') {
    const settings = await host.getSettings();
    const skills = await listSkills(host.skillDirs, settings.skills || {}, host.userSkills);
    sendV2(res, pathname, method, 200, { skills: skills.map((skill) => skillView(skill)) });
    return true;
  }
  if (pathname === '/api/v2/skills' && method === 'POST') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    try {
      const existing = await listSkillRecords(host.skillDirs);
      const created = await createSkill(host.userSkills, body || {}, new Set(existing.map((skill) => skill.id)));
      await host.putSettings({ skills: { [created.id]: true } });
      const list = await listSkills(host.skillDirs, (await host.getSettings()).skills || {}, host.userSkills);
      opts.onExtensionsChanged?.();
      sendV2(res, pathname, method, 201, skillView(list.find((skill) => skill.id === created.id) || created));
    } catch (err) {
      sendCatalog(sendV2, res, pathname, method, lang, err as { status?: unknown; message?: unknown; catalogCode?: unknown });
    }
    return true;
  }
  const match = /^\/api\/v2\/skills\/([^/]+)$/.exec(pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  if (method === 'DELETE') {
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    try {
      await deleteSkill(host.skillDirs, host.userSkills, id);
      opts.onExtensionsChanged?.();
      sendV2(res, pathname, method, 200, { ok: true as const, id });
    } catch (err) {
      sendCatalog(sendV2, res, pathname, method, lang, err as { status?: unknown; message?: unknown; catalogCode?: unknown });
    }
    return true;
  }
  if (method === 'PUT' || method === 'PATCH') {
    if (!SKILL_ID.test(id)) {
      sendV2(res, pathname, method, 400, catalogErrorView(lang, { catalogCode: 'err_skill_invalid', message: 'invalid skill id' }));
      return true;
    }
    const body = await readObjectBody(req, res, pathname, method);
    if (!body) return true;
    try {
      const hasContent = body?.name != null || body?.description != null || body?.body != null;
      if (hasContent) await updateSkill(host.skillDirs, host.userSkills, id, body || {});
      if (body?.enabled != null || !hasContent) {
        const records = await listSkillRecords(host.skillDirs);
        if (!records.some((skill) => skill.id === id)) {
          sendV2(res, pathname, method, 404, catalogErrorView(lang, { catalogCode: 'err_skill_not_found', message: 'skill not found' }));
          return true;
        }
        if (body?.enabled != null) {
          await host.putSettings({ skills: { [id]: body.enabled !== false } });
        }
      }
      const list = await listSkills(host.skillDirs, (await host.getSettings()).skills || {}, host.userSkills);
      const skill = list.find((item) => item.id === id);
      if (!skill) {
        sendV2(res, pathname, method, 404, catalogErrorView(lang, { catalogCode: 'err_skill_not_found', message: 'skill not found' }));
        return true;
      }
      opts.onExtensionsChanged?.();
      sendV2(res, pathname, method, 200, skillView(skill));
    } catch (err) {
      sendCatalog(sendV2, res, pathname, method, lang, err as { status?: unknown; message?: unknown; catalogCode?: unknown });
    }
    return true;
  }
  return false;
}
