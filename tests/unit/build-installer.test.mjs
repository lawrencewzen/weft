import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listZipEntries, extractZipEntry } from '../../scripts/pack-release.mjs';
import {
  MANIFEST_NAME,
  TRAILER_SIZE,
  appendPayload,
  buildInstaller,
  buildManifest,
  buildTrailer,
  parseBuildArgs,
  parseTrailer,
  versionFromZipName,
} from '../../scripts/build-installer.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function fakePackage(dir) {
  await mkdir(path.join(dir, 'node'), { recursive: true });
  await mkdir(path.join(dir, 'app', 'bin'), { recursive: true });
  await writeFile(path.join(dir, 'Weft.exe'), 'MZ-shell');
  await writeFile(path.join(dir, 'node', 'node.exe'), Buffer.alloc(4096, 7));
  await writeFile(path.join(dir, 'app', 'bin', 'weft.mjs'), 'console.log(1)');
  await writeFile(path.join(dir, 'README.txt'), '说明');
}

test('parseBuildArgs 要三个必填参数', () => {
  const a = parseBuildArgs(['--package', 'p.zip', '--installer', 'i.exe', '--out', 'dist', '--version', '1.2.3']);
  assert.deepEqual(a, { pkg: 'p.zip', installer: 'i.exe', out: 'dist', version: '1.2.3' });
  assert.throws(() => parseBuildArgs(['--package', 'p.zip']), /缺少参数/);
  assert.throws(() => parseBuildArgs(['--bogus', 'x']), /未知参数/);
  assert.throws(() => parseBuildArgs(['--package']), /缺少 --package 的值/);
});

test('versionFromZipName', () => {
  assert.equal(versionFromZipName('dist/weft-0.1.3-win-x64.zip'), '0.1.3');
  assert.equal(versionFromZipName('weft-1.0.0-rc.1-win-x64.zip'), '1.0.0-rc.1');
  assert.equal(versionFromZipName('other.zip'), null);
});

test('trailer 往返，长度对不上就当没有载荷', () => {
  const hash = sha('x');
  const t = buildTrailer(1000, 500, hash);
  assert.equal(t.length, TRAILER_SIZE);
  assert.deepEqual(parseTrailer(t, 1000 + 500 + TRAILER_SIZE), { offset: 1000, length: 500, sha256: hash });
  assert.equal(parseTrailer(t, 999), null);
  t[63] ^= 1;
  assert.equal(parseTrailer(t, 1000 + 500 + TRAILER_SIZE), null);
});

test('buildManifest 列出除清单外的所有文件，带大小和 sha256，路径用正斜杠', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-bi-'));
  try {
    await fakePackage(dir);
    await writeFile(path.join(dir, MANIFEST_NAME), '{}');
    const m = await buildManifest(dir, '0.1.3');
    assert.equal(m.version, '0.1.3');
    assert.deepEqual(m.files.map((f) => f.path), ['Weft.exe', 'README.txt', 'app/bin/weft.mjs', 'node/node.exe'].sort());
    const exe = m.files.find((f) => f.path === 'Weft.exe');
    assert.equal(exe.size, 8);
    assert.equal(exe.sha256, sha('MZ-shell'));
    await assert.rejects(() => buildManifest(dir, 'abc'), /版本号无效/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildInstaller 生成 安装器 + 载荷 zip + trailer，载荷里带清单', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'weft-bi-'));
  try {
    const pkg = path.join(work, 'pkg');
    await fakePackage(pkg);
    const installer = path.join(work, 'WeftSetup.exe');
    const head = Buffer.alloc(10000, 1);
    await writeFile(installer, head);
    const res = await buildInstaller({ pkg, installer, out: path.join(work, 'dist'), version: '0.1.3' });
    assert.equal(path.basename(res.outPath), 'Weft-Setup-0.1.3.exe');

    const buf = await readFile(res.outPath);
    const info = parseTrailer(buf.subarray(buf.length - TRAILER_SIZE), buf.length);
    assert.ok(info, 'trailer 可解析');
    assert.equal(info.offset, head.length);
    assert.deepEqual(buf.subarray(0, head.length), head);
    const payload = buf.subarray(info.offset, info.offset + info.length);
    assert.equal(sha(payload), info.sha256);

    const names = listZipEntries(payload).map((e) => e.name).sort();
    assert.deepEqual(names, [MANIFEST_NAME, 'README.txt', 'Weft.exe', 'app/bin/weft.mjs', 'node/node.exe'].sort());
    const manifest = JSON.parse(extractZipEntry(payload, MANIFEST_NAME).toString('utf8'));
    assert.equal(manifest.version, '0.1.3');
    assert.equal(manifest.files.length, 4);
    for (const f of manifest.files) {
      assert.equal(sha(extractZipEntry(payload, f.path)), f.sha256, f.path);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('buildInstaller 拒绝不完整的包', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'weft-bi-'));
  try {
    const pkg = path.join(work, 'pkg');
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, 'README.txt'), 'x');
    const installer = path.join(work, 'i.exe');
    await writeFile(installer, 'x');
    await assert.rejects(() => buildInstaller({ pkg, installer, out: work, version: '1.0.0' }), /缺少 Weft\.exe/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('appendPayload 流式追加', async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'weft-bi-'));
  try {
    await writeFile(path.join(work, 'h'), 'HEAD');
    await writeFile(path.join(work, 'p'), 'PAYLOAD');
    const info = await appendPayload(path.join(work, 'h'), path.join(work, 'p'), path.join(work, 'o'));
    assert.equal(info.total, 4 + 7 + TRAILER_SIZE);
    assert.equal((await stat(path.join(work, 'o'))).size, info.total);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
