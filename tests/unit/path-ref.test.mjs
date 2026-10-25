import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLineSuffix, resolvePathRef } from '../../public/path-ref.js';

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
