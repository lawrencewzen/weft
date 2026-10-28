import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it, test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { registerEnvConformance } from '@earendil-works/pi-durable/testing';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';

const context = BACKGROUND_CONTEXT;

function expect(actual, message) {
  return {
    toBeTruthy() {
      assert.ok(actual, message);
    },
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toEqual(expected) {
      assert.deepEqual(actual, expected);
    },
    toMatchObject(expected) {
      assert.partialDeepStrictEqual(actual, expected);
    },
    toBeGreaterThan(expected) {
      assert.ok(actual > expected, `${actual} > ${expected}`);
    },
    get rejects() {
      return {
        toThrow(messageIncludes) {
          return assert.rejects(actual, (error) => {
            const text = error instanceof Error ? error.message : String(error);
            assert.ok(text.includes(messageIncludes), text);
            return true;
          });
        },
      };
    },
  };
}

async function withWorkspaceEnv(use) {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-env-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  try {
    await use(env);
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

// win32: Git Bash `ln -s` copies a regular file (isSymbolicLink=false); official
// NodeExecutionEnv fails the same two cases (CI run 39554765466). Node fs.symlink()
// still creates native links — sandbox escape below covers that.
registerEnvConformance({
  describe,
  expect,
  it: (name, run, timeoutMs) => it(name, { timeout: timeoutMs }, run),
}, 'workspace env conformance', withWorkspaceEnv, {
  symlinks: process.platform !== 'win32',
});

test('sandbox: env rejects ../, absolute paths, and NUL', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-env-sand-'));
  const root = path.join(base, 'ws');
  await mkdir(root);
  await writeFile(path.join(base, 'secret.txt'), 'secret');
  const env = await createWorkspaceEnv({ cwd: root });
  try {
    const parent = await env.readTextFile('../secret.txt', context);
    assert.equal(parent.ok, false);
    assert.equal(parent.error.code, 'invalid');
    assert.equal(String(parent.error.message).includes('E_SANDBOX'), true);

    const abs = await env.writeFile(path.join(base, 'secret.txt'), 'pwned', context);
    assert.equal(abs.ok, false);
    assert.equal(String(abs.error.message).includes('E_SANDBOX'), true);

    const nul = await env.readTextFile('a\0b', context);
    assert.equal(nul.ok, false);
    assert.equal(String(nul.error.message).includes('E_SANDBOX'), true);

    assert.equal(await readFile(path.join(base, 'secret.txt'), 'utf8'), 'secret');
    const inside = await env.writeFile('ok.txt', 'yes', context);
    assert.equal(inside.ok, true);
    assert.equal(await readFile(path.join(root, 'ok.txt'), 'utf8'), 'yes');
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test('sandbox: env rejects symlink escape (file and dir)', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-env-link-'));
  const root = path.join(base, 'ws');
  await mkdir(root);
  await writeFile(path.join(base, 'secret.txt'), 'secret');
  await symlink(path.join(base, 'secret.txt'), path.join(root, 'link.txt'));
  await symlink(base, path.join(root, 'outdir'));
  const env = await createWorkspaceEnv({ cwd: await realpath(root) });
  try {
    const file = await env.readTextFile('link.txt', context);
    assert.equal(file.ok, false);
    assert.equal(String(file.error.message).includes('E_SANDBOX'), true);

    const dir = await env.writeFile('outdir/new.txt', 'pwned', context);
    assert.equal(dir.ok, false);
    assert.equal(String(dir.error.message).includes('E_SANDBOX'), true);
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test('sandbox: exec cwd cannot leave the workspace, and a command writes inside it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-env-exec-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  try {
    const escape = await env.exec('printf escaped', { cwd: '..' }, context);
    assert.equal(escape.ok, false);
    assert.equal(String(escape.error.message).includes('E_SANDBOX'), true);

    const output = { stdout: '', stderr: '' };
    const command = process.platform === 'win32'
      ? 'echo bash-ok> sand.txt'
      : 'printf bash-ok > sand.txt && printf bash-ok';
    const ran = await env.exec(command, {
      onOutput: (text, _ctx, info) => {
        output[info.stream] += text;
      },
    }, context);
    assert.equal(ran.ok, true, ran.ok ? '' : ran.error.message);
    assert.equal(ran.value.exitCode, 0);
    assert.equal((await readFile(path.join(dir, 'sand.txt'), 'utf8')).includes('bash-ok'), true);
    if (process.platform !== 'win32') assert.equal(output.stdout.includes('bash-ok'), true);
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

function envValue(dumped, name) {
  if (Object.hasOwn(dumped, name)) return dumped[name];
  if (process.platform !== 'win32') return undefined;
  const found = Object.keys(dumped).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? dumped[found] : undefined;
}

async function execDumpEnv(env) {
  const dump = `"${process.execPath}" -e "require('fs').writeFileSync('env.json', JSON.stringify(process.env))"`;
  const ran = await env.exec(dump, undefined, context);
  assert.equal(ran.ok, true, ran.ok ? '' : ran.error.message);
  assert.equal(ran.value.exitCode, 0, JSON.stringify(ran.value));
}

test('sandbox: exec does not inherit secrets, keeps proxies, and honors WEFT_BASH_ENV_ALLOW', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-env-allow-'));
  const previous = {
    WEFT_TEST_SECRET: process.env.WEFT_TEST_SECRET,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    MY_BASH_CUSTOM: process.env.MY_BASH_CUSTOM,
    NOT_ALLOWED_CUSTOM: process.env.NOT_ALLOWED_CUSTOM,
    WEFT_BASH_ENV_ALLOW: process.env.WEFT_BASH_ENV_ALLOW,
  };
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  process.env.WEFT_TEST_SECRET = 'weft-test-secret-value';
  process.env.OPENAI_API_KEY = 'sk-weft-test-openai-key';
  process.env.HTTPS_PROXY = 'http://weft-test-proxy.example:8080';
  process.env.MY_BASH_CUSTOM = 'weft-allow-custom-ok';
  process.env.NOT_ALLOWED_CUSTOM = 'should-not-leak';
  process.env.WEFT_BASH_ENV_ALLOW = 'MY_BASH_CUSTOM,OPENAI_API_KEY';
  let env;
  try {
    env = await createWorkspaceEnv({ cwd: dir });
    await execDumpEnv(env);
    const dumped = JSON.parse(await readFile(path.join(dir, 'env.json'), 'utf8'));
    assert.equal(envValue(dumped, 'WEFT_TEST_SECRET'), undefined);
    assert.equal(envValue(dumped, 'OPENAI_API_KEY'), undefined);
    assert.equal(envValue(dumped, 'NOT_ALLOWED_CUSTOM'), undefined);
    assert.equal(envValue(dumped, 'WEFT_BASH_ENV_ALLOW'), undefined);
    assert.equal(envValue(dumped, 'HTTPS_PROXY'), 'http://weft-test-proxy.example:8080');
    assert.equal(envValue(dumped, 'MY_BASH_CUSTOM'), 'weft-allow-custom-ok');
    assert.equal(JSON.stringify(dumped).includes('weft-test-secret-value'), false);
    assert.equal(JSON.stringify(dumped).includes('sk-weft-test-openai-key'), false);
    assert.equal(JSON.stringify(dumped).includes('should-not-leak'), false);
  } finally {
    restore();
    await env?.cleanup(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('sandbox: exec PATH can run node -v and git --version', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-env-path-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  try {
    for (const command of ['node -v', 'git --version']) {
      const output = { stdout: '', stderr: '' };
      const ran = await env.exec(command, {
        onOutput: (text, _ctx, info) => {
          output[info.stream] += text;
        },
      }, context);
      assert.equal(ran.ok, true, `${command}: ${ran.ok ? '' : ran.error.message}`);
      assert.equal(ran.value.exitCode, 0, `${command}: ${JSON.stringify({ output, ran: ran.value })}`);
      const text = `${output.stdout}${output.stderr}`;
      if (command.startsWith('node')) assert.match(text, /v\d+/);
      else assert.match(text, /git version/i);
    }
  } finally {
    await env.cleanup(context).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
