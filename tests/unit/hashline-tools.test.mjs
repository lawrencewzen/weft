// hashline read / edit tools through a workspace ExecutionEnv.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { renderRead } from '../../src/kernel/hashline-tools.mjs';
import { workspaceTools } from '../../src/kernel/tools.mjs';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';

const tool = (name) => workspaceTools().find((t) => t.name === name);

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-hl-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  t.after(async () => {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const api = { env, agent: async () => ({}), models: { getModel: () => undefined }, output() {}, retainedOutput: () => ({ text: '', truncated: false }), diagnostic() {} };
  const run = (name, args) => {
    const t2 = tool(name);
    return t2.execute(t2.prepareArguments ? t2.prepareArguments(args) : args, api, BACKGROUND_CONTEXT);
  };
  const put = (name, text) => writeFile(path.join(dir, name), text);
  const get = (name) => readFile(path.join(dir, name), 'utf8');
  return { dir, run, put, get };
}

const textOf = (result) => result.output.map((b) => b.text ?? '').join('\n');
const anchorLine = (readText, n) => readText.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`${n}#`));
const anchorOnly = (line) => line.slice(0, line.indexOf(':'));

test('read prints LINE#HASH anchors and works on CRLF files', async (t) => {
  const f = await fixture(t);
  await f.put('a.txt', 'one\r\ntwo\r\nthree\r\n');
  const out = textOf(await f.run('read', { path: 'a.txt' }));
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^1#[A-Z]{3}:one$/);
  assert.match(lines[2], /^3#[A-Z]{3}:three$/);
  assert.equal(out.includes('\r'), false);
});

test('read pages with offset and limit and names the next offset', async (t) => {
  const f = await fixture(t);
  await f.put('big.txt', Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');
  const page = await f.run('read', { path: 'big.txt', offset: 11, limit: 5 });
  const lines = textOf(page).split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^11#[A-Z]{3}:row 11$/);
  assert.match(page.diagnostics[0].message, /offset=16/);
  await assert.rejects(f.run('read', { path: 'big.txt', offset: 99 }), /beyond end of file/);
});

test('read truncates at 2000 lines and 50KB with a continuation notice', () => {
  const many = Array.from({ length: 2500 }, (_, i) => `l${i}`);
  const r = renderRead(many, {});
  assert.equal(textOf(r).split('\n').length, 2000);
  assert.match(r.diagnostics[0].message, /Showing lines 1-2000 of 2500\. Use offset=2001/);
  const wide = Array.from({ length: 100 }, () => 'x'.repeat(1000));
  const w = renderRead(wide, {});
  assert.match(w.diagnostics[0].message, /50KB limit/);
  assert.ok(Buffer.byteLength(textOf(w)) <= 50 * 1024);
  const one = renderRead(['y'.repeat(60 * 1024)], {});
  assert.ok(Buffer.byteLength(textOf(one)) <= 50 * 1024);
  assert.equal(one.diagnostics[0].severity, 'warn');
});

test('read: empty file advisory, binary refused, directory refused, image goes to the official tool', async (t) => {
  const f = await fixture(t);
  await f.put('empty.txt', '');
  const empty = await f.run('read', { path: 'empty.txt' });
  assert.equal(textOf(empty), '');
  assert.match(empty.diagnostics[0].message, /empty/i);
  await f.put('bin.dat', Buffer.from([1, 2, 0, 3, 4]));
  await assert.rejects(f.run('read', { path: 'bin.dat' }), /binary file/);
  await assert.rejects(f.run('read', { path: '.' }), /directory/);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await f.put('pixel.png', png);
  const image = await f.run('read', { path: 'pixel.png' });
  assert.equal(image.output[0].type, 'image');
  assert.equal(image.output[0].mimeType, 'image/png');
});

test('edit: replace by anchor writes the file, keeps CRLF and the BOM, and returns fresh anchors', async (t) => {
  const f = await fixture(t);
  await f.put('a.txt', '﻿one\r\ntwo\r\nthree\r\n');
  const read = textOf(await f.run('read', { path: 'a.txt' }));
  const pos = anchorOnly(anchorLine(read, 2));
  const result = await f.run('edit', { path: 'a.txt', edits: [{ op: 'replace', pos, lines: ['TWO', 'TWO-b'] }] });
  assert.equal(await f.get('a.txt'), '﻿one\r\nTWO\r\nTWO-b\r\nthree\r\n');
  const text = textOf(result);
  assert.match(text, /^Edited a\.txt \(\+2 −1\)/);
  assert.match(text, /--- Anchors 1-4 ---/);
  assert.match(text, /2#[A-Z]{3}:TWO\n/);
  assert.equal(result.details.path, 'a.txt');
});

test('edit: insert, delete a range, and several edits in one call', async (t) => {
  const f = await fixture(t);
  await f.put('b.txt', 'a\nb\nc\nd\ne\n');
  const read = textOf(await f.run('read', { path: 'b.txt' }));
  const a = (n) => anchorOnly(anchorLine(read, n));
  await f.run('edit', {
    path: 'b.txt',
    edits: [
      { op: 'append', pos: a(1), lines: ['a2'] },
      { op: 'replace', pos: a(3), end: a(4), lines: [] },
      { op: 'prepend', lines: ['top'] },
      { op: 'append', lines: ['end'] },
    ],
  });
  assert.equal(await f.get('b.txt'), 'top\na\na2\nb\ne\nend\n');
});

test('edit: a stale anchor is refused and the file stays unchanged', async (t) => {
  const f = await fixture(t);
  await f.put('c.txt', 'x\ny\nz\n');
  const read = textOf(await f.run('read', { path: 'c.txt' }));
  const pos = anchorOnly(anchorLine(read, 2));
  await f.put('c.txt', 'x\nchanged\nz\n');
  await assert.rejects(
    f.run('edit', { path: 'c.txt', edits: [{ op: 'replace', pos, lines: ['Y'] }] }),
    /E_STALE_ANCHOR.*Re-read the file/,
  );
  assert.equal(await f.get('c.txt'), 'x\nchanged\nz\n');
});

test('edit: no-op, missing file, missing edits, and null lines', async (t) => {
  const f = await fixture(t);
  await f.put('d.txt', 'p\nq\n');
  const read = textOf(await f.run('read', { path: 'd.txt' }));
  const noop = await f.run('edit', { path: 'd.txt', edits: [{ op: 'replace', pos: anchorOnly(anchorLine(read, 1)), lines: ['p'] }] });
  assert.match(textOf(noop), /No changes made/);
  await assert.rejects(f.run('edit', { path: 'nope.txt', edits: [{ op: 'append', lines: ['x'] }] }), /File not found/);
  await assert.rejects(f.run('edit', { path: 'd.txt', edits: [] }), /No edits/);
  assert.throws(() => tool('edit').prepareArguments({ path: 'd.txt', edits: [{ op: 'append', lines: null }] }), /"lines" is null/);
});

test('edit: old oldText/newText calls still run with the old semantics (replay and old history)', async (t) => {
  const f = await fixture(t);
  await f.put('e.txt', 'alpha\r\nbeta\r\n');
  const result = await f.run('edit', { path: 'e.txt', edits: [{ oldText: 'beta', newText: 'BETA' }] });
  assert.equal(await f.get('e.txt'), 'alpha\r\nBETA\r\n');
  assert.match(textOf(result), /Successfully replaced 1 block/);
  assert.equal(result.details.before, 'alpha\r\nbeta\r\n');
  assert.equal(result.details.after, 'alpha\r\nBETA\r\n');
  // top-level oldText/newText and the previous { old, new } spelling
  await f.run('edit', { path: 'e.txt', oldText: 'alpha', newText: 'ALPHA' });
  await f.run('edit', { path: 'e.txt', old: 'BETA', new: 'beta2' });
  assert.equal(await f.get('e.txt'), 'ALPHA\r\nbeta2\r\n');
  await assert.rejects(
    f.run('edit', { path: 'e.txt', edits: [{ oldText: 'ALPHA', newText: 'a' }, { op: 'append', lines: ['x'] }] }),
    /Do not mix/,
  );
});

test('edit stays inside the workspace and read of the same path is allowed', async (t) => {
  const f = await fixture(t);
  await f.put('../hl-outside.txt', 'o\n').catch(() => {});
  const read = textOf(await f.run('read', { path: '../hl-outside.txt' }).catch(() => ({ output: [{ text: '' }] })));
  const pos = anchorOnly(anchorLine(read, 1) ?? '1#ZZZ:');
  await assert.rejects(f.run('edit', { path: '../hl-outside.txt', edits: [{ op: 'replace', pos, lines: ['x'] }] }), /E_SANDBOX/);
  await rm(path.join(f.dir, '..', 'hl-outside.txt'), { force: true });
});

test('edit and grep schemas carry the optional intent description; read/grep replay safely, edit does not', () => {
  for (const name of ['read', 'edit', 'grep']) {
    assert.ok(tool(name).parameters.properties.description, name);
  }
  assert.equal(tool('edit').replay, 'unsafe');
  assert.equal(tool('read').replay, 'safe');
  assert.equal(tool('grep').replay, 'safe');
});
