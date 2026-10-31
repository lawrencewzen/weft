import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import {
  NODE_VERSION,
  OPTIONAL_APP_PATHS,
  REQUIRED_APP_PATHS,
  assertNodeVersion,
  expectedSha256,
  extractZipEntry,
  findBannedPackages,
  listZipEntries,
  parsePackArgs,
  readmeText,
  sha256Hex,
  windowsCmd,
  zipDirectory,
} from '../../scripts/pack-release.mjs';

test('Node pin is a 22.x release at or above 22.19', () => {
  assert.equal(NODE_VERSION, '22.23.4');
  assert.doesNotThrow(() => assertNodeVersion(NODE_VERSION));
  assert.doesNotThrow(() => assertNodeVersion('22.19.0'));
  assert.throws(() => assertNodeVersion('22.18.0'), /22\.19/);
  assert.throws(() => assertNodeVersion('23.1.0'), /22\.19/);
  assert.throws(() => assertNodeVersion('v22.23.4'), /无效/);
});

test('parsePackArgs accepts win-x64 and rejects other platforms', () => {
  const args = parsePackArgs(['--platform', 'win-x64', '--out', 'dist/', '--node-version', '22.23.4']);
  assert.deepEqual(args, { platform: 'win-x64', nodeVersion: '22.23.4', out: 'dist/' });
  const defaults = parsePackArgs(['--platform', 'win-x64', '--out', 'dist']);
  assert.equal(defaults.nodeVersion, NODE_VERSION);
  assert.throws(() => parsePackArgs(['--platform', 'linux-x64', '--out', 'dist']), /win-x64/);
  assert.throws(() => parsePackArgs(['--out', 'dist']), /win-x64/);
  assert.throws(() => parsePackArgs(['--platform', 'win-x64']), /--out/);
});

test('expectedSha256 reads official SHASUMS lines', () => {
  const text = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  node-v22.23.4-win-x64.zip',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *win-x64/node.exe',
    'not a hash line',
    '',
  ].join('\n');
  assert.equal(expectedSha256(text, 'node-v22.23.4-win-x64.zip'), 'a'.repeat(64));
  assert.equal(expectedSha256(text, 'win-x64/node.exe'), 'b'.repeat(64));
  assert.equal(expectedSha256(text, 'missing.zip'), null);
});

test('launchers quote paths, keep an existing data dir, and stay ASCII', () => {
  for (const action of ['open', 'stop']) {
    const text = windowsCmd(action);
    assert.equal(text.includes('\r\n'), true);
    assert.equal(text.includes('"%~dp0node\\node.exe"'), true);
    assert.equal(text.includes(`"%~dp0app\\bin\\weft.mjs" ${action}`), true);
    assert.equal(text.includes('if not defined WEFT_DATA_DIR set "WEFT_DATA_DIR=%APPDATA%\\Weft"'), true);
    assert.equal(text.includes('if not "%RC%"=="0" if not defined CI pause'), true);
    assert.equal([...text].some((ch) => ch.charCodeAt(0) > 127), false);
  }
  assert.equal(windowsCmd('open').includes('"%~dp0app\\bin\\weft.mjs" stop'), false);
});

test('README covers start, data dir, upgrade, and stop', () => {
  const text = readmeText('0.1.0');
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.match(text, /启动/);
  assert.match(text, /数据在哪/);
  assert.match(text, /%APPDATA%\\Weft/);
  assert.match(text, /升级/);
  assert.match(text, /停止/);
  assert.match(text, /版本 0\.1\.0/);
  assert.match(text, /WEFT_DATA_DIR/);
});

test('runtime copy list includes the built app and the OpenAPI file the server loads', () => {
  for (const rel of ['server.mjs', 'bin', 'src', 'public-next', 'package.json', 'package-lock.json', 'contract/openapi.json']) {
    assert.equal(REQUIRED_APP_PATHS.includes(rel), true, rel);
  }
  for (const rel of ['web', 'tests', 'docs', 'design', 'examples']) {
    assert.equal(REQUIRED_APP_PATHS.includes(rel), false, rel);
    assert.equal(OPTIONAL_APP_PATHS.includes(rel), false, rel);
  }
  assert.deepEqual(OPTIONAL_APP_PATHS, ['plugins', 'skills']);
});

test('zip roundtrip keeps unicode names and bytes', async () => {
  assert.equal(crc32(Buffer.from('123456789')) >>> 0, 0xcbf43926);
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-zip-'));
  const zipPath = path.join(tmpdir(), `weft-zip-out-${path.basename(dir)}.zip`);
  try {
    const nested = path.join(dir, 'weft smoke 中文');
    await mkdir(nested);
    const note = Buffer.from('hello 中文\n', 'utf8');
    await writeFile(path.join(nested, 'note.txt'), note);
    const bin = Buffer.from([0, 1, 2, 255, 10, 13]);
    await writeFile(path.join(dir, 'bin.dat'), bin);
    await zipDirectory(dir, zipPath);
    const packed = await readFile(zipPath);
    const names = listZipEntries(packed).map((entry) => entry.name).sort();
    assert.deepEqual(names, ['bin.dat', 'weft smoke 中文/note.txt']);
    assert.deepEqual(extractZipEntry(packed, 'weft smoke 中文/note.txt'), note);
    assert.deepEqual(extractZipEntry(packed, 'bin.dat'), bin);
    assert.equal(sha256Hex(note).length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(zipPath, { force: true });
  }
});

test('findBannedPackages flags vite and ignores runtime packages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-nm-'));
  try {
    const nm = path.join(dir, 'node_modules');
    await mkdir(path.join(nm, 'ajv'), { recursive: true });
    await mkdir(path.join(nm, 'vite'), { recursive: true });
    await mkdir(path.join(nm, '@earendil-works', 'pi-durable'), { recursive: true });
    await writeFile(path.join(nm, 'ajv', 'package.json'), JSON.stringify({ name: 'ajv', version: '8.0.0' }));
    await writeFile(path.join(nm, 'vite', 'package.json'), JSON.stringify({ name: 'vite', version: '8.0.0' }));
    await writeFile(
      path.join(nm, '@earendil-works', 'pi-durable', 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-durable', version: '1.3.0' }),
    );
    assert.deepEqual(await findBannedPackages(nm), ['vite']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
