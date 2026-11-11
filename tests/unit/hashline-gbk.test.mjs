// hashline read / edit keep GBK + CRLF files intact: the encoding handling
// lives in the workspace env (workspace-env.mjs), not in the tools.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import iconv from 'iconv-lite';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { workspaceTools } from '../../src/kernel/tools.mjs';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';

const tool = (name) => workspaceTools().find((t) => t.name === name);

async function fixture(t) {
  const previous = process.env.WEFT_TEXT_ENCODING_DETECT;
  process.env.WEFT_TEXT_ENCODING_DETECT = '1';
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-hl-gbk-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  t.after(async () => {
    if (previous === undefined) delete process.env.WEFT_TEXT_ENCODING_DETECT;
    else process.env.WEFT_TEXT_ENCODING_DETECT = previous;
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const api = { env, agent: async () => ({}), models: { getModel: () => undefined }, output() {}, retainedOutput: () => ({ text: '', truncated: false }), diagnostic() {} };
  const run = (name, args) => {
    const x = tool(name);
    return x.execute(x.prepareArguments ? x.prepareArguments(args) : args, api, BACKGROUND_CONTEXT);
  };
  return { dir, run };
}

const textOf = (result) => result.output.map((b) => b.text ?? '').join('\n');

test('hashline read shows GBK Chinese correctly and edit keeps GBK + CRLF', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.dir, 'notes.py');
  await writeFile(file, iconv.encode('第一行：你好\r\n第二行：世界\r\n第三行：镕〇\r\n', 'gbk'));
  const out = textOf(await f.run('read', { path: 'notes.py' }));
  const lines = out.split('\n');
  assert.match(lines[0], /^1#[A-Z]{3}:第一行：你好$/);
  assert.match(lines[2], /^3#[A-Z]{3}:第三行：镕〇$/);
  const pos = lines[1].slice(0, lines[1].indexOf(':'));
  await f.run('edit', { path: 'notes.py', edits: [{ op: 'replace', pos, lines: ['第二行：已改动'] }] });
  const bytes = await readFile(file);
  assert.equal(iconv.decode(bytes, 'gbk'), '第一行：你好\r\n第二行：已改动\r\n第三行：镕〇\r\n');
  assert.equal(bytes.toString('utf8').includes('第'), false);
});
