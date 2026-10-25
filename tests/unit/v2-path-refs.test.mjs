import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
