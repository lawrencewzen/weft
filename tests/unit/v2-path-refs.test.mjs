import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { compileSchema } from '../../src/v2/validate.ts';
import { ROOT } from './_root.mjs';
import {
  parseLineSuffix,
  resolvePathRef,
  extractPathRefs,
} from '../../src/v2/views/path-refs.ts';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validatePathRef = compileSchema(structuredClone(spec.components.schemas.PathRef));

function assertPathRef(value) {
  assert.equal(validatePathRef(value), true, JSON.stringify(validatePathRef.errors));
}

const tree = [
  { path: 'package.json', type: 'file' },
  { path: 'README.md', type: 'file' },
  { path: 'public', type: 'dir' },
  { path: 'public/app.css', type: 'file' },
  { path: 'src/x.mjs', type: 'file' },
  { path: 'secret.txt', type: 'file' },
];

const linux = { tree, workspacePath: '/home/me/proj' };
const win = { tree, workspacePath: 'C:\\Users\\me\\proj' };

test('parseLineSuffix splits :12, :12:3, and #L12', () => {
  assert.deepEqual(parseLineSuffix('public/app.css:12'), {
    path: 'public/app.css', line: 12, suffix: ':12',
  });
  assert.deepEqual(parseLineSuffix('public/app.css:12:3'), {
    path: 'public/app.css', line: 12, suffix: ':12:3',
  });
  assert.deepEqual(parseLineSuffix('src/x.mjs#L12'), {
    path: 'src/x.mjs', line: 12, suffix: '#L12',
  });
  assert.deepEqual(parseLineSuffix('package.json'), {
    path: 'package.json', line: undefined, suffix: '',
  });
});

test('existing files without a slash become chips', () => {
  assert.deepEqual(resolvePathRef('package.json', linux), { path: 'package.json' });
  assert.deepEqual(resolvePathRef('README.md', linux), { path: 'README.md' });
});

test('relative paths with line numbers resolve', () => {
  assert.deepEqual(resolvePathRef('public/app.css', linux), { path: 'public/app.css' });
  assert.deepEqual(resolvePathRef('public/app.css:446', linux), { path: 'public/app.css', line: 446 });
  assert.deepEqual(resolvePathRef('public/app.css:12:3', linux), { path: 'public/app.css', line: 12 });
  assert.deepEqual(resolvePathRef('src/x.mjs#L12', linux), { path: 'src/x.mjs', line: 12 });
});

test('leading ./ and Windows backslashes normalize', () => {
  assert.deepEqual(resolvePathRef('./src/x.mjs', linux), { path: 'src/x.mjs' });
  assert.deepEqual(resolvePathRef('public\\app.css', linux), { path: 'public/app.css' });
  assert.deepEqual(resolvePathRef('.\\src\\x.mjs:4', linux), { path: 'src/x.mjs', line: 4 });
});

test('absolute path inside the workspace becomes relative', () => {
  assert.deepEqual(
    resolvePathRef('/home/me/proj/public/app.css', linux),
    { path: 'public/app.css' },
  );
  assert.deepEqual(
    resolvePathRef('/home/me/proj/src/x.mjs:9', linux),
    { path: 'src/x.mjs', line: 9 },
  );
});

test('Windows drive letter comparison is case-insensitive', () => {
  assert.deepEqual(
    resolvePathRef('C:\\Users\\me\\proj\\public\\app.css', win),
    { path: 'public/app.css' },
  );
  assert.deepEqual(
    resolvePathRef('c:/users/me/PROJ/src/x.mjs:3', win),
    { path: 'src/x.mjs', line: 3 },
  );
  assert.deepEqual(
    resolvePathRef('Public/App.css', win),
    { path: 'public/app.css' },
  );
});

test('Mac/Linux path comparison is case-sensitive', () => {
  assert.equal(resolvePathRef('Public/App.css', linux), null);
  assert.equal(resolvePathRef('/home/me/PROJ/public/app.css', linux), null);
});

test('absolute path outside the workspace is not a chip', () => {
  assert.equal(resolvePathRef('/etc/secret.txt', linux), null);
  assert.equal(resolvePathRef('/home/me/other/public/app.css', linux), null);
  assert.equal(resolvePathRef('D:\\other\\secret.txt', win), null);
  assert.equal(resolvePathRef('C:\\Users\\me\\other\\secret.txt', win), null);
});

test('missing files, URLs, spaces, and extensionless words stay plain', () => {
  assert.equal(resolvePathRef('nope.missing', linux), null);
  assert.equal(resolvePathRef('https://example.com/x.js', linux), null);
  assert.equal(resolvePathRef('http://host/app.css', linux), null);
  assert.equal(resolvePathRef('public/app.css extra', linux), null);
  assert.equal(resolvePathRef('npm', linux), null);
  assert.equal(resolvePathRef('Makefile', linux), null);
  assert.equal(resolvePathRef('', linux), null);
});

test('directories are not clickable files', () => {
  assert.equal(resolvePathRef('public', linux), null);
});

test('click-time resolvePathRef rejects forged data-path outside the workspace', () => {
  assert.equal(resolvePathRef('../secret.txt', linux), null);
  assert.equal(resolvePathRef('..\\secret.txt', linux), null);
  assert.equal(resolvePathRef('public/../../secret.txt', linux), null);
  assert.equal(resolvePathRef('../secret.txt', win), null);
  assert.equal(resolvePathRef('C:\\Users\\me\\proj\\..\\secret.txt', win), null);
  assert.equal(resolvePathRef('/etc/secret.txt', linux), null);
  assert.deepEqual(resolvePathRef('secret.txt', linux), { path: 'secret.txt' });
});

async function makeWorkspace() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'weft-pathrefs-'));
  const workspacePath = path.join(base, 'ws');
  await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspacePath, 'public'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'package.json'), '{}\n');
  await fs.writeFile(path.join(workspacePath, 'README.md'), '# hi\n');
  await fs.writeFile(path.join(workspacePath, 'src', 'x.mjs'), 'export {}\n');
  await fs.writeFile(path.join(workspacePath, 'public', 'app.css'), 'body{}\n');
  await fs.writeFile(path.join(workspacePath, 'secret.txt'), 'in-ws\n');
  await fs.writeFile(path.join(base, 'secret.txt'), 'outside\n');
  return { base, workspacePath: await fs.realpath(workspacePath) };
}

test('extractPathRefs finds existing inline paths and skips the rest', async () => {
  const { base, workspacePath } = await makeWorkspace();
  const absInside = `${workspacePath}/src/x.mjs`;
  const absOutside = path.join(base, 'secret.txt');
  const markdown = [
    'see `package.json` and `nope.missing`.',
    'line `src/x.mjs:12` and hash `README.md#L3`.',
    'slash `public\\app.css` and abs `' + absInside + '`.',
    'outside `' + absOutside + '` and escape `../secret.txt`.',
    '',
    '```',
    '`src/x.mjs`',
    'package.json',
    '```',
    '',
    '    `README.md`',
    '',
    'again `package.json` and url `https://example.com/x.js`.',
  ].join('\n');

  const refs = await extractPathRefs(markdown, { workspacePath });
  for (const ref of refs) assertPathRef(ref);
  assert.deepEqual(refs, [
    { text: 'package.json', path: 'package.json' },
    { text: 'src/x.mjs:12', path: 'src/x.mjs', line: 12 },
    { text: 'README.md#L3', path: 'README.md', line: 3 },
    { text: 'public\\app.css', path: 'public/app.css' },
    { text: absInside, path: 'src/x.mjs' },
  ]);
});

test('extractPathRefs default exists treats sandbox escapes as missing', async () => {
  const { workspacePath } = await makeWorkspace();
  const refs = await extractPathRefs(
    'escape `../secret.txt` and `public/../../secret.txt` and `secret.txt`.',
    { workspacePath },
  );
  for (const ref of refs) assertPathRef(ref);
  assert.deepEqual(refs, [{ text: 'secret.txt', path: 'secret.txt' }]);
});

function fileHref(abs, hash = '') {
  return pathToFileURL(abs).href + hash;
}

test('extractPathRefs reads a file:// link with #L1-L3 as the start line', async () => {
  const { workspacePath } = await makeWorkspace();
  const abs = path.join(workspacePath, 'calc.py');
  await fs.writeFile(abs, 'print(1)\n');
  const href = fileHref(abs, '#L1-L3');
  const refs = await extractPathRefs(
    `在 [calc.py](${href}) 中发现了 Bug`,
    { workspacePath },
  );
  for (const ref of refs) assertPathRef(ref);
  assert.deepEqual(refs, [
    { text: href, path: 'calc.py', line: 1 },
  ]);
});

test('extractPathRefs decodes percent-encoded spaces and Chinese in file links', async () => {
  const { workspacePath } = await makeWorkspace();
  const name = '我的 笔记.py';
  const abs = path.join(workspacePath, name);
  await fs.writeFile(abs, 'x\n');
  const href = fileHref(abs, '#L12-L20');
  const refs = await extractPathRefs(`[note](${href})`, { workspacePath });
  for (const ref of refs) assertPathRef(ref);
  assert.equal(href.includes('%20'), true);
  assert.match(href, /%[0-9A-Fa-f]{2}/);
  assert.equal(href.includes(name), false);
  assert.deepEqual(refs, [
    { text: href, path: name, line: 12 },
  ]);
});

test('extractPathRefs reads Windows file:///C:/ links inside the workspace', async () => {
  const ranged = 'file:///C:/Users/me/proj/src/x.mjs#L12-20';
  const lower = 'file:///c:/users/me/proj/public/app.css';
  const colon = 'file:///C:/Users/me/proj/README.md:3';
  const calls = [];
  const refs = await extractPathRefs(
    `[a](${ranged}) [b](file:///D:/other/secret.txt) [c](${lower}) [d](${colon}) [e](file:///C:/Users/me/proj/nope.missing)`,
    {
      workspacePath: 'C:\\Users\\me\\proj',
      exists: async (rel) => {
        calls.push(rel);
        return rel === 'src/x.mjs' || rel === 'public/app.css' || rel === 'README.md';
      },
    },
  );
  for (const ref of refs) assertPathRef(ref);
  assert.deepEqual(refs, [
    { text: ranged, path: 'src/x.mjs', line: 12 },
    { text: lower, path: 'public/app.css' },
    { text: colon, path: 'README.md', line: 3 },
  ]);
  assert.deepEqual(calls, ['src/x.mjs', 'public/app.css', 'README.md', 'nope.missing']);
});

test('extractPathRefs reads relative and in-workspace absolute link hrefs', async () => {
  const { workspacePath } = await makeWorkspace();
  const root = workspacePath.replaceAll('\\', '/');
  const abs = `${root}/src/x.mjs#L4`;
  const markdown = [
    '[css](public/app.css)',
    '[rel](./src/x.mjs#L12-L20)',
    '[short](src/x.mjs#L12-20)',
    '[colon](README.md:3)',
    '[colon2](public/app.css:12:3)',
    '[colon3](src/x.mjs:12)',
    `[abs](${abs})`,
    '[dot](./package.json)',
    String.raw`[slash](public\app.css)`,
  ].join('\n');
  const refs = await extractPathRefs(markdown, { workspacePath });
  for (const ref of refs) assertPathRef(ref);
  assert.deepEqual(refs, [
    { text: 'public/app.css', path: 'public/app.css' },
    { text: './src/x.mjs#L12-L20', path: 'src/x.mjs', line: 12 },
    { text: 'src/x.mjs#L12-20', path: 'src/x.mjs', line: 12 },
    { text: 'README.md:3', path: 'README.md', line: 3 },
    { text: 'public/app.css:12:3', path: 'public/app.css', line: 12 },
    { text: 'src/x.mjs:12', path: 'src/x.mjs', line: 12 },
    { text: abs, path: 'src/x.mjs', line: 4 },
    { text: './package.json', path: 'package.json' },
    { text: String.raw`public\app.css`, path: 'public/app.css' },
  ]);
});

test('extractPathRefs drops outside, missing, protocol, and directory links', async () => {
  const { base, workspacePath } = await makeWorkspace();
  await fs.mkdir(path.join(workspacePath, 'notfile.txt'));
  const outside = fileHref(path.join(base, 'secret.txt'));
  const missing = fileHref(path.join(workspacePath, 'nope.missing'), '#L1-L3');
  const dirUrl = fileHref(path.join(workspacePath, 'public'));
  const markdown = [
    `[out](${outside})`,
    `[miss](${missing})`,
    '[relmiss](nope.missing)',
    '[http](https://example.com/src/x.mjs)',
    '[http2](http://host/app.css)',
    '[mail](mailto:a@b.com)',
    '[js](javascript:alert(1))',
    '[dir](public)',
    `[dirurl](${dirUrl})`,
    '[fake](notfile.txt)',
    '[dot](../secret.txt)',
    '[dot2](public/../../secret.txt)',
    '![img](package.json)',
    '```',
    '[x](package.json)',
    '```',
  ].join('\n');
  const refs = await extractPathRefs(markdown, { workspacePath });
  assert.deepEqual(refs, []);
});

test('extractPathRefs keeps inline-code results and emits one ref for a repeated text', async () => {
  const { workspacePath } = await makeWorkspace();
  const same = await extractPathRefs(
    'see `package.json` and [pkg](package.json). range `src/x.mjs#L1-L3` stays plain. `src/x.mjs:12`.',
    { workspacePath },
  );
  for (const ref of same) assertPathRef(ref);
  assert.deepEqual(same, [
    { text: 'package.json', path: 'package.json' },
    { text: 'src/x.mjs:12', path: 'src/x.mjs', line: 12 },
  ]);

  const linkFirst = await extractPathRefs(
    '[pkg](package.json) then `package.json`',
    { workspacePath },
  );
  assert.deepEqual(linkFirst, [
    { text: 'package.json', path: 'package.json' },
  ]);
});
