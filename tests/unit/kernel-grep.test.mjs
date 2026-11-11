// grep: ripgrep-backed with hashline anchors, and the JS fallback.
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createGrepTool, resolveRipgrep } from '../../src/kernel/grep-tool.mjs';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';
import { workspaceTools } from '../../src/kernel/tools.mjs';

const rg = resolveRipgrep();
const hasRg = spawnSync(rg, ['--version'], { stdio: 'ignore' }).status === 0;
const needRg = hasRg ? {} : { skip: 'ripgrep is not installed' };
const ANCHOR = /^(.+):(\d+)#([A-Z]{3}):(.*)$/;

async function fixture(t, { dataDir } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-grep-'));
  const ws = path.join(base, 'ws');
  await mkdir(ws, { recursive: true });
  const env = await createWorkspaceEnv({ cwd: ws, dataDir });
  t.after(async () => {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  const api = { env, output() {}, retainedOutput: () => ({ text: '', truncated: false }), diagnostic() {} };
  const put = async (rel, text) => {
    const file = path.join(ws, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  return { base, ws, env, api, put };
}

const run = (tool, args, api) => tool.execute(args, api, BACKGROUND_CONTEXT);
const linesOf = (result) => result.output[0].text.split('\n').filter(Boolean);
const withoutRg = () => createGrepTool({ ripgrep: () => null });

test('resolveRipgrep: WEFT_RG_PATH, then tools/rg in the app dir, then PATH', () => {
  const present = new Set();
  const exists = (p) => present.has(p);
  const opts = { env: {}, appDir: path.join('/app'), exists };
  assert.equal(resolveRipgrep({ ...opts, platform: 'linux' }), 'rg');
  present.add(path.join('/app', 'tools', 'rg', 'rg'));
  assert.equal(resolveRipgrep({ ...opts, platform: 'linux' }), path.join('/app', 'tools', 'rg', 'rg'));
  present.add(path.join('/app', 'tools', 'rg', 'rg.exe'));
  assert.equal(resolveRipgrep({ ...opts, platform: 'win32' }), path.join('/app', 'tools', 'rg', 'rg.exe'));
  present.add('/custom/rg');
  assert.equal(resolveRipgrep({ ...opts, env: { WEFT_RG_PATH: '/custom/rg' } }), '/custom/rg');
  assert.equal(resolveRipgrep({ ...opts, env: { WEFT_RG_PATH: '/missing/rg' }, platform: 'linux' }), path.join('/app', 'tools', 'rg', 'rg'));
});

test('rg: results carry anchors that edit accepts', needRg, async (t) => {
  const f = await fixture(t);
  await f.put('src/a.js', 'const one = 1;\nfunction target() {\n  return one;\n}\n');
  await f.put('src/b.js', 'target();\n');
  const tool = createGrepTool();
  const out = await run(tool, { pattern: 'target', path: 'src' }, f.api);
  const rows = linesOf(out).map((l) => ANCHOR.exec(l));
  assert.ok(rows.every(Boolean), out.output[0].text);
  assert.deepEqual(rows.map((m) => [m[1], m[2], m[4]]), [['src/a.js', '2', 'function target() {'], ['src/b.js', '1', 'target();']]);
  const edit = workspaceTools().find((x) => x.name === 'edit');
  await edit.execute({ path: 'src/a.js', edits: [{ op: 'replace', pos: `${rows[0][2]}#${rows[0][3]}`, lines: ['function renamed() {'] }] }, f.api, BACKGROUND_CONTEXT);
  const again = await run(tool, { pattern: 'renamed', literal: true }, f.api);
  assert.match(again.output[0].text, /^src\/a\.js:2#[A-Z]{3}:function renamed\(\) \{$/);
});

test('rg: honours .gitignore, skips binaries and .git, supports glob/ignoreCase/literal', needRg, async (t) => {
  const f = await fixture(t);
  await f.put('.gitignore', 'ignored/\n');
  await f.put('ignored/x.txt', 'Needle\n');
  await f.put('.git/config', 'Needle\n');
  await f.put('.hidden.txt', 'Needle hidden\n');
  await f.put('bin.dat', Buffer.concat([Buffer.from('Needle'), Buffer.from([0, 1, 2])]));
  await f.put('keep.txt', 'a Needle (x)\nneedle (x)\n');
  await f.put('keep.md', 'Needle md\n');
  const tool = createGrepTool();
  const names = (r) => linesOf(r).map((l) => ANCHOR.exec(l)[1]).sort();
  assert.deepEqual(names(await run(tool, { pattern: 'Needle' }, f.api)), ['.hidden.txt', 'keep.md', 'keep.txt']);
  assert.deepEqual(names(await run(tool, { pattern: 'Needle', glob: '*.md' }, f.api)), ['keep.md']);
  assert.equal(linesOf(await run(tool, { pattern: 'needle', path: 'keep.txt', ignoreCase: true }, f.api)).length, 2);
  assert.equal(linesOf(await run(tool, { pattern: 'needle', path: 'keep.txt' }, f.api)).length, 1);
  assert.equal(linesOf(await run(tool, { pattern: '(x)', path: 'keep.txt', literal: true }, f.api)).length, 2);
  await assert.rejects(run(tool, { pattern: '(unclosed', path: 'keep.txt' }, f.api), /ripgrep:.*literal/s);
});

test('rg: results come back sorted by path and line', needRg, async (t) => {
  const f = await fixture(t);
  for (const name of ['z.txt', 'm.txt', 'a.txt', 'k.txt']) await f.put(name, Array.from({ length: 20 }, () => 'hit').join('\n') + '\n');
  const rows = linesOf(await run(createGrepTool(), { pattern: 'hit' }, f.api)).map((l) => ANCHOR.exec(l));
  const keys = rows.map((m) => [m[1], Number(m[2])]);
  const sorted = [...keys].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
  assert.deepEqual(keys, sorted);
  assert.equal(keys.length, 80);
});

test('rg: result count is capped and the notice says to narrow', needRg, async (t) => {
  const f = await fixture(t);
  await f.put('many.txt', Array.from({ length: 500 }, (_, i) => `hit ${i}`).join('\n') + '\n');
  const out = await run(createGrepTool(), { pattern: 'hit' }, f.api);
  assert.equal(linesOf(out).length, 200);
  assert.match(out.diagnostics[0].message, /Stopped at 200 matching lines\. Narrow/);
  const small = await run(createGrepTool({ limit: 3 }), { pattern: 'hit' }, f.api);
  assert.equal(linesOf(small).length, 3);
});

test('rg: sensitive files are dropped, a sensitive root is refused', needRg, async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-grep-sens-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'providers.json'), 'SECRETVALUE\n');
  const f = await fixture(t, { dataDir });
  await f.put('ok.txt', 'SECRETVALUE ok\n');
  if (process.platform !== 'win32') await symlink(path.join(dataDir, 'providers.json'), path.join(f.ws, 'link.json'));
  const tool = createGrepTool();
  // the data dir is outside the workspace: reachable by rg only when searched explicitly
  await assert.rejects(run(tool, { pattern: 'SECRETVALUE', path: dataDir }, f.api), /E_SENSITIVE/);
  const out = await run(tool, { pattern: 'SECRETVALUE' }, f.api);
  assert.deepEqual(linesOf(out).map((l) => ANCHOR.exec(l)[1]), ['ok.txt']);
});

test('rg: spawn gets the allow-listed environment, not secrets', needRg, async (t) => {
  const f = await fixture(t);
  await f.put('a.txt', 'x\n');
  if (process.platform === 'win32') return;
  const dump = path.join(f.base, 'fake-rg.sh');
  const dumpOut = path.join(f.base, 'env.txt');
  await writeFile(dump, `#!/bin/sh\nenv > "${dumpOut}"\nexit 1\n`);
  await chmod(dump, 0o755);
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-leak';
  process.env.WEFT_TOKEN = 'weft-leak';
  try {
    await run(createGrepTool({ ripgrep: () => dump }), { pattern: 'x' }, f.api);
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved;
    delete process.env.WEFT_TOKEN;
  }
  const { readFile } = await import('node:fs/promises');
  const dumped = await readFile(dumpOut, 'utf8');
  assert.ok(dumped.includes('PATH='));
  assert.equal(/sk-leak|weft-leak/.test(dumped), false);
});

test('missing ripgrep binary falls back to the JS scan', async (t) => {
  const f = await fixture(t);
  await f.put('a.txt', 'find me\n');
  const out = await run(createGrepTool({ ripgrep: () => path.join(f.base, 'no-such-rg') }), { pattern: 'find' }, f.api);
  assert.match(out.output[0].text, /^a\.txt:1#[A-Z]{3}:find me$/);
});

test('js fallback: anchors, glob, skips .git/node_modules/binaries, cap, literal fallback for bad regex', async (t) => {
  const f = await fixture(t);
  await f.put('a.js', 'alpha\nbeta alpha\n');
  await f.put('a.md', 'alpha\n');
  await f.put('node_modules/p/i.js', 'alpha\n');
  await f.put('.git/x', 'alpha\n');
  await f.put('bin', Buffer.concat([Buffer.from('alpha'), Buffer.from([0])]));
  const tool = withoutRg();
  const all = linesOf(await run(tool, { pattern: 'alpha' }, f.api)).map((l) => ANCHOR.exec(l)[1]).sort();
  assert.deepEqual(all, ['a.js', 'a.js', 'a.md']);
  assert.deepEqual(linesOf(await run(tool, { pattern: 'alpha', glob: '*.md' }, f.api)).map((l) => ANCHOR.exec(l)[1]), ['a.md']);
  assert.equal(linesOf(await run(tool, { pattern: 'ALPHA', ignoreCase: true, path: 'a.md' }, f.api)).length, 1);
  assert.equal(linesOf(await run(tool, { pattern: '(', path: 'a.md' }, f.api)).length, 0);
  await f.put('many.txt', Array.from({ length: 300 }, () => 'zed').join('\n') + '\n');
  const capped = await run(withoutRg(), { pattern: 'zed' }, f.api);
  assert.equal(linesOf(capped).length, 200);
  assert.match(capped.diagnostics[0].message, /Narrow/);
});

test('js fallback: sensitive root refused, sensitive files dropped', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'piw-grep-sens2-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'providers.json'), 'SECRETVALUE\n');
  const f = await fixture(t, { dataDir });
  await f.put('ok.txt', 'SECRETVALUE ok\n');
  await assert.rejects(run(withoutRg(), { pattern: 'SECRETVALUE', path: dataDir }, f.api), /E_SENSITIVE/);
  const out = await run(withoutRg(), { pattern: 'SECRETVALUE', path: f.base }, f.api);
  assert.deepEqual(linesOf(out).map((l) => ANCHOR.exec(l)[1].replaceAll('\\', '/').split('/').pop()), ['ok.txt']);
});

// --- GBK (intranet): rg matches bytes, so Chinese patterns need a gbk pass ---

async function gbkFixture(t) {
  const { default: iconv } = await import('iconv-lite');
  const f = await fixture(t);
  const putGbk = async (rel, text) => {
    const file = path.join(f.ws, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, iconv.encode(text, 'gbk'));
  };
  const previous = process.env.WEFT_TEXT_ENCODING_DETECT;
  process.env.WEFT_TEXT_ENCODING_DETECT = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.WEFT_TEXT_ENCODING_DETECT;
    else process.env.WEFT_TEXT_ENCODING_DETECT = previous;
  });
  return { ...f, putGbk };
}

/** A rg wrapper script that logs one line per invocation, then runs the real rg. */
async function countingRg(f) {
  const log = path.join(f.base, 'rg-calls.log');
  const script = path.join(f.base, 'rg-count.sh');
  await writeFile(script, `#!/bin/sh\necho call >> "${log}"\nexec "${rg}" "$@"\n`);
  await chmod(script, 0o755);
  const calls = async () => {
    const { readFile } = await import('node:fs/promises');
    return (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  };
  return { script, calls };
}

test('gbk: a Chinese pattern finds hits in GBK and UTF-8 files, each once', needRg, async (t) => {
  const f = await gbkFixture(t);
  await f.putGbk('old.py', '第一行\n打印("你好世界")\n第三行\n');
  await f.put('new.py', '# 你好世界\nprint(1)\n');
  const out = await run(createGrepTool({ gbkSearch: () => true }), { pattern: '你好世界' }, f.api);
  const rows = linesOf(out).map((l) => ANCHOR.exec(l));
  assert.deepEqual(rows.map((m) => [m[1], m[2], m[4]]), [
    ['new.py', '1', '# 你好世界'],
    ['old.py', '2', '打印("你好世界")'],
  ]);
});

test('gbk: the gbk pass does not mis-hit UTF-8 files', needRg, async (t) => {
  const f = await gbkFixture(t);
  // UTF-8 bytes of 你 are E4 BD A0; read as GBK they decode to other characters.
  const { default: iconv } = await import('iconv-lite');
  const garbled = iconv.decode(Buffer.from('你好', 'utf8'), 'gbk');
  await f.put('utf8.txt', '你好\n');
  const out = await run(createGrepTool({ gbkSearch: () => true }), { pattern: garbled }, f.api);
  assert.equal(linesOf(out).length, 0);
});

test('gbk: an ASCII pattern runs ripgrep once; a Chinese one twice', needRg, async (t) => {
  const f = await gbkFixture(t);
  await f.putGbk('a.txt', 'hello 世界\n');
  const counter = await countingRg(f);
  const tool = createGrepTool({ ripgrep: () => counter.script, gbkSearch: () => true });
  await run(tool, { pattern: 'hello' }, f.api);
  assert.equal(await counter.calls(), 1);
  await run(tool, { pattern: '世界' }, f.api);
  assert.equal(await counter.calls(), 3);
  const off = createGrepTool({ ripgrep: () => counter.script, gbkSearch: () => false });
  await run(off, { pattern: '世界' }, f.api);
  assert.equal(await counter.calls(), 4);
});

test('gbk: the JS fallback finds Chinese in a GBK file through the env decoding', async (t) => {
  const f = await gbkFixture(t);
  await f.putGbk('a.txt', '第一行\n你好世界\n');
  const out = await run(withoutRg(), { pattern: '你好' }, f.api);
  const rows = linesOf(out).map((l) => ANCHOR.exec(l));
  assert.deepEqual(rows.map((m) => [m[1], m[2], m[4]]), [['a.txt', '2', '你好世界']]);
});
