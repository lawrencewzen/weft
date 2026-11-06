import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathErrorView } from '../../src/v2/views/extensions.ts';
import { phrase } from '../../src/v2/phrases/index.ts';
import { validateResponse } from '../../src/v2/validate.ts';
import { defaultWorkspaceRoot } from '../../src/core/workspace-guard.mjs';
import {
  FOLDER_PICK_TIMEOUT_MS,
  pickFolder,
  pickWorkspaceFolder,
} from '../../src/core/folder-picker.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

function nativeReal(p) {
  return realpathSync.native(p);
}

function cancelError() {
  return Object.assign(new Error('execution error: User canceled. (-128)'), { code: 1 });
}

function resolvedRunner(result) {
  return () => ({
    kill() {},
    promise: Promise.resolve(result),
  });
}

describe('folder picker', { concurrency: 1 }, () => {
  test('injected absolute paths are picked, relative stdout is unsupported', async () => {
    const winPath = 'C:\\Users\\example\\proj';
    const picked = await pickFolder({
      platform: 'darwin',
      startDir: '/tmp/start',
      prompt: 'Select folder',
      runner: resolvedRunner({ error: null, stdout: `${winPath}/\n`, stderr: '' }),
    });
    assert.deepEqual(picked, { status: 'picked', path: winPath });

    const relative = await pickFolder({
      platform: 'darwin',
      startDir: '/tmp/start',
      prompt: 'Select folder',
      runner: resolvedRunner({ error: null, stdout: 'proj/\n', stderr: '' }),
    });
    assert.deepEqual(relative, { status: 'unsupported' });
  });

  test('dialog timeout is 10 minutes', () => {
    assert.equal(FOLDER_PICK_TIMEOUT_MS, 600_000);
  });

  test('darwin argv is osascript -e, not a shell, and escapes the prompt', async () => {
    let seen = null;
    const startDir = '/tmp/a\\b"c';
    const prompt = 'Select "folder"';
    const result = await pickFolder({
      platform: 'darwin',
      startDir,
      prompt,
      timeoutMs: 1000,
      runner: (file, args) => {
        seen = { file, args };
        return resolvedRunner({ error: null, stdout: '/tmp/picked/', stderr: '' })();
      },
    });
    assert.deepEqual(result, { status: 'picked', path: '/tmp/picked' });
    assert.equal(seen.file, 'osascript');
    assert.equal(seen.args.length, 2);
    assert.equal(seen.args[0], '-e');
    assert.equal(seen.args.includes('-c'), false);
    const script = seen.args[1];
    assert.match(script, /activate/);
    assert.match(script, /choose folder/);
    assert.match(script, /POSIX path/);
    assert.match(script, /Select \\"folder\\"/);
    assert.match(script, /POSIX file "\/tmp\/a\\\\b\\"c"/);
    assert.doesNotMatch(script, /sh -c|\/bin\/sh/);
  });

  test('picked, cancelled, unsupported, and missing osascript', async () => {
    const picked = await pickFolder({
      platform: 'darwin',
      startDir: '/tmp/start',
      prompt: 'Select folder',
      runner: resolvedRunner({ error: null, stdout: '/tmp/chosen/\n', stderr: '' }),
    });
    assert.deepEqual(picked, { status: 'picked', path: '/tmp/chosen' });

    const cancelled = await pickFolder({
      platform: 'darwin',
      startDir: '/tmp/start',
      prompt: 'Select folder',
      runner: resolvedRunner({
        error: cancelError(),
        stdout: '',
        stderr: '0:123: execution error: User canceled. (-128)\n',
      }),
    });
    assert.deepEqual(cancelled, { status: 'cancelled' });

    const noGui = await pickFolder({
      platform: 'darwin',
      startDir: '/tmp/start',
      prompt: 'Select folder',
      runner: resolvedRunner({
        error: Object.assign(new Error('execution error: No user interaction is allowed. (-1713)'), { code: 1 }),
        stdout: '',
        stderr: 'execution error: No user interaction is allowed. (-1713)',
      }),
    });
    assert.deepEqual(noGui, { status: 'unsupported' });

    let enoentCalls = 0;
    const missing = await pickWorkspaceFolder({
      host: '127.0.0.1:9',
      env: {},
      platform: 'darwin',
      startDir: '/tmp/start',
      prompt: 'Select folder',
      dataDir: '/tmp/data',
      runner: () => {
        enoentCalls += 1;
        return {
          kill() {},
          promise: Promise.resolve({
            error: Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' }),
            stdout: '',
            stderr: '',
          }),
        };
      },
    });
    assert.equal(enoentCalls, 1);
    assert.deepEqual(missing, { status: 'unsupported' });

    let linuxCalls = 0;
    const linux = await pickFolder({
      platform: 'linux',
      runner: () => { linuxCalls += 1; return resolvedRunner({ stdout: '/tmp/x' })(); },
      startDir: '/tmp/start',
      prompt: 'Select folder',
    });
    assert.deepEqual(linux, { status: 'unsupported' });
    assert.equal(linuxCalls, 0);

    let winCalls = 0;
    const win = await pickFolder({
      platform: 'win32',
      runner: () => { winCalls += 1; return resolvedRunner({ stdout: '/tmp/x' })(); },
      startDir: '/tmp/start',
      prompt: 'Select folder',
    });
    assert.deepEqual(win, { status: 'unsupported' });
    assert.equal(winCalls, 0);
  });

  test('non-loopback host and WEFT_FOLDER_PICKER=off do not call the runner', async () => {
    const blockedHosts = ['example.com', 'example.com:443', '10.1.2.3:9', '127.0.0.2:9', 'localhost.evil.com', '', undefined];
    for (const host of blockedHosts) {
      let calls = 0;
      const result = await pickWorkspaceFolder({
        host,
        env: {},
        platform: 'darwin',
        startDir: '/tmp/start',
        prompt: 'Select folder',
        dataDir: '/tmp/data',
        runner: () => { calls += 1; return resolvedRunner({ stdout: '/tmp/nope' })(); },
      });
      assert.deepEqual(result, { status: 'unsupported' }, `host ${host}`);
      assert.equal(calls, 0, `host ${host}`);
    }

    for (const value of ['off', 'OFF', ' off ']) {
      let calls = 0;
      const result = await pickWorkspaceFolder({
        host: 'localhost:8787',
        env: { WEFT_FOLDER_PICKER: value },
        platform: 'darwin',
        startDir: '/tmp/start',
        prompt: 'Select folder',
        dataDir: '/tmp/data',
        runner: () => { calls += 1; return resolvedRunner({ stdout: '/tmp/nope' })(); },
      });
      assert.deepEqual(result, { status: 'unsupported' }, value);
      assert.equal(calls, 0, value);
    }

    const allowed = ['127.0.0.1', '127.0.0.1:8787', 'localhost', 'LocalHost:80', '[::1]', '[::1]:9'];
    for (const host of allowed) {
      let calls = 0;
      const result = await pickWorkspaceFolder({
        host,
        env: {},
        platform: 'darwin',
        startDir: '/tmp/start',
        prompt: 'Select folder',
        dataDir: '/tmp/data',
        runner: () => {
          calls += 1;
          return resolvedRunner({
            error: cancelError(),
            stdout: '',
            stderr: 'User canceled. (-128)',
          })();
        },
      });
      assert.equal(calls, 1, host);
      assert.deepEqual(result, { status: 'cancelled' }, host);
    }
  });

  test('two concurrent requests call the runner once and share the result', async () => {
    const root = await makeTempDir('weft-pick-root-');
    const dataDir = await makeTempDir('weft-pick-data-');
    const child = path.join(root, 'proj');
    await mkdir(child);
    const prev = process.env.WEFT_WORKSPACE_ROOT;
    process.env.WEFT_WORKSPACE_ROOT = root;
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runner = (file, args) => {
      calls += 1;
      assert.equal(file, 'osascript');
      assert.equal(args[0], '-e');
      assert.match(args[1], /choose folder/);
      return {
        kill() {},
        promise: gate.then(() => ({ error: null, stdout: `${child}/\n`, stderr: '' })),
      };
    };
    try {
      const first = pickWorkspaceFolder({
        host: '127.0.0.1:9',
        env: {},
        platform: 'darwin',
        runner,
        startDir: root,
        prompt: 'Select folder',
        dataDir,
        timeoutMs: 5000,
      });
      const second = pickWorkspaceFolder({
        host: '[::1]:9',
        env: {},
        platform: 'darwin',
        runner,
        startDir: '/somewhere/else',
        prompt: 'Other',
        dataDir,
        timeoutMs: 5000,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      release();
      const [a, b] = await Promise.all([first, second]);
      const expected = { status: 'picked', path: nativeReal(child) };
      assert.deepEqual(a, expected);
      assert.deepEqual(b, expected);
    } finally {
      if (prev === undefined) delete process.env.WEFT_WORKSPACE_ROOT;
      else process.env.WEFT_WORKSPACE_ROOT = prev;
      await removeTempDir(root);
      await removeTempDir(dataDir);
    }
  });

  test('timeout kills the picker process and returns cancelled', async () => {
    let calls = 0;
    let killed = 0;
    const runner = () => {
      calls += 1;
      return {
        promise: new Promise(() => {}),
        kill() { killed += 1; },
      };
    };
    const pending = pickWorkspaceFolder({
      host: 'localhost',
      env: {},
      platform: 'darwin',
      runner,
      startDir: '/tmp/start',
      prompt: 'Select folder',
      dataDir: '/tmp/data',
      timeoutMs: 40,
    });
    const again = pickWorkspaceFolder({
      host: '127.0.0.1:9',
      env: {},
      platform: 'darwin',
      runner,
      startDir: '/tmp/start',
      prompt: 'Select folder',
      dataDir: '/tmp/data',
      timeoutMs: 40,
    });
    const [a, b] = await Promise.all([pending, again]);
    assert.deepEqual(a, { status: 'cancelled' });
    assert.deepEqual(b, { status: 'cancelled' });
    assert.equal(calls, 1);
    assert.equal(killed, 1);

    const next = await pickFolder({
      platform: 'darwin',
      startDir: '/tmp/start',
      prompt: 'Select folder',
      timeoutMs: 1000,
      runner: resolvedRunner({ error: null, stdout: '/tmp/after-timeout', stderr: '' }),
    });
    assert.deepEqual(next, { status: 'picked', path: '/tmp/after-timeout' });
  });

  test('a picked sensitive directory such as ~/.ssh is a path error', async () => {
    const ssh = path.join(os.homedir(), '.ssh');
    let created = false;
    try {
      realpathSync.native(ssh);
    } catch {
      await mkdir(ssh);
      created = true;
    }
    const dataDir = await makeTempDir('weft-pick-ssh-data-');
    const prev = process.env.WEFT_WORKSPACE_ROOT;
    delete process.env.WEFT_WORKSPACE_ROOT;
    try {
      await assert.rejects(
        () => pickWorkspaceFolder({
          host: '127.0.0.1',
          env: {},
          platform: 'darwin',
          startDir: os.homedir(),
          prompt: 'Select folder',
          dataDir,
          runner: resolvedRunner({ error: null, stdout: `${ssh}/\n`, stderr: '' }),
        }),
        (err) => {
          assert.equal(err.status, 400);
          assert.equal(err.code, 'E_PATH');
          assert.match(err.message, /forbidden/);
          const allowedRoot = defaultWorkspaceRoot();
          const view = pathErrorView('zh', err, allowedRoot);
          assert.deepEqual(view, {
            error: phrase('zh', 'ws_err_path_root', { root: allowedRoot }),
            code: 'E_PATH',
            allowedRoot,
          });
          const checked = validateResponse('/api/v2/workspace-root/pick', 'POST', 400, view);
          assert.equal(checked.ok, true, JSON.stringify(checked.errors));
          return true;
        },
      );
    } finally {
      if (prev === undefined) delete process.env.WEFT_WORKSPACE_ROOT;
      else process.env.WEFT_WORKSPACE_ROOT = prev;
      await removeTempDir(dataDir);
      if (created) await rm(ssh, { recursive: false, force: true }).catch(() => {});
    }
  });

  test('POST /api/v2/workspace-root/pick stays unsupported while the picker is off', { timeout: 40_000 }, async () => {
    const srv = await startServer({ token: 'folder-pick-token', env: { WEFT_LLM: 'faux' } });
    try {
      const discovery = await readDiscovery(srv.dataDir);
      const picked = await request(srv.base, 'POST', '/api/v2/workspace-root/pick', {}, discovery.token);
      assert.equal(picked.status, 200, picked.text);
      assert.deepEqual(picked.body, { status: 'unsupported' });
      const checked = validateResponse('/api/v2/workspace-root/pick', 'POST', 200, picked.body);
      assert.equal(checked.ok, true, JSON.stringify(checked.errors));

      const unauth = await request(srv.base, 'POST', '/api/v2/workspace-root/pick', {}, '');
      assert.equal(unauth.status, 401);
    } finally {
      await stopServer(srv);
    }
  });
});
