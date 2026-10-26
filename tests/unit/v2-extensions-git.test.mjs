import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGitlab } from '../helpers/fake-gitlab.mjs';
import { phrase } from '../../src/v2/phrases/index.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const execFileP = promisify(execFile);
const TOKEN = 'v2-ext-git-token';
const PAT = 'glpat-unit-secret-9k3q';
const BAD = 'glpat-unit-secret-bad1';
const PRIVATE_USER = 'importer';
const PRIVATE_PASS = 's3cr3t-token-value';

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: token ? v2Headers(token) : {} });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath, method, status, body);
  assert.equal(checked.ok, true, `${method} ${apiPath} ${status}: ${JSON.stringify(checked.errors)}\n${JSON.stringify(body)}`);
}

function assertNoSecret(text, secrets, label) {
  const raw = String(text || '');
  for (const secret of secrets) {
    assert.equal(raw.includes(secret), false, `${label} contains a token`);
  }
}

function readSettings(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT json FROM settings WHERE id = ?').get('app');
    return row ? JSON.parse(row.json) : null;
  } finally {
    db.close();
  }
}

async function findHttpBackend() {
  const { stdout } = await execFileP('git', ['--exec-path'], { windowsHide: true, timeout: 15_000 });
  const dir = stdout.trim();
  for (const name of ['git-http-backend', 'git-http-backend.exe']) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* try the other name */ }
  }
  throw new Error(`git-http-backend missing under ${dir}`);
}

function splitCgi(raw) {
  let idx = raw.indexOf('\r\n\r\n');
  if (idx >= 0) return [raw.subarray(0, idx).toString('latin1'), raw.subarray(idx + 4)];
  idx = raw.indexOf('\n\n');
  if (idx >= 0) return [raw.subarray(0, idx).toString('latin1'), raw.subarray(idx + 2)];
  return [raw.toString('latin1'), Buffer.alloc(0)];
}

function basicAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
  if (!match) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  return decoded.slice(0, split) === PRIVATE_USER && decoded.slice(split + 1) === PRIVATE_PASS;
}

async function startSmartGit() {
  const backend = await findHttpBackend();
  const root = await mkdtemp(path.join(tmpdir(), 'weft-v2-git-'));
  const src = path.join(root, 'src');
  const bare = path.join(root, 'repo.git');
  await mkdir(src);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Weft',
    GIT_AUTHOR_EMAIL: 'Weft@example.com',
    GIT_COMMITTER_NAME: 'Weft',
    GIT_COMMITTER_EMAIL: 'Weft@example.com',
  };
  const git = (args, cwd) => execFileP('git', args, { cwd, windowsHide: true, timeout: 20_000, env: gitEnv });
  await git(['init', '-b', 'main'], src);
  await writeFile(path.join(src, 'README.md'), 'hello\n');
  await git(['add', 'README.md'], src);
  await git(['-c', 'commit.gpgsign=false', '-c', 'user.name=Weft', '-c', 'user.email=Weft@example.com', 'commit', '-m', 'init'], src);
  await git(['clone', '--bare', src, bare]);

  function runCgi(req, pathInfo) {
    const u = new URL(req.url, 'http://127.0.0.1');
    return new Promise((resolve, reject) => {
      const child = spawn(backend, [], {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: pathInfo,
          QUERY_STRING: u.search.startsWith('?') ? u.search.slice(1) : '',
          REQUEST_METHOD: req.method || 'GET',
          CONTENT_TYPE: req.headers['content-type'] || '',
          CONTENT_LENGTH: req.headers['content-length'] || '',
          GATEWAY_INTERFACE: 'CGI/1.1',
          REMOTE_ADDR: '127.0.0.1',
          SERVER_NAME: '127.0.0.1',
          SERVER_PORT: '80',
          SERVER_PROTOCOL: 'HTTP/1.1',
          MSYS_NO_PATHCONV: '1',
          MSYS2_ARG_CONV_EXCL: '*',
        },
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', () => resolve({ out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8') }));
      req.pipe(child.stdin);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let pathInfo = u.pathname;
    if (pathInfo === '/private' || pathInfo.startsWith('/private/')) {
      if (!basicAuthorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"', 'Content-Type': 'text/plain' });
        res.end('Authentication failed');
        return;
      }
      pathInfo = pathInfo.slice('/private'.length) || '/';
    }
    let result;
    try {
      result = await runCgi(req, pathInfo);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.message);
      return;
    }
    const [head, body] = splitCgi(result.out);
    if (!head) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(result.err || 'cgi failed');
      return;
    }
    let status = 200;
    const headers = {};
    for (const line of head.split(/\r?\n/)) {
      const statusMatch = line.match(/^Status:\s+(\d+)/i);
      if (statusMatch) {
        status = Number(statusMatch[1]);
        continue;
      }
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    res.writeHead(status, headers);
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    root,
    port,
    url: `http://127.0.0.1:${port}/repo.git`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('git connections: CRUD, test, projects, branches match old codes and mask tokens', { timeout: 60_000 }, async () => {
  const gitlab = await startFakeGitlab({
    token: PAT,
    username: 'zhangsan',
    projects: [
      {
        id: 7,
        path: 'acme/widget',
        description: 'Widget service',
        defaultBranch: 'main',
        branches: [{ name: 'main', default: true }, { name: 'develop', default: false }],
      },
    ],
  });
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux', WEFT_RETRY_MAX: '2' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const empty = await getV2(srv.base, '/api/v2/git/connections', discovery.token);
    assert.equal(empty.status, 200);
    assertChecked('/api/v2/git/connections', 'GET', 200, empty.body);
    assert.deepEqual(empty.body.connections, []);

    const oldBad = await request(srv.base, 'POST', '/api/git/connections/test', {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: BAD,
      allowHttp: true,
    }, TOKEN);
    const v2Bad = await sendV2(srv.base, 'POST', '/api/v2/git/connections/test', discovery.token, {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: BAD,
      allowHttp: true,
    });
    assert.equal(oldBad.status, 200);
    assert.equal(v2Bad.status, 200);
    assert.equal(oldBad.body.code, v2Bad.body.code);
    assert.equal(v2Bad.body.ok, false);
    assert.equal(v2Bad.body.code, 'auth_failed');
    assert.equal(v2Bad.body.statusText, phrase('zh', 'git_test_auth'));
    assertChecked('/api/v2/git/connections/test', 'POST', 200, v2Bad.body);
    assertNoSecret(v2Bad.text, [PAT, BAD], 'unsaved test');

    const enBad = await sendV2(srv.base, 'POST', '/api/v2/git/connections/test?lang=en', discovery.token, {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: BAD,
      allowHttp: true,
    });
    assert.equal(enBad.body.statusText, phrase('en', 'git_test_auth'));

    const invalid = await sendV2(srv.base, 'POST', '/api/v2/git/connections', discovery.token, {
      kind: 'gitlab-self',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    assert.equal(invalid.status, 400);
    assertChecked('/api/v2/git/connections', 'POST', 400, invalid.body);
    assert.equal(invalid.body.errors.includes('name required'), true);

    const created = await sendV2(srv.base, 'POST', '/api/v2/git/connections', discovery.token, {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    assert.equal(created.status, 201, created.text);
    assertChecked('/api/v2/git/connections', 'POST', 201, created.body);
    assert.equal(created.body.token, '••••9k3q');
    assert.equal(created.body.hasToken, true);
    assert.equal(created.body.lastTest, null);
    assertNoSecret(created.text, [PAT, BAD], 'create response');
    const id = created.body.id;

    const listed = await getV2(srv.base, '/api/v2/git/connections', discovery.token);
    assert.equal(listed.body.connections[0].token, '••••9k3q');
    assertNoSecret(listed.text, [PAT], 'list');

    const stored = readSettings(srv.dataDir);
    assert.equal(stored.gitConnections[0].token, PAT);

    const tested = await sendV2(srv.base, 'POST', `/api/v2/git/connections/${id}/test`, discovery.token, {});
    assert.equal(tested.status, 200, tested.text);
    assertChecked(`/api/v2/git/connections/${id}/test`, 'POST', 200, tested.body);
    assert.equal(tested.body.ok, true);
    assert.equal(tested.body.username, 'zhangsan');
    assert.equal(tested.body.statusText, phrase('zh', 'git_test_ok'));
    assert.equal(tested.body.connection.token, '••••9k3q');
    assert.equal(tested.body.connection.lastTest.ok, true);
    assert.equal(tested.body.connection.lastTest.errorText, phrase('zh', 'git_test_ok'));
    assertNoSecret(tested.text, [PAT], 'saved test');

    const projects = await getV2(
      srv.base,
      `/api/v2/git/connections/${id}/projects?search=${encodeURIComponent('widget')}`,
      discovery.token,
    );
    assert.equal(projects.status, 200, projects.text);
    assertChecked(`/api/v2/git/connections/${id}/projects`, 'GET', 200, projects.body);
    assert.equal(projects.body.projects.length, 1);
    assert.equal(projects.body.projects[0].path, 'acme/widget');
    assert.equal(String(projects.body.projects[0].httpUrl).includes(PAT), false);

    const branches = await getV2(srv.base, `/api/v2/git/connections/${id}/projects/7/branches`, discovery.token);
    assert.equal(branches.status, 200, branches.text);
    assertChecked(`/api/v2/git/connections/${id}/projects/7/branches`, 'GET', 200, branches.body);
    const main = branches.body.branches.find((item) => item.name === 'main');
    const develop = branches.body.branches.find((item) => item.name === 'develop');
    assert.equal(main.default, true);
    assert.equal(develop.default, false);

    const renamed = await sendV2(srv.base, 'PATCH', `/api/v2/git/connections/${id}`, discovery.token, {
      name: '内网 GitLab 改名',
      token: '••••9k3q',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, '内网 GitLab 改名');
    assert.equal(readSettings(srv.dataDir).gitConnections[0].token, PAT);

    const other = await sendV2(srv.base, 'POST', '/api/v2/git/connections', discovery.token, {
      kind: 'other',
      name: '其它',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    const notGitlab = await getV2(srv.base, `/api/v2/git/connections/${other.body.id}/projects`, discovery.token);
    assert.equal(notGitlab.status, 400);
    assert.equal(notGitlab.body.code, 'not_gitlab');
    assert.equal(notGitlab.body.via, 'connection');
    assert.equal(notGitlab.body.error, phrase('zh', 'ws_err_conn_not_gitlab'));

    const missing = await getV2(srv.base, '/api/v2/git/connections/no-such/projects', discovery.token);
    assert.equal(missing.status, 404);

    const removed = await sendV2(srv.base, 'DELETE', `/api/v2/git/connections/${other.body.id}`, discovery.token, {});
    assert.equal(removed.status, 200);
    assertChecked(`/api/v2/git/connections/${other.body.id}`, 'DELETE', 200, removed.body);
    assertNoSecret(srv.logs(), [PAT, BAD], 'server log');
  } finally {
    await stopServer(srv);
    gitlab.close();
  }
});

test('git workspace import strips credentials and connection import uses the token', { timeout: 90_000 }, async () => {
  const git = await startSmartGit();
  const gitlab = await startFakeGitlab({
    token: PAT,
    username: 'zhangsan',
    withGit: true,
    projects: [
      {
        id: 7,
        path: 'acme/widget',
        description: 'Widget service',
        defaultBranch: 'main',
        branches: [{ name: 'main', default: true }],
      },
    ],
  });
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      WEFT_GIT_HTTP_HOSTS: '127.0.0.1',
      WEFT_RETRY_MAX: '2',
    },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const missing = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'missing-repo',
      source: 'git',
      gitUrl: `http://127.0.0.1:${git.port}/nope.git`,
    });
    assert.equal(missing.status, 400);
    assertChecked('/api/v2/workspaces', 'POST', 400, missing.body);
    assert.equal(missing.body.code, 'repo_not_found');
    assert.equal(missing.body.error, phrase('zh', 'ws_err_git_repo'));

    const blocked = await sendV2(srv.base, 'POST', '/api/v2/workspaces?lang=en', discovery.token, {
      name: 'blocked-http',
      source: 'git',
      gitUrl: 'http://gitlab.corp.local/group/repo.git',
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error, phrase('en', 'ws_err_git_url'));

    const created = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'token-repo',
      source: 'git',
      gitUrl: `http://${PRIVATE_USER}:${PRIVATE_PASS}@127.0.0.1:${git.port}/private/repo.git`,
    });
    assert.equal(created.status, 201, created.text);
    assertChecked('/api/v2/workspaces', 'POST', 201, created.body);
    assert.equal(created.body.source, 'git');
    assert.equal(created.body.gitUrl, `http://127.0.0.1:${git.port}/private/repo.git`);
    assertNoSecret(created.text, [PRIVATE_PASS, PAT], 'workspace with embedded credentials');
    const readme = await readFile(path.join(created.body.path, 'README.md'), 'utf8');
    assert.equal(readme.replace(/\r\n/g, '\n'), 'hello\n');
    const cfg = await readFile(path.join(created.body.path, '.git', 'config'), 'utf8');
    assert.equal(cfg.includes(PRIVATE_PASS), false);

    const conn = await sendV2(srv.base, 'POST', '/api/v2/git/connections', discovery.token, {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    assert.equal(conn.status, 201, conn.text);
    const imported = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'widget',
      source: 'git',
      connectionId: conn.body.id,
      projectId: 7,
      branch: 'main',
    });
    assert.equal(imported.status, 201, imported.text);
    assert.equal(imported.body.source, 'git');
    assert.equal(imported.body.branch, 'main');
    assert.match(imported.body.gitUrl, /\/acme\/widget\.git$/);
    assertNoSecret(imported.text, [PAT, BAD, PRIVATE_PASS], 'connection import');
    const widgetReadme = await readFile(path.join(imported.body.path, 'README.md'), 'utf8');
    assert.match(widgetReadme, /hello from acme\/widget/);
    const widgetCfg = await readFile(path.join(imported.body.path, '.git', 'config'), 'utf8');
    assert.equal(widgetCfg.includes(PAT), false);
    assert.doesNotMatch(widgetCfg, /authorization:\s*bearer/i);

    const patched = await sendV2(srv.base, 'PATCH', `/api/v2/git/connections/${conn.body.id}`, discovery.token, { token: BAD });
    assert.equal(patched.status, 200);
    const failed = await sendV2(srv.base, 'POST', '/api/v2/workspaces?lang=en', discovery.token, {
      name: 'widget-bad',
      source: 'git',
      connectionId: conn.body.id,
      projectId: 7,
    });
    assert.equal(failed.status, 400);
    assert.equal(failed.body.code, 'auth_failed');
    assert.equal(failed.body.via, 'connection');
    assert.equal(failed.body.error, phrase('en', 'ws_err_conn_auth'));
    assertNoSecret(failed.text, [PAT, BAD], 'clone error');
    assertNoSecret(srv.logs(), [PAT, BAD, PRIVATE_PASS], 'server log');
  } finally {
    await stopServer(srv);
    gitlab.close();
    await git.close();
  }
});
