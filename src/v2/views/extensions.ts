/** Plugin / Skill / GitConnection views and failure sentences (ARCHITECTURE_V2.md §6.3, §5.4). */

import { hasPhrase, phrase, type Lang } from '../phrases/index.ts';
import type { components } from '../contract.gen.ts';

export type Plugin = components['schemas']['Plugin'];
export type Skill = components['schemas']['Skill'];
export type GitConnection = components['schemas']['GitConnection'];
export type GitConnectionLastTest = components['schemas']['GitConnectionLastTest'];
export type GitTestResult = components['schemas']['GitTestResult'];
export type WorkspaceRoot = components['schemas']['WorkspaceRoot'];
export type WorkspaceDirs = components['schemas']['WorkspaceDirs'];
export type PathNotAllowed = components['schemas']['PathNotAllowed'];
export type GitCloneFailure = components['schemas']['GitCloneFailure'];
export type CatalogError = components['schemas']['CatalogError'];

export type RawPlugin = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  version?: unknown;
  source?: unknown;
  enabled?: unknown;
  loaded?: unknown;
  error?: unknown;
  errorCode?: unknown;
  tools?: unknown;
};

export type RawSkill = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  version?: unknown;
  source?: unknown;
  enabled?: unknown;
  deletable?: unknown;
};

export type RawGitConnection = {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  token?: unknown;
  hasToken?: unknown;
  allowHttp?: unknown;
  caFile?: unknown;
  lastTest?: unknown;
};

export type RawLastTest = {
  ok?: unknown;
  username?: unknown;
  error?: unknown;
  at?: unknown;
};

const GIT_IMPORT_CODE_KEYS: Record<string, string> = {
  git_not_found: 'ws_err_git_not_found',
  auth_failed: 'ws_err_git_auth',
  cert_failed: 'ws_err_git_cert',
  repo_not_found: 'ws_err_git_repo',
  branch_not_found: 'ws_err_git_branch',
  network: 'ws_err_git_network',
  timeout: 'ws_err_git_timeout',
  unknown: 'ws_err_git_unknown',
};

const GIT_CONN_CLONE_KEYS: Record<string, string> = {
  auth_failed: 'ws_err_conn_auth',
  cert_failed: 'ws_err_conn_cert',
  repo_not_found: 'ws_err_conn_repo',
  branch_not_found: 'ws_err_conn_branch',
  network: 'ws_err_conn_network',
  timeout: 'ws_err_conn_timeout',
  unknown: 'ws_err_conn_unknown',
  http_not_allowed: 'ws_err_conn_http',
  host_mismatch: 'ws_err_conn_host',
  git_not_found: 'ws_err_conn_git',
  not_gitlab: 'ws_err_conn_not_gitlab',
};

const GIT_TEST_KEYS: Record<string, string> = {
  auth_failed: 'git_test_auth',
  cert_failed: 'git_test_cert',
  network: 'git_test_network',
  timeout: 'git_test_timeout',
  unknown: 'git_test_unknown',
  http_not_allowed: 'git_test_http',
  not_gitlab: 'git_test_unknown',
};

function asString(value: unknown): string {
  if (value == null) return '';
  return String(value);
}

export function pluginFailureText(lang: Lang, code: unknown, detail: unknown): string {
  const text = asString(detail).trim();
  const missingTool = text.match(/^tool ([a-z][a-z0-9_]*) is not exported$/);
  if (missingTool) return phrase(lang, 'err_plugin_tool_missing', { name: missingTool[1] });
  if (text === 'plugin main module was not found' || text.startsWith('plugin main must be a relative .mjs')) {
    return phrase(lang, 'err_plugin_main_missing');
  }
  if (text === 'plugin.json is not valid JSON') return phrase(lang, 'err_plugin_json');
  const taken = text.match(/^tool ([a-z][a-z0-9_]*) is already registered$/);
  if (taken) return phrase(lang, 'err_plugin_tool_taken', { name: taken[1] });
  const key = asString(code).trim();
  if (key && hasPhrase(lang, key)) {
    const translated = phrase(lang, key);
    if (text && (key === 'err_plugin_not_loadable' || key === 'err_plugin_invalid') && !translated.includes(text)) {
      return `${translated} — ${text}`;
    }
    return translated;
  }
  return text;
}

export function catalogErrorView(lang: Lang, err: { message?: unknown; catalogCode?: unknown; status?: unknown }): CatalogError {
  const code = asString(err.catalogCode).trim();
  const raw = asString(err.message).trim();
  let text = '';
  if (code && (code.startsWith('err_plugin_') || code.startsWith('err_skill_'))) {
    text = pluginFailureText(lang, code, raw);
  } else if (code && hasPhrase(lang, code)) {
    text = phrase(lang, code);
  }
  if (!text) text = raw;
  if (!text) {
    text = phrase(lang, code.startsWith('err_skill_') ? 'err_skill_save' : 'err_plugin_update');
  }
  const body: CatalogError = { error: text };
  if (code) body.code = code;
  return body;
}

export function pluginView(lang: Lang, plugin: RawPlugin): Plugin {
  const errorCode = plugin.errorCode == null || plugin.errorCode === '' ? null : asString(plugin.errorCode);
  const rawError = plugin.error == null || plugin.error === '' ? null : asString(plugin.error);
  const tools = Array.isArray(plugin.tools)
    ? plugin.tools.map((tool) => {
      const row = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool as { name?: unknown; description?: unknown } : {};
      return { name: asString(row.name), description: asString(row.description) };
    })
    : [];
  return {
    id: asString(plugin.id),
    name: asString(plugin.name),
    description: asString(plugin.description),
    version: asString(plugin.version),
    source: asString(plugin.source) || 'local',
    enabled: plugin.enabled !== false,
    loaded: Boolean(plugin.loaded),
    error: rawError || errorCode ? pluginFailureText(lang, errorCode, rawError) : null,
    errorCode,
    tools,
  };
}

export function skillView(skill: RawSkill): Skill {
  return {
    id: asString(skill.id),
    name: asString(skill.name),
    description: asString(skill.description),
    version: asString(skill.version),
    source: asString(skill.source) || 'local',
    enabled: skill.enabled !== false,
    deletable: skill.deletable === true,
  };
}

export function gitTestStatusText(lang: Lang, code: string, ok: boolean): string {
  if (ok) return phrase(lang, 'git_test_ok');
  if (code === 'name') return phrase(lang, 'git_err_name');
  if (code === 'url') return phrase(lang, 'git_err_url');
  if (code === 'token') return phrase(lang, 'git_err_token');
  const key = GIT_TEST_KEYS[code] || 'git_test_unknown';
  return phrase(lang, key);
}

export function gitLastTestView(lang: Lang, lastTest: unknown): GitConnectionLastTest | null {
  if (!lastTest || typeof lastTest !== 'object' || Array.isArray(lastTest)) return null;
  const row = lastTest as RawLastTest;
  const ok = row.ok === true;
  const error = ok ? '' : asString(row.error);
  return {
    ok,
    username: ok ? asString(row.username) : '',
    error,
    errorText: gitTestStatusText(lang, error || (ok ? '' : 'unknown'), ok),
    at: asString(row.at),
  };
}

export function gitConnectionView(lang: Lang, conn: RawGitConnection): GitConnection {
  const kindRaw = asString(conn.kind);
  const kind: GitConnection['kind'] = kindRaw === 'gitlab-com' || kindRaw === 'other' ? kindRaw : 'gitlab-self';
  return {
    id: asString(conn.id),
    name: asString(conn.name),
    kind,
    baseUrl: asString(conn.baseUrl),
    token: asString(conn.token),
    hasToken: conn.hasToken === true,
    allowHttp: conn.allowHttp === true,
    caFile: asString(conn.caFile),
    lastTest: gitLastTestView(lang, conn.lastTest),
  };
}

export function gitTestResultView(
  lang: Lang,
  result: { ok: boolean; username?: string; code?: string },
  connection?: RawGitConnection | null,
): GitTestResult {
  const ok = result.ok === true;
  const code = ok ? '' : asString(result.code || 'unknown');
  const body: GitTestResult = {
    ok,
    username: ok ? asString(result.username) : '',
    code: ok ? '' : code,
    statusText: gitTestStatusText(lang, ok ? '' : code, ok),
  };
  if (connection) body.connection = gitConnectionView(lang, connection);
  return body;
}

export function gitCloneFailureView(
  lang: Lang,
  err: { message?: unknown; gitCode?: unknown; detail?: unknown; via?: unknown },
): GitCloneFailure {
  const code = asString(err.gitCode);
  const via = err.via == null || err.via === '' ? '' : asString(err.via);
  const raw = asString(err.message);
  const connectionScoped = via === 'connection'
    || code === 'http_not_allowed'
    || code === 'host_mismatch'
    || code === 'not_gitlab';
  let text: string;
  if (connectionScoped) {
    text = phrase(lang, GIT_CONN_CLONE_KEYS[code] || 'ws_err_conn_unknown');
  } else if (code && GIT_IMPORT_CODE_KEYS[code]) {
    text = phrase(lang, GIT_IMPORT_CODE_KEYS[code]);
    if (code === 'unknown') {
      const detail = asString(err.detail).trim();
      if (detail) text = `${text}\n${detail}`;
    }
  } else if (/invalid gitUrl/i.test(raw)) {
    text = phrase(lang, 'ws_err_git_url');
  } else if (/invalid branch/i.test(raw)) {
    text = phrase(lang, 'ws_err_branch');
  } else if (/clone failed/i.test(raw)) {
    text = phrase(lang, 'ws_err_clone');
  } else if (/name required/i.test(raw)) {
    text = phrase(lang, 'ws_name_required');
  } else if (/connection required/i.test(raw)) {
    text = phrase(lang, 'ws_err_generic');
  } else {
    text = phrase(lang, 'ws_err_generic');
  }
  const body: GitCloneFailure = { error: text };
  if (code) body.code = code;
  if (code === 'unknown') {
    const detail = asString(err.detail).trim();
    if (detail) body.detail = detail.slice(0, 800);
  }
  if (via) body.via = via;
  return body;
}

export function pathErrorView(
  lang: Lang,
  err: { message?: unknown; code?: unknown },
  allowedRoot: string,
): PathNotAllowed {
  const raw = asString(err.message);
  let text: string;
  if (/not under an allowed workspace root|path is not allowed|path is forbidden/i.test(raw)) {
    text = allowedRoot ? phrase(lang, 'ws_err_path_root', { root: allowedRoot }) : phrase(lang, 'ws_err_path');
  } else if (/^path\b/i.test(raw) || /path is /i.test(raw)) {
    text = phrase(lang, 'ws_err_path');
  } else {
    text = phrase(lang, 'ws_err_generic');
  }
  return {
    error: text,
    code: 'E_PATH',
    allowedRoot,
  };
}

export function workspaceDirsView(raw: {
  root?: unknown;
  path?: unknown;
  parent?: unknown;
  selectable?: unknown;
  git?: unknown;
  entries?: unknown;
  truncated?: unknown;
}): WorkspaceDirs {
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((item) => {
      const row = item && typeof item === 'object' && !Array.isArray(item)
        ? item as { name?: unknown; path?: unknown; git?: unknown }
        : {};
      return {
        name: asString(row.name),
        path: asString(row.path),
        git: row.git === true,
      };
    })
    : [];
  return {
    root: asString(raw.root),
    path: asString(raw.path),
    parent: raw.parent == null ? null : asString(raw.parent),
    selectable: raw.selectable !== false,
    git: raw.git === true,
    entries,
    truncated: raw.truncated === true,
  };
}
