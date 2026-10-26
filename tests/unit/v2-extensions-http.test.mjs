import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { phrase } from '../../src/v2/phrases/index.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-ext-http-token';

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: token ? v2Headers(token) : {} });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text, headers: res.headers };
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

function nativeReal(p) {
  return realpathSync.native(p);
}

async function writePlugin(dir, id, toolName, { exportTool = true } = {}) {
  const folder = path.join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'plugin.json'), `${JSON.stringify({
    id,
    name: id,
    description: `${id} tool`,
    version: '0.1.0',
    source: 'local',
    main: 'index.mjs',
    tools: [{ name: toolName, description: `Run ${toolName}`, parameters: { type: 'object', properties: {} } }],
  }, null, 2)}\n`);
  const source = exportTool
    ? `export async function ${toolName}() {\n  return { output: '${toolName}', status: 'completed' };\n}\n`
    : 'export async function other() { return { output: "nope", status: "completed" }; }\n';
  await writeFile(path.join(folder, 'index.mjs'), source);
  return folder;
}

test('POST /api/v2/workspaces local empty, path out of bounds, git file: rejected', { timeout: 40_000 }, async () => {
  const wsRoot = await mkdtemp(path.join(tmpdir(), 'weft-v2-wsroot-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'weft-v2-outside-'));
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_WORKSPACE_ROOT: wsRoot },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const missingName = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, { source: 'local' });
    assert.equal(missingName.status, 400);
    assertChecked('/api/v2/workspaces', 'POST', 400, missingName.body);
    assert.equal(missingName.body.error, phrase('zh', 'ws_name_required'));

    const created = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'empty',
      source: 'local',
    });
    assert.equal(created.status, 201, created.text);
    assertChecked('/api/v2/workspaces', 'POST', 201, created.body);
    assert.equal(created.body.source, 'local');
    assert.equal(created.body.conversationCount, 0);
    assert.equal(created.body.gitUrl, null);

    const inside = path.join(wsRoot, 'app');
    await mkdir(inside);
    const local = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'from-path',
      source: 'local',
      path: inside,
    });
    assert.equal(local.status, 201, local.text);
    assert.equal(local.body.path, nativeReal(inside));

    const denied = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'nope',
      source: 'local',
      path: outside,
    });
    assert.equal(denied.status, 400, denied.text);
    assertChecked('/api/v2/workspaces', 'POST', 400, denied.body);
    assert.equal(denied.body.code, 'E_PATH');
    const configuredRoot = path.resolve(wsRoot);
    assert.equal(denied.body.error, phrase('zh', 'ws_err_path_root', { root: configuredRoot }));
    assert.equal(denied.body.allowedRoot, configuredRoot);

    const fileProto = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'file-git',
      source: 'git',
      gitUrl: `file://${path.join(outside, 'repo.git')}`,
    });
    assert.equal(fileProto.status, 400);
    assertChecked('/api/v2/workspaces', 'POST', 400, fileProto.body);
    assert.equal(fileProto.body.error, phrase('zh', 'ws_err_git_url'));
    assert.equal(String(fileProto.text).includes('file://'), false);

    const enDenied = await sendV2(srv.base, 'POST', '/api/v2/workspaces?lang=en', discovery.token, {
      name: 'nope-en',
      source: 'local',
      path: outside,
    });
    assert.equal(enDenied.status, 400);
    assert.equal(enDenied.body.error, phrase('en', 'ws_err_path_root', { root: path.resolve(wsRoot) }));

    const unauth = await sendV2(srv.base, 'POST', '/api/v2/workspaces', '', { name: 'x', source: 'local' });
    assert.equal(unauth.status, 401);
  } finally {
    await stopServer(srv);
  }
});

test('workspace-root listing stays inside the allowed root', { timeout: 40_000 }, async () => {
  const wsRoot = await mkdtemp(path.join(tmpdir(), 'weft-v2-browse-'));
  await mkdir(path.join(wsRoot, 'keep'));
  const outside = await mkdtemp(path.join(tmpdir(), 'weft-v2-browse-out-'));
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_WORKSPACE_ROOT: wsRoot },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const root = await getV2(srv.base, '/api/v2/workspace-root', discovery.token);
    assert.equal(root.status, 200);
    assertChecked('/api/v2/workspace-root', 'GET', 200, root.body);
    assert.equal(root.body.root, path.resolve(wsRoot));
    assert.equal(root.headers.get('weft-protocol'), PROTOCOL_VERSION);

    const dirs = await getV2(srv.base, '/api/v2/workspace-root/dirs', discovery.token);
    assert.equal(dirs.status, 200);
    assertChecked('/api/v2/workspace-root/dirs', 'GET', 200, dirs.body);
    const realRoot = nativeReal(wsRoot);
    assert.equal(dirs.body.root, realRoot);
    assert.deepEqual(dirs.body.entries.map((e) => e.name), ['keep']);
    assert.equal(dirs.body.entries[0].path, path.join(realRoot, 'keep'));

    const escaped = await getV2(
      srv.base,
      `/api/v2/workspace-root/dirs?path=${encodeURIComponent(outside)}`,
      discovery.token,
    );
    assert.equal(escaped.status, 400);
    assertChecked('/api/v2/workspace-root/dirs', 'GET', 400, escaped.body);
    assert.equal(escaped.body.code, 'E_PATH');
    assert.equal(escaped.body.error.includes(outside), false);
  } finally {
    await stopServer(srv);
  }
});

async function aliasedWorkspaceRoot() {
  const sys = nativeReal(tmpdir());
  const parent = /^\/(private\/)?var\//.test(sys) ? path.join(ROOT, 'data', 'test-tmp') : sys;
  await mkdir(parent, { recursive: true });
  const outside = await mkdtemp(path.join(parent, 'weft-v2-alias-out-'));
  let alias;
  let canonical;
  if (process.platform === 'win32') {
    const fromTmp = await mkdtemp(path.join(tmpdir(), 'weft-v2-short-'));
    canonical = nativeReal(fromTmp);
    if (fromTmp !== canonical) alias = fromTmp;
  }
  if (!alias) {
    canonical = nativeReal(await mkdtemp(path.join(parent, 'weft-v2-real-')));
    alias = path.join(parent, `weft-v2-ws-alias-${Date.now()}`);
    await symlink(canonical, alias, process.platform === 'win32' ? 'junction' : undefined);
  }
  await mkdir(path.join(canonical, 'inside'));
  assert.notEqual(alias, canonical);
  return { alias, canonical, outside };
}

test('alias WEFT_WORKSPACE_ROOT (8.3 or symlink) allows children and rejects outside', { timeout: 40_000 }, async () => {
  const { alias, canonical, outside } = await aliasedWorkspaceRoot();
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_WORKSPACE_ROOT: alias },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const inside = path.join(alias, 'inside');
    const created = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'from-alias',
      source: 'local',
      path: inside,
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.path, nativeReal(inside));
    assert.equal(created.body.path, nativeReal(path.join(canonical, 'inside')));

    const denied = await sendV2(srv.base, 'POST', '/api/v2/workspaces', discovery.token, {
      name: 'outside',
      source: 'local',
      path: outside,
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.code, 'E_PATH');

    const dirs = await getV2(srv.base, '/api/v2/workspace-root/dirs', discovery.token);
    assert.equal(dirs.status, 200);
    assert.equal(dirs.body.root, canonical);
    assert.deepEqual(dirs.body.entries.map((entry) => entry.name), ['inside']);
    assert.equal(dirs.body.entries[0].path, path.join(canonical, 'inside'));
  } finally {
    await stopServer(srv);
  }
});

test('plugins import, enable/disable, and same codes as the old API', { timeout: 40_000 }, async () => {
  const src = await mkdtemp(path.join(tmpdir(), 'weft-v2-plug-'));
  const folder = await writePlugin(src, 'word-count', 'word_count');
  const broken = await writePlugin(src, 'broken', 'broken_tool', { exportTool: false });
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const listed = await getV2(srv.base, '/api/v2/plugins', discovery.token);
    assert.equal(listed.status, 200);
    assertChecked('/api/v2/plugins', 'GET', 200, listed.body);
    const echo = listed.body.plugins.find((plugin) => plugin.id === 'echo');
    assert.equal(echo.loaded, true);
    assert.equal(echo.error, null);

    const oldGhost = await request(srv.base, 'POST', '/api/plugins', { name: 'ghost' }, TOKEN);
    const v2Ghost = await sendV2(srv.base, 'POST', '/api/v2/plugins', discovery.token, { name: 'ghost' });
    assert.equal(oldGhost.status, 400);
    assert.equal(v2Ghost.status, 400);
    assert.equal(oldGhost.body.code, v2Ghost.body.code);
    assert.equal(v2Ghost.body.code, 'err_plugin_path_required');
    assertChecked('/api/v2/plugins', 'POST', 400, v2Ghost.body);
    assert.equal(v2Ghost.body.error, phrase('zh', 'err_plugin_path_required'));

    const imported = await sendV2(srv.base, 'POST', '/api/v2/plugins', discovery.token, { path: folder });
    assert.equal(imported.status, 201, imported.text);
    assertChecked('/api/v2/plugins', 'POST', 201, imported.body);
    assert.equal(imported.body.id, 'word-count');
    assert.equal(imported.body.enabled, true);
    assert.equal(imported.body.loaded, true);

    const again = await sendV2(srv.base, 'POST', '/api/v2/plugins', discovery.token, { path: folder });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'err_plugin_exists');

    const fail = await sendV2(srv.base, 'POST', '/api/v2/plugins?lang=en', discovery.token, { path: broken });
    assert.equal(fail.status, 400);
    assert.equal(fail.body.code, 'err_plugin_not_loadable');
    assert.equal(fail.body.error, phrase('en', 'err_plugin_tool_missing', { name: 'broken_tool' }));

    const off = await sendV2(srv.base, 'PATCH', '/api/v2/plugins/echo', discovery.token, { enabled: false });
    assert.equal(off.status, 200, off.text);
    assertChecked('/api/v2/plugins/{id}', 'PATCH', 200, off.body);
    assert.equal(off.body.enabled, false);
    const oldOff = await request(srv.base, 'PUT', '/api/plugins/echo', { enabled: true }, TOKEN);
    assert.equal(oldOff.status, 200);
    assert.equal(oldOff.body.enabled, true);

    const missing = await sendV2(srv.base, 'PATCH', '/api/v2/plugins/no-such', discovery.token, { enabled: false });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'err_plugin_not_found');
  } finally {
    await stopServer(srv);
  }
});

test('skills create, patch, delete, and builtin cannot be removed', { timeout: 40_000 }, async () => {
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const listed = await getV2(srv.base, '/api/v2/skills', discovery.token);
    assert.equal(listed.status, 200);
    assertChecked('/api/v2/skills', 'GET', 200, listed.body);
    const builtin = listed.body.skills.find((skill) => skill.id === 'commit-message');
    assert.equal(builtin.enabled, true);
    assert.equal(builtin.deletable, false);

    const created = await sendV2(srv.base, 'POST', '/api/v2/skills', discovery.token, {
      name: '发布检查',
      description: '发版前',
      body: '先看测试再发版。',
    });
    assert.equal(created.status, 201, created.text);
    assertChecked('/api/v2/skills', 'POST', 201, created.body);
    assert.equal(created.body.enabled, true);
    assert.equal(created.body.deletable, true);

    const oldDup = await request(srv.base, 'POST', '/api/skills', {
      name: '发布检查',
      id: created.body.id,
      body: 'again',
    }, TOKEN);
    const v2Dup = await sendV2(srv.base, 'POST', '/api/v2/skills', discovery.token, {
      name: '发布检查',
      id: created.body.id,
      body: 'again',
    });
    assert.equal(oldDup.status, 409);
    assert.equal(v2Dup.status, 409);
    assert.equal(oldDup.body.code, v2Dup.body.code);
    assert.equal(v2Dup.body.code, 'err_skill_exists');

    const off = await sendV2(srv.base, 'PATCH', `/api/v2/skills/${created.body.id}`, discovery.token, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    const edited = await sendV2(srv.base, 'PUT', `/api/v2/skills/${created.body.id}`, discovery.token, {
      body: '只报告失败的测试。',
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.description, '发版前');

    const nameless = await sendV2(srv.base, 'POST', '/api/v2/skills?lang=en', discovery.token, { body: 'x' });
    assert.equal(nameless.status, 400);
    assert.equal(nameless.body.code, 'err_skill_name_required');
    assert.equal(nameless.body.error, phrase('en', 'err_skill_name_required'));

    const removed = await sendV2(srv.base, 'DELETE', `/api/v2/skills/${created.body.id}`, discovery.token, {});
    assert.equal(removed.status, 200);
    assertChecked(`/api/v2/skills/${created.body.id}`, 'DELETE', 200, removed.body);

    const oldBuiltin = await request(srv.base, 'DELETE', '/api/skills/commit-message', {}, TOKEN);
    const v2Builtin = await sendV2(srv.base, 'DELETE', '/api/v2/skills/commit-message', discovery.token, {});
    assert.equal(oldBuiltin.status, 403);
    assert.equal(v2Builtin.status, 403);
    assert.equal(oldBuiltin.body.code, v2Builtin.body.code);
    assert.equal(v2Builtin.body.code, 'err_skill_builtin');
    assert.equal(v2Builtin.body.error, phrase('zh', 'err_skill_builtin'));
  } finally {
    await stopServer(srv);
  }
});
