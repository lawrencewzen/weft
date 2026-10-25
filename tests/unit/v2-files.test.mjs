import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import {
  contentVersion,
  emptyFileContent,
  fileNodeView,
  looksBinary,
  maxFileBytes,
  readWorkspaceFile,
  saveWorkspaceFile,
  workspaceTreeView,
  WORKSPACE_TREE_MAX_ENTRIES,
} from '../../src/v2/views/files.ts';
import { posixPath } from '../../src/v2/views/changes.ts';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'v2-files-token';

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
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function assertChecked(apiPath, method, status, body) {
  const checked = validateResponse(apiPath, method, status, body);
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
}

test('fileNodeView and posixPath use forward slashes for win32 input', () => {
  const win = path.win32.join('src', 'a', 'b.ts');
  assert.equal(posixPath(win), 'src/a/b.ts');
  assert.deepEqual(fileNodeView({ path: win, type: 'file' }), { path: 'src/a/b.ts', type: 'file' });
  assert.deepEqual(fileNodeView({ path: 'dir', type: 'dir' }), { path: 'dir', type: 'dir' });
});

test('looksBinary detects NUL and invalid UTF-8; contentVersion is sha256 prefix', () => {
  assert.equal(looksBinary(Buffer.from('hello')), false);
  assert.equal(looksBinary(Buffer.from([0x68, 0x00, 0x69])), true);
  assert.equal(looksBinary(Buffer.from([0xff, 0xfe, 0x00])), true);
  assert.equal(looksBinary(Buffer.from([0x80, 0x81])), true);
  const v = contentVersion('abc');
  assert.equal(v.length, 16);
  assert.match(v, /^[0-9a-f]{16}$/);
  assert.equal(contentVersion(Buffer.from('abc')), v);
  assert.equal(emptyFileContent('x.txt').version, contentVersion(Buffer.alloc(0)));
  assert.equal(maxFileBytes({}), 2 * 1024 * 1024);
  assert.equal(maxFileBytes({ WEFT_V2_MAX_FILE_BYTES: '64' }), 64);
});

test('workspaceTreeView truncates at 500 and keeps posix paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-tree-'));
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await writeFile(path.join(root, 'readme.md'), 'hi\n');
  await writeFile(path.join(root, 'sub', 'a.ts'), 'a\n');
  const small = await workspaceTreeView(root);
  assert.equal(small.truncated, false);
  assert.equal(small.entries.some((e) => e.path === 'readme.md' && e.type === 'file'), true);
  assert.equal(small.entries.some((e) => e.path === 'sub' && e.type === 'dir'), true);
  assert.equal(small.entries.some((e) => e.path === 'sub/a.ts' && e.type === 'file'), true);
  for (const entry of small.entries) assert.equal(entry.path.includes('\\'), false);

  const packed = await mkdtemp(path.join(tmpdir(), 'piw-v2-tree-max-'));
  const writes = [];
  for (let i = 0; i < WORKSPACE_TREE_MAX_ENTRIES + 10; i += 1) {
    writes.push(writeFile(path.join(packed, `f${String(i).padStart(4, '0')}.txt`), 'x'));
  }
  await Promise.all(writes);
  const big = await workspaceTreeView(packed);
  assert.equal(big.truncated, true);
  assert.equal(big.entries.length, WORKSPACE_TREE_MAX_ENTRIES);
});

test('readWorkspaceFile flags binary, tooLarge, directory, missing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-read-'));
  await mkdir(path.join(root, 'dir'), { recursive: true });
  await writeFile(path.join(root, 'ok.txt'), 'hello\n');
  await writeFile(path.join(root, 'nul.bin'), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(path.join(root, 'bad.bin'), Buffer.from([0xff, 0xfe, 0xfd]));
  await writeFile(path.join(root, 'big.txt'), 'abcdefghij');
  const env = { WEFT_V2_MAX_FILE_BYTES: '4' };

  const text = await readWorkspaceFile(root, 'ok.txt');
  assert.equal(text.binary, false);
  assert.equal(text.tooLarge, false);
  assert.equal(text.text, 'hello\n');
  assert.equal(text.version, contentVersion('hello\n'));

  const bin = await readWorkspaceFile(root, 'nul.bin');
  assert.equal(bin.binary, true);
  assert.equal(bin.text, null);

  const bad = await readWorkspaceFile(root, 'bad.bin');
  assert.equal(bad.binary, true);
  assert.equal(bad.text, null);

  const large = await readWorkspaceFile(root, 'big.txt', env);
  assert.equal(large.binary, false);
  assert.equal(large.tooLarge, true);
  assert.equal(large.text, null);
  assert.equal(large.size > 4, true);

  await assert.rejects(() => readWorkspaceFile(root, 'dir', env), (err) => err.code === 'EISDIR');
  await assert.rejects(() => readWorkspaceFile(root, 'missing.txt', env), (err) => err.code === 'ENOENT');
  await assert.rejects(() => readWorkspaceFile(root, '../secret', env), (err) => err.code === 'E_SANDBOX');
});

test('saveWorkspaceFile writes, conflicts, and skips check without baseVersion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-save-'));
  const first = await saveWorkspaceFile({ root, path: 'nested/a.txt', text: 'one\n' });
  assert.equal(first.path, 'nested/a.txt');
  assert.equal(first.version, contentVersion('one\n'));
  assert.equal(first.added > 0, true);

  const stale = saveWorkspaceFile({
    root,
    path: 'nested/a.txt',
    text: 'two\n',
    baseVersion: 'deadbeefdeadbeef',
  });
  await assert.rejects(stale, (err) => {
    assert.equal(err.code, 'E_CONFLICT');
    assert.equal(err.current.text, 'one\n');
    return true;
  });
  const still = await readWorkspaceFile(root, 'nested/a.txt');
  assert.equal(still.text, 'one\n');

  const ok = await saveWorkspaceFile({
    root,
    path: 'nested/a.txt',
    text: 'two\n',
    baseVersion: still.version,
  });
  assert.equal(ok.version, contentVersion('two\n'));

  const force = await saveWorkspaceFile({ root, path: 'nested/a.txt', text: 'three\n' });
  assert.equal(force.version, contentVersion('three\n'));
  const after = await readWorkspaceFile(root, 'nested/a.txt');
  assert.equal(after.text, 'three\n');

  await assert.rejects(
    () => saveWorkspaceFile({ root, path: '../x.txt', text: 'no' }),
    (err) => err.code === 'E_SANDBOX',
  );
});

test('GET/PUT /api/v2/workspaces/{id}/files and tree: contract, sandbox, binary, tooLarge, conflict', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux', WEFT_V2_MAX_FILE_BYTES: '32' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'v2-files' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const wid = ws.body.id;
    const root = ws.body.path;

    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.js'), 'const a = 1;\n');
    await writeFile(path.join(root, 'nul.bin'), Buffer.from([0x00, 0x61]));
    await writeFile(path.join(root, 'big.txt'), 'abcdefghijklmnopqrstuvwxyz0123456789');
    await mkdir(path.join(root, 'folder'), { recursive: true });
    await writeFile(path.join(root, '..', 'secret.txt'), 'outside\n');
    await symlink(path.join(root, '..', 'secret.txt'), path.join(root, 'escape.txt'));

    const tree = await getV2(srv.base, `/api/v2/workspaces/${wid}/tree`, discovery.token);
    assert.equal(tree.status, 200, tree.text);
    assert.equal(tree.headers.get('weft-protocol'), PROTOCOL_VERSION);
    assertChecked(`/api/v2/workspaces/${wid}/tree`, 'GET', 200, tree.body);
    assert.equal(tree.body.truncated, false);
    assert.equal(tree.body.entries.some((e) => e.path === 'src' && e.type === 'dir'), true);
    assert.equal(tree.body.entries.some((e) => e.path === 'src/app.js' && e.type === 'file'), true);
    for (const entry of tree.body.entries) assert.equal(entry.path.includes('\\'), false);

    const textFile = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('src/app.js')}`, discovery.token);
    assert.equal(textFile.status, 200, textFile.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 200, textFile.body);
    assert.equal(textFile.body.text, 'const a = 1;\n');
    assert.equal(textFile.body.binary, false);
    assert.equal(textFile.body.tooLarge, false);
    assert.equal(textFile.body.path, 'src/app.js');

    const binFile = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('nul.bin')}`, discovery.token);
    assert.equal(binFile.status, 200, binFile.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 200, binFile.body);
    assert.equal(binFile.body.binary, true);
    assert.equal(binFile.body.text, null);

    const largeFile = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('big.txt')}`, discovery.token);
    assert.equal(largeFile.status, 200, largeFile.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 200, largeFile.body);
    assert.equal(largeFile.body.tooLarge, true);
    assert.equal(largeFile.body.binary, false);
    assert.equal(largeFile.body.text, null);

    const dir = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('folder')}`, discovery.token);
    assert.equal(dir.status, 400, dir.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 400, dir.body);

    const missing = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('nope.txt')}`, discovery.token);
    assert.equal(missing.status, 404, missing.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 404, missing.body);

    const parent = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('../secret.txt')}`, discovery.token);
    assert.equal(parent.status, 403, parent.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 403, parent.body);
    assert.equal(parent.body.code, 'E_SANDBOX');

    const abs = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent(path.join(root, '..', 'secret.txt'))}`, discovery.token);
    assert.equal(abs.status, 403, abs.text);
    assert.equal(abs.body.code, 'E_SANDBOX');

    const linked = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('escape.txt')}`, discovery.token);
    assert.equal(linked.status, 403, linked.text);
    assert.equal(linked.body.code, 'E_SANDBOX');

    const saved = await sendV2(srv.base, 'PUT', `/api/v2/workspaces/${wid}/files`, discovery.token, {
      path: 'src/app.js',
      text: 'const a = 2;\n',
      baseVersion: textFile.body.version,
    });
    assert.equal(saved.status, 200, saved.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'PUT', 200, saved.body);
    assert.equal(saved.body.version, contentVersion('const a = 2;\n'));
    assert.equal(saved.body.path, 'src/app.js');

    const conflict = await sendV2(srv.base, 'PUT', `/api/v2/workspaces/${wid}/files`, discovery.token, {
      path: 'src/app.js',
      text: 'stale\n',
      baseVersion: textFile.body.version,
    });
    assert.equal(conflict.status, 409, conflict.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'PUT', 409, conflict.body);
    assert.equal(conflict.body.code, 'E_CONFLICT');
    assert.equal(conflict.body.current.text, 'const a = 2;\n');

    const forced = await sendV2(srv.base, 'PUT', `/api/v2/workspaces/${wid}/files`, discovery.token, {
      path: 'src/app.js',
      text: 'const a = 3;\n',
    });
    assert.equal(forced.status, 200, forced.text);
    assert.equal(forced.body.version, contentVersion('const a = 3;\n'));

    const escapePut = await sendV2(srv.base, 'PUT', `/api/v2/workspaces/${wid}/files`, discovery.token, {
      path: '../secret.txt',
      text: 'hack\n',
    });
    assert.equal(escapePut.status, 403, escapePut.text);
    assert.equal(escapePut.body.code, 'E_SANDBOX');

    const unauth = await getV2(srv.base, `/api/v2/workspaces/${wid}/tree`);
    assert.equal(unauth.status, 401);
  } finally {
    await stopServer(srv);
  }
});
