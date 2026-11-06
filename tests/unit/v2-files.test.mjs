import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { resolveInWorkspace } from '../../src/core/paths.mjs';
import {
  ATOMIC_RENAME_ATTEMPTS,
  contentVersion,
  emptyFileContent,
  fileNodeView,
  hashFile,
  looksBinary,
  maxFileBytes,
  readWorkspaceFile,
  saveWorkspaceFile,
  SVG_IMAGE_CSP,
  WORKSPACE_IMAGE_MAX_BYTES,
  workspaceImageMediaType,
  workspaceTreeView,
  writeFileAtomic,
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
  // A NUL keeps the stub binary on Windows, where encoding detection is always
  // on and the four PNG magic bytes alone decode as GBK.
  await writeFile(path.join(root, 'pic.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  await writeFile(path.join(root, 'icon.svg'), '<svg></svg>');
  const env = { WEFT_V2_MAX_FILE_BYTES: '4' };

  const text = await readWorkspaceFile(root, 'ok.txt');
  assert.equal(text.binary, false);
  assert.equal(text.tooLarge, false);
  assert.equal(text.text, 'hello\n');
  assert.equal(text.image, undefined);
  assert.equal(text.version, contentVersion('hello\n'));

  const pic = await readWorkspaceFile(root, 'pic.PNG');
  assert.equal(pic.image, true);
  assert.equal(pic.binary, true);
  assert.equal(pic.text, null);

  const largePic = await readWorkspaceFile(root, 'pic.PNG', { WEFT_V2_MAX_FILE_BYTES: '1' });
  assert.equal(largePic.tooLarge, true);
  assert.equal(largePic.image, true);
  assert.equal(largePic.text, null);

  const svg = await readWorkspaceFile(root, 'icon.svg');
  assert.equal(svg.image, true);
  assert.equal(svg.binary, false);
  assert.equal(svg.text, '<svg></svg>');

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

async function tmpLeftovers(dir) {
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith('.tmp'));
}

function busyError(code = 'EPERM') {
  const err = new Error(code);
  err.code = code;
  return err;
}

test('saveWorkspaceFile atomic write leaves no tmp and writes content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-atomic-'));
  await mkdir(path.join(root, 'nested'), { recursive: true });
  await writeFile(path.join(root, 'nested', 'a.txt'), 'old\n');
  const saved = await saveWorkspaceFile({ root, path: 'nested/a.txt', text: 'fresh\n' });
  assert.equal(saved.version, contentVersion('fresh\n'));
  const after = await readWorkspaceFile(root, 'nested/a.txt');
  assert.equal(after.text, 'fresh\n');
  assert.deepEqual(await tmpLeftovers(path.join(root, 'nested')), []);
  assert.deepEqual(await tmpLeftovers(root), []);
});

test('saveWorkspaceFile rename does not empty the existing file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-atomic-seen-'));
  const abs = path.join(root, 'a.txt');
  await writeFile(abs, 'old-content\n');
  let seen = null;
  await saveWorkspaceFile({
    root,
    path: 'a.txt',
    text: 'new-content\n',
    atomic: {
      rename: async (from, to) => {
        seen = await readFile(to, 'utf8');
        await fs.rename(from, to);
      },
    },
  });
  assert.equal(seen, 'old-content\n');
  assert.equal(await readFile(abs, 'utf8'), 'new-content\n');
  assert.deepEqual(await tmpLeftovers(root), []);
});

test('saveWorkspaceFile preserves 0o755 mode', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-atomic-mode-'));
  const abs = path.join(root, 'script.sh');
  await writeFile(abs, '#!/bin/sh\necho old\n', { mode: 0o755 });
  await chmod(abs, 0o755);
  assert.equal((await stat(abs)).mode & 0o777, 0o755);
  await saveWorkspaceFile({ root, path: 'script.sh', text: '#!/bin/sh\necho new\n' });
  assert.equal(await readFile(abs, 'utf8'), '#!/bin/sh\necho new\n');
  assert.equal((await stat(abs)).mode & 0o777, 0o755);
  assert.deepEqual(await tmpLeftovers(root), []);
});

test('saveWorkspaceFile through symlink updates the target and keeps the link', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-atomic-link-'));
  const realAbs = path.join(root, 'real.txt');
  const linkAbs = path.join(root, 'link.txt');
  await writeFile(realAbs, 'via-real\n');
  await symlink(realAbs, linkAbs);
  const resolved = await resolveInWorkspace(root, 'link.txt');
  assert.equal(resolved, await realpath(realAbs));
  await saveWorkspaceFile({ root, path: 'link.txt', text: 'updated\n' });
  assert.equal((await lstat(linkAbs)).isSymbolicLink(), true);
  assert.equal(await readFile(linkAbs, 'utf8'), 'updated\n');
  assert.equal(await readFile(realAbs, 'utf8'), 'updated\n');
  assert.deepEqual(await tmpLeftovers(root), []);
});

test('writeFileAtomic falls back to writeFile after repeated EPERM', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-atomic-eperm-'));
  const abs = path.join(root, 'a.txt');
  await writeFile(abs, 'old\n');
  const writes = [];
  let renameCalls = 0;
  await writeFileAtomic(abs, 'fallback\n', {
    writeFile: async (file, data, encoding) => {
      writes.push(file);
      await fs.writeFile(file, data, encoding);
    },
    rename: async () => {
      renameCalls += 1;
      throw busyError('EPERM');
    },
    sleep: async () => {},
  });
  assert.equal(renameCalls, ATOMIC_RENAME_ATTEMPTS);
  assert.equal(writes.at(-1), abs);
  assert.equal(writes.some((file) => file !== abs && file.endsWith('.tmp')), true);
  assert.equal(await readFile(abs, 'utf8'), 'fallback\n');
  assert.deepEqual(await tmpLeftovers(root), []);
});

test('writeFileAtomic rename succeeds after two EPERM retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-atomic-retry-'));
  const abs = path.join(root, 'a.txt');
  await writeFile(abs, 'old\n');
  const writes = [];
  let renameCalls = 0;
  await writeFileAtomic(abs, 'renamed\n', {
    writeFile: async (file, data, encoding) => {
      writes.push(file);
      await fs.writeFile(file, data, encoding);
    },
    rename: async (from, to) => {
      renameCalls += 1;
      if (renameCalls < 3) throw busyError('EPERM');
      await fs.rename(from, to);
    },
    sleep: async () => {},
  });
  assert.equal(renameCalls, 3);
  assert.equal(writes.includes(abs), false);
  assert.equal(await readFile(abs, 'utf8'), 'renamed\n');
  assert.deepEqual(await tmpLeftovers(root), []);
});

test('writeFileAtomic cleans tmp and keeps original when writing tmp fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-v2-atomic-fail-'));
  const abs = path.join(root, 'a.txt');
  await writeFile(abs, 'keep-me\n');
  await assert.rejects(
    () => writeFileAtomic(abs, 'should-not-land\n', {
      writeFile: async (file, data, encoding) => {
        if (file.endsWith('.tmp')) {
          await fs.writeFile(file, 'partial', encoding);
          throw new Error('ENOSPC');
        }
        await fs.writeFile(file, data, encoding);
      },
    }),
    (err) => err.message === 'ENOSPC',
  );
  assert.equal(await readFile(abs, 'utf8'), 'keep-me\n');
  assert.deepEqual(await tmpLeftovers(root), []);
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

test('workspaceImageMediaType is the extension whitelist, case-insensitive', () => {
  assert.equal(workspaceImageMediaType('a.png'), 'image/png');
  assert.equal(workspaceImageMediaType('a.jpg'), 'image/jpeg');
  assert.equal(workspaceImageMediaType('a.jpeg'), 'image/jpeg');
  assert.equal(workspaceImageMediaType('dir/A.GIF'), 'image/gif');
  assert.equal(workspaceImageMediaType('a.webp'), 'image/webp');
  assert.equal(workspaceImageMediaType('a.bmp'), 'image/bmp');
  assert.equal(workspaceImageMediaType('a.svg'), 'image/svg+xml');
  assert.equal(workspaceImageMediaType('a.ico'), 'image/x-icon');
  assert.equal(workspaceImageMediaType('Photo.PNG'), 'image/png');
  assert.equal(workspaceImageMediaType('note.txt'), null);
  assert.equal(workspaceImageMediaType('noext'), null);
  assert.equal(workspaceImageMediaType('pic.png.txt'), null);
  assert.equal(workspaceImageMediaType('.png'), null);
  assert.equal(workspaceImageMediaType('file.'), null);
});

async function getRaw(base, apiPath, headers = {}) {
  const res = await fetch(base + apiPath, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) {
    try { body = buf.length ? JSON.parse(buf.toString('utf8')) : null; } catch { body = null; }
  }
  return { status: res.status, buf, body, headers: res.headers };
}

async function issueSessionCookie(base, token) {
  const issued = await fetch(`${base}/api/v2/auth/web-code`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const login = await fetch(`${base}/auth?code=${encodeURIComponent(code)}`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const setCookie = login.headers.get('set-cookie') || '';
  const match = /weft_session=([^;]+)/.exec(setCookie);
  assert.ok(match, setCookie);
  return `weft_session=${match[1]}`;
}

test('GET /files/raw streams images: whitelist, 415, sandbox, 413, 304, headers, cookie', { timeout: 40_000 }, async () => {
  const srv = await startServer({
    token: TOKEN,
    env: { WEFT_LLM: 'faux' },
  });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'v2-raw' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const wid = ws.body.id;
    const root = ws.body.path;
    const bearer = { authorization: `Bearer ${discovery.token}` };
    const rawUrl = (rel) => `/api/v2/workspaces/${wid}/files/raw?path=${encodeURIComponent(rel)}`;

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const samples = [
      ['shot.png', 'image/png', pngBytes],
      ['shot.jpg', 'image/jpeg', Buffer.from('jpg-bytes')],
      ['shot.jpeg', 'image/jpeg', Buffer.from('jpeg-bytes')],
      ['shot.gif', 'image/gif', Buffer.from('gif-bytes')],
      ['shot.webp', 'image/webp', Buffer.from('webp-bytes')],
      ['shot.bmp', 'image/bmp', Buffer.from('bmp-bytes')],
      ['shot.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['shot.ico', 'image/x-icon', Buffer.from('ico-bytes')],
      ['Photo.JPEG', 'image/jpeg', Buffer.from('upper-jpeg')],
    ];
    for (const [name, mediaType, bytes] of samples) {
      await writeFile(path.join(root, name), bytes);
      const res = await getRaw(srv.base, rawUrl(name), bearer);
      assert.equal(res.status, 200, `${name} ${res.buf.toString('utf8')}`);
      assert.equal(res.headers.get('content-type'), mediaType, name);
      assert.equal(res.buf.equals(bytes), true, name);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', name);
      assert.equal(res.headers.get('content-disposition'), 'inline', name);
      assert.equal(res.headers.get('cache-control'), 'private, no-cache', name);
      assert.equal(res.headers.get('etag'), `"${await hashFile(path.join(root, name))}"`, name);
    }

    const png = await getRaw(srv.base, rawUrl('shot.png'), bearer);
    assert.notEqual(png.headers.get('content-security-policy'), SVG_IMAGE_CSP);
    const svg = await getRaw(srv.base, rawUrl('shot.svg'), bearer);
    assert.equal(svg.headers.get('content-security-policy'), SVG_IMAGE_CSP);
    assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(svg.headers.get('content-disposition'), 'inline');

    const meta = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('shot.png')}`, discovery.token);
    assert.equal(meta.status, 200, meta.text);
    assertChecked(`/api/v2/workspaces/${wid}/files`, 'GET', 200, meta.body);
    assert.equal(meta.body.image, true);
    assert.equal(meta.body.binary, true);
    assert.equal(meta.body.text, null);

    await writeFile(path.join(root, 'note.txt'), 'hello\n');
    const textMeta = await getV2(srv.base, `/api/v2/workspaces/${wid}/files?path=${encodeURIComponent('note.txt')}`, discovery.token);
    assert.equal(textMeta.status, 200, textMeta.text);
    assert.equal(Object.hasOwn(textMeta.body, 'image'), false);

    const rejected = ['note.txt', 'noext', 'pic.png.txt', '.png'];
    await writeFile(path.join(root, 'noext'), 'x');
    await writeFile(path.join(root, 'pic.png.txt'), 'x');
    await writeFile(path.join(root, '.png'), 'x');
    for (const name of rejected) {
      const res = await getRaw(srv.base, rawUrl(name), bearer);
      assert.equal(res.status, 415, name);
      assert.equal(res.body.code, 'E_MEDIA', name);
      assertChecked(`/api/v2/workspaces/${wid}/files/raw`, 'GET', 415, res.body);
    }

    await writeFile(path.join(root, '..', 'secret.png'), Buffer.from('TOP-SECRET-PIXELS'));
    await symlink(path.join(root, '..', 'secret.png'), path.join(root, 'escape.png'));
    const parent = await getRaw(srv.base, rawUrl('../secret.png'), bearer);
    assert.equal(parent.status, 403);
    assert.equal(parent.body.code, 'E_SANDBOX');
    assertChecked(`/api/v2/workspaces/${wid}/files/raw`, 'GET', 403, parent.body);
    assert.equal(parent.buf.includes(Buffer.from('TOP-SECRET-PIXELS')), false);

    const linked = await getRaw(srv.base, rawUrl('escape.png'), bearer);
    assert.equal(linked.status, 403);
    assert.equal(linked.body.code, 'E_SANDBOX');
    assert.equal(linked.buf.includes(Buffer.from('TOP-SECRET-PIXELS')), false);

    await symlink(path.join(root, 'shot.png'), path.join(root, 'link.png'));
    const inside = await getRaw(srv.base, rawUrl('link.png'), bearer);
    assert.equal(inside.status, 200);
    assert.equal(inside.buf.equals(pngBytes), true);
    assert.equal(inside.headers.get('content-type'), 'image/png');

    const fh = await open(path.join(root, 'huge.png'), 'w');
    await fh.truncate(WORKSPACE_IMAGE_MAX_BYTES + 1);
    await fh.close();
    const huge = await getRaw(srv.base, rawUrl('huge.png'), bearer);
    assert.equal(huge.status, 413);
    assert.equal(huge.body.code, 'E_TOO_LARGE');
    assertChecked(`/api/v2/workspaces/${wid}/files/raw`, 'GET', 413, huge.body);
    assert.ok(huge.buf.length < 1000);

    const etag = png.headers.get('etag');
    const cached = await getRaw(srv.base, rawUrl('shot.png'), { ...bearer, 'if-none-match': etag });
    assert.equal(cached.status, 304);
    assert.equal(cached.buf.length, 0);
    assert.equal(cached.headers.get('etag'), etag);
    assert.equal(cached.headers.get('cache-control'), 'private, no-cache');
    assert.equal(cached.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(cached.headers.get('content-disposition'), 'inline');

    const stale = await getRaw(srv.base, rawUrl('shot.png'), { ...bearer, 'if-none-match': '"deadbeefdeadbeef"' });
    assert.equal(stale.status, 200);
    assert.equal(stale.buf.equals(pngBytes), true);

    const listed = await getRaw(srv.base, rawUrl('shot.png'), { ...bearer, 'if-none-match': `"nope", ${etag}` });
    assert.equal(listed.status, 304);

    await mkdir(path.join(root, 'folder'));
    await mkdir(path.join(root, 'pics.png'));
    const dir = await getRaw(srv.base, rawUrl('folder'), bearer);
    assert.equal(dir.status, 400);
    assertChecked(`/api/v2/workspaces/${wid}/files/raw`, 'GET', 400, dir.body);
    const dirNamedPng = await getRaw(srv.base, rawUrl('pics.png'), bearer);
    assert.equal(dirNamedPng.status, 400);
    assert.equal(dirNamedPng.body.code, 'E_BAD_REQUEST');

    const missing = await getRaw(srv.base, rawUrl('missing.png'), bearer);
    assert.equal(missing.status, 404);
    assertChecked(`/api/v2/workspaces/${wid}/files/raw`, 'GET', 404, missing.body);

    const noPath = await getRaw(srv.base, `/api/v2/workspaces/${wid}/files/raw`, bearer);
    assert.equal(noPath.status, 400);
    assert.equal(noPath.body.code, 'E_BAD_REQUEST');

    const cookie = await issueSessionCookie(srv.base, discovery.token);
    const withCookie = await getRaw(srv.base, rawUrl('shot.png'), { cookie });
    assert.equal(withCookie.status, 200);
    assert.equal(withCookie.buf.equals(pngBytes), true);
    assert.equal(withCookie.headers.get('content-type'), 'image/png');

    const unauth = await getRaw(srv.base, rawUrl('shot.png'));
    assert.equal(unauth.status, 401);
    assert.equal(unauth.body.code, 'E_UNAUTHORIZED');
    assertChecked(`/api/v2/workspaces/${wid}/files/raw`, 'GET', 401, unauth.body);

    const badCookie = await getRaw(srv.base, rawUrl('shot.png'), { cookie: 'weft_session=not-a-session' });
    assert.equal(badCookie.status, 401);
    assert.equal(badCookie.body.code, 'E_UNAUTHORIZED');
  } finally {
    await stopServer(srv);
  }
});

test('prototype seed returns the embedded preview png from /files/raw', async () => {
  const {
    SEED_PREVIEW_PNG_BASE64,
    readRepoFile,
    readRepoFileRaw,
    seedWeftRepo,
  } = await import('../../web/proto/mock/repo.ts');
  const repo = seedWeftRepo();
  const content = readRepoFile(repo, 'design/preview.png');
  assert.equal(content.image, true);
  assert.equal(content.binary, true);
  assert.equal(content.text, null);
  assert.equal(content.size > 0, true);

  const raw = readRepoFileRaw(repo, 'design/preview.png');
  assert.equal(raw.mediaType, 'image/png');
  assert.equal(Buffer.from(raw.bytes).toString('base64'), SEED_PREVIEW_PNG_BASE64);
  assert.equal(raw.bytes[0], 0x89);
  assert.equal(raw.bytes[1], 0x50);

  const text = readRepoFileRaw(repo, 'README.md');
  assert.equal(text.status, 415);
  assert.equal(text.code, 'E_MEDIA');
  const escape = readRepoFileRaw(repo, '../secret.png');
  assert.equal(escape.status, 403);
  assert.equal(escape.code, 'E_SANDBOX');
  const missing = readRepoFileRaw(repo, 'design/missing.png');
  assert.equal(missing.status, 404);
  const dir = readRepoFileRaw(repo, 'design');
  assert.equal(dir.status, 400);
});
