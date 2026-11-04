import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import * as packRelease from '../../scripts/pack-release.mjs';
import {
  NODE_VERSION,
  OPTIONAL_APP_PATHS,
  REQUIRED_APP_PATHS,
  acquireNodeExe,
  assertNodeVersion,
  expectedSha256,
  extractZipEntry,
  findBannedPackages,
  listZipEntries,
  nodeArchiveBases,
  parsePackArgs,
  readmeText,
  resolveNodeDistBase,
  sha256Hex,
  windowsCmd,
  zipDirectory,
} from '../../scripts/pack-release.mjs';

const OFFICIAL_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`;
const OFFICIAL_SUMS = `${OFFICIAL_BASE}/SHASUMS256.txt`;
const ARCHIVE_NAME = `node-v${NODE_VERSION}-win-x64.zip`;
const NPM_MIRROR_ROOT = 'https://npmmirror.com/mirrors/node';
const NPM_MIRROR_BASE = `${NPM_MIRROR_ROOT}/v${NODE_VERSION}`;

async function captureConsole(fn) {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => lines.push(args.map((part) => String(part)).join(' '));
  console.log = record;
  console.warn = record;
  console.error = record;
  try {
    return { value: await fn(), lines, error: null };
  } catch (error) {
    return { value: undefined, lines, error };
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

async function makeNodeArchive(exeBytes) {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-node-src-'));
  const zipPath = path.join(tmpdir(), `weft-node-arc-${path.basename(dir)}.zip`);
  try {
    const folder = path.join(dir, `node-v${NODE_VERSION}-win-x64`);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'node.exe'), exeBytes);
    await zipDirectory(dir, zipPath);
    const zip = await readFile(zipPath);
    const sums = [
      `${sha256Hex(zip)}  ${ARCHIVE_NAME}`,
      `${sha256Hex(exeBytes)}  win-x64/node.exe`,
      '',
    ].join('\n');
    return { exe: exeBytes, zip, sums };
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(zipPath, { force: true });
  }
}

function bytesResponse(buf, status = 200) {
  return new Response(buf, { status });
}

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
  assert.equal(windowsCmd('open').includes('WEFT_PORT'), false);
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
  assert.match(text, /http:\/\/127\.0\.0\.1:3300/);
  assert.match(text, /set WEFT_PORT=/);
  assert.match(text, /只能这台电脑自己访问/);
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

test('downloadVerified is not exported', () => {
  assert.equal('downloadVerified' in packRelease, false);
});

test('official SHASUMS failure does not fetch mirror SHASUMS', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response('missing', { status: 404 });
  };
  const outDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const root = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const { error, lines } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir,
      root,
      fetchImpl,
      env: {
        WEFT_NODE_MIRROR: NPM_MIRROR_ROOT,
        NODE_DIST_URL: `${NPM_MIRROR_ROOT}/`,
      },
    }));
    assert.ok(error instanceof Error);
    assert.match(error.message, /无法获取官方 SHASUMS256\.txt/);
    assert.equal(error.message.includes('npmmirror'), false);
    assert.equal(error.message.includes('备选'), false);
    assert.deepEqual(calls, [OFFICIAL_SUMS, OFFICIAL_SUMS]);
    assert.equal(lines.some((line) => line.includes('npmmirror') || line.includes('SHASUMS256.txt 来自')), false);
    assert.ok(lines.some((line) => line.includes(`获取官方 SHASUMS256.txt：${OFFICIAL_SUMS}`)));
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('tampered mirror zip is rejected and the next source is used', async () => {
  const packed = await makeNodeArchive(Buffer.from('official-node-exe'));
  const mirror = 'https://mirror.example/node';
  const mirrorZip = `${mirror}/v${NODE_VERSION}/${ARCHIVE_NAME}`;
  const officialZip = `${OFFICIAL_BASE}/${ARCHIVE_NAME}`;
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === OFFICIAL_SUMS) return new Response(packed.sums);
    if (target === mirrorZip) return bytesResponse(Buffer.from('tampered-zip'));
    if (target === officialZip) return bytesResponse(packed.zip);
    return new Response('unexpected', { status: 500 });
  };
  const outDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const root = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const { value, error, lines } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir,
      root,
      fetchImpl,
      env: { WEFT_NODE_MIRROR: mirror },
    }));
    assert.equal(error, null);
    assert.deepEqual(value.exe, packed.exe);
    assert.equal(value.zipSource, OFFICIAL_BASE);
    assert.equal(value.sumsNote, '官方 SHASUMS256.txt');
    const zipCalls = calls.filter((url) => url.endsWith('.zip'));
    assert.equal(zipCalls[0], mirrorZip);
    assert.ok(zipCalls.includes(officialZip));
    assert.equal(zipCalls.some((url) => url.startsWith(NPM_MIRROR_BASE)), false);
    assert.deepEqual(calls.filter((url) => url.endsWith('SHASUMS256.txt')), [OFFICIAL_SUMS]);
    assert.ok(lines.some((line) => line === `SHASUMS256.txt 来自官方 ${OFFICIAL_SUMS}`));
    assert.ok(lines.some((line) => line.includes(`${ARCHIVE_NAME} 从 ${officialZip} 下载，sha256 已对照官方 SHASUMS256.txt：`)));
    assert.equal(lines.some((line) => line.includes('已对照官方') && line.includes(mirror)), false);
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('every archive source failing checksum throws', async () => {
  const packed = await makeNodeArchive(Buffer.from('official-node-exe'));
  const mirror = 'https://mirror.example/node';
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === OFFICIAL_SUMS) return new Response(packed.sums);
    if (target.endsWith('.zip')) return bytesResponse(Buffer.from(`tampered:${target}`));
    return new Response('unexpected', { status: 500 });
  };
  const outDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const root = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const { error } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir,
      root,
      fetchImpl,
      env: { WEFT_NODE_MIRROR: `${mirror}/` },
    }));
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`无法从任何源下载并校验 ${ARCHIVE_NAME.replaceAll('.', '\\.')}`));
    const zipCalls = [];
    for (const url of calls) {
      if (url.endsWith('.zip') && !zipCalls.includes(url)) zipCalls.push(url);
    }
    assert.deepEqual(zipCalls, [
      `${mirror}/v${NODE_VERSION}/${ARCHIVE_NAME}`,
      `${OFFICIAL_BASE}/${ARCHIVE_NAME}`,
      `${NPM_MIRROR_BASE}/${ARCHIVE_NAME}`,
    ]);
    assert.deepEqual(calls.filter((url) => url.includes('SHASUMS256.txt')), [OFFICIAL_SUMS]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('a matching mirror zip is kept and the log names official sums plus that mirror', async () => {
  const packed = await makeNodeArchive(Buffer.from('mirrored-node-exe'));
  const mirror = 'https://mirror.example/node';
  const mirrorZip = `${mirror}/v${NODE_VERSION}/${ARCHIVE_NAME}`;
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target === OFFICIAL_SUMS) return new Response(packed.sums);
    if (target === mirrorZip) return bytesResponse(packed.zip);
    throw new Error(`should not fetch ${target}`);
  };
  const outDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const root = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const { value, error, lines } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir,
      root,
      fetchImpl,
      env: { NODE_DIST_URL: mirror },
    }));
    assert.equal(error, null);
    assert.deepEqual(value.exe, packed.exe);
    assert.equal(value.zipSource, `${mirror}/v${NODE_VERSION}`);
    assert.deepEqual(calls, [OFFICIAL_SUMS, mirrorZip]);
    assert.ok(lines.some((line) => line === `SHASUMS256.txt 来自官方 ${OFFICIAL_SUMS}`));
    assert.ok(lines.some((line) => line.includes(`${ARCHIVE_NAME} 从 ${mirrorZip} 下载，sha256 已对照官方 SHASUMS256.txt：`)));
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('NODE_DIST_URL root and versioned forms request the same zip URL', async () => {
  const versioned = NPM_MIRROR_BASE;
  const official = OFFICIAL_BASE;
  assert.equal(resolveNodeDistBase(NPM_MIRROR_ROOT, NODE_VERSION), versioned);
  assert.equal(resolveNodeDistBase(`${NPM_MIRROR_ROOT}/`, NODE_VERSION), versioned);
  assert.equal(resolveNodeDistBase(versioned, NODE_VERSION), versioned);
  assert.equal(resolveNodeDistBase(`${versioned}/`, NODE_VERSION), versioned);
  assert.equal(
    resolveNodeDistBase(`${NPM_MIRROR_ROOT}/v${NODE_VERSION}0`, NODE_VERSION),
    `${NPM_MIRROR_ROOT}/v${NODE_VERSION}0/v${NODE_VERSION}`,
  );
  for (const key of ['NODE_DIST_URL', 'WEFT_NODE_MIRROR']) {
    for (const raw of [NPM_MIRROR_ROOT, `${NPM_MIRROR_ROOT}/`, versioned, `${versioned}/`]) {
      assert.deepEqual(nodeArchiveBases(NODE_VERSION, { [key]: raw }), [versioned, official]);
    }
  }

  const packed = await makeNodeArchive(Buffer.from('node-bytes-for-url'));
  const expectedZip = `${versioned}/${ARCHIVE_NAME}`;
  for (const nodeDist of [NPM_MIRROR_ROOT, `${versioned}/`]) {
    const calls = [];
    const fetchImpl = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target === OFFICIAL_SUMS) return new Response(packed.sums);
      if (target === expectedZip) return bytesResponse(packed.zip);
      return new Response('unexpected', { status: 500 });
    };
    const outDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
    const root = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
    try {
      const { error } = await captureConsole(() => acquireNodeExe({
        nodeVersion: NODE_VERSION,
        outDir,
        root,
        fetchImpl,
        env: { NODE_DIST_URL: nodeDist },
      }));
      assert.equal(error, null);
      assert.equal(calls.find((url) => url.endsWith('.zip')), expectedZip);
      assert.deepEqual(calls.filter((url) => url.endsWith('SHASUMS256.txt')), [OFFICIAL_SUMS]);
    } finally {
      await rm(outDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('node.exe cache mismatch downloads and a match skips the download', async () => {
  const packed = await makeNodeArchive(Buffer.from('cached-or-downloaded-node'));
  const cacheName = `node-${NODE_VERSION}-win-x64.exe`;
  const officialZip = `${OFFICIAL_BASE}/${ARCHIVE_NAME}`;

  const staleDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const staleRoot = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const cache = path.join(staleDir, '.cache', cacheName);
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, Buffer.from('stale-cache-bytes'));
    const calls = [];
    const fetchImpl = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target === OFFICIAL_SUMS) return new Response(packed.sums);
      if (target === officialZip) return bytesResponse(packed.zip);
      return new Response('unexpected', { status: 500 });
    };
    const { value, error, lines } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir: staleDir,
      root: staleRoot,
      fetchImpl,
      env: {},
    }));
    assert.equal(error, null);
    assert.deepEqual(value.exe, packed.exe);
    assert.equal(calls.find((url) => url.endsWith('.zip')), officialZip);
    assert.ok(lines.some((line) => line.includes(`忽略本地 node.exe 缓存 (${cache})`)));
    assert.deepEqual(await readFile(cache), packed.exe);
  } finally {
    await rm(staleDir, { recursive: true, force: true });
    await rm(staleRoot, { recursive: true, force: true });
  }

  const hitDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const hitRoot = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const cache = path.join(hitDir, '.cache', cacheName);
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, packed.exe);
    const calls = [];
    const fetchImpl = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target === OFFICIAL_SUMS) return new Response(packed.sums);
      throw new Error(`should not download ${target}`);
    };
    const { value, error, lines } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir: hitDir,
      root: hitRoot,
      fetchImpl,
      env: { WEFT_NODE_MIRROR: 'https://mirror.example/node' },
    }));
    assert.equal(error, null);
    assert.deepEqual(value.exe, packed.exe);
    assert.equal(value.zipSource, null);
    assert.deepEqual(calls, [OFFICIAL_SUMS]);
    assert.ok(lines.some((line) => line.includes(`使用本地 node.exe 缓存 (${cache})，sha256 已对照官方 SHASUMS256.txt：`)));
    assert.equal(lines.some((line) => line.includes('.zip 下载') || line.includes('尝试从')), false);
  } finally {
    await rm(hitDir, { recursive: true, force: true });
    await rm(hitRoot, { recursive: true, force: true });
  }
});

test('unreadable WEFT_NODE_SHASUMS_FILE falls back to official sums only', async () => {
  const packed = await makeNodeArchive(Buffer.from('fallback-node-exe'));
  const mirrorZip = `${NPM_MIRROR_BASE}/${ARCHIVE_NAME}`;
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('SHASUMS256.txt')) {
      if (target === OFFICIAL_SUMS) return new Response(packed.sums);
      throw new Error(`mirror sums ${target}`);
    }
    if (target === mirrorZip) return bytesResponse(packed.zip);
    throw new Error(`should not fetch ${target}`);
  };
  const outDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const root = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const missing = path.join(outDir, 'missing-SHASUMS256.txt');
    const { value, error, lines } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir,
      root,
      fetchImpl,
      env: {
        WEFT_NODE_SHASUMS_FILE: missing,
        WEFT_NODE_MIRROR: NPM_MIRROR_ROOT,
      },
    }));
    assert.equal(error, null);
    assert.deepEqual(value.exe, packed.exe);
    assert.equal(value.sumsNote, '官方 SHASUMS256.txt');
    assert.deepEqual(calls, [OFFICIAL_SUMS, mirrorZip]);
    assert.ok(lines.some((line) => line.includes(`读取本地 SHASUMS256.txt 失败（${missing}）`)));
    assert.ok(lines.some((line) => line === `SHASUMS256.txt 来自官方 ${OFFICIAL_SUMS}`));
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('WEFT_NODE_SHASUMS_FILE supplies checksums and official sums are not fetched', async () => {
  const packed = await makeNodeArchive(Buffer.from('offline-node-exe'));
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-pack-sums-'));
  const sumsPath = path.join(dir, 'SHASUMS256.txt');
  await writeFile(sumsPath, packed.sums);
  const mirror = 'https://mirror.example/node';
  const mirrorZip = `${mirror}/v${NODE_VERSION}/${ARCHIVE_NAME}`;
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('SHASUMS256.txt')) throw new Error(`sums should stay local, fetched ${target}`);
    if (target === mirrorZip) return bytesResponse(packed.zip);
    throw new Error(`should not fetch ${target}`);
  };
  const outDir = await mkdtemp(path.join(tmpdir(), 'weft-pack-out-'));
  const root = await mkdtemp(path.join(tmpdir(), 'weft-pack-root-'));
  try {
    const { value, error, lines } = await captureConsole(() => acquireNodeExe({
      nodeVersion: NODE_VERSION,
      outDir,
      root,
      fetchImpl,
      env: {
        WEFT_NODE_SHASUMS_FILE: sumsPath,
        WEFT_NODE_MIRROR: mirror,
      },
    }));
    assert.equal(error, null);
    assert.deepEqual(value.exe, packed.exe);
    assert.equal(value.sumsNote, '本地 SHASUMS256.txt');
    assert.deepEqual(calls, [mirrorZip]);
    assert.ok(lines.some((line) => line === `SHASUMS256.txt 来自本地文件 ${sumsPath}`));
    assert.ok(lines.some((line) => line.includes(`${ARCHIVE_NAME} 从 ${mirrorZip} 下载，sha256 已对照本地 SHASUMS256.txt：`)));
    assert.equal(lines.some((line) => line.includes('来自官方') || line.includes('已对照官方')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
