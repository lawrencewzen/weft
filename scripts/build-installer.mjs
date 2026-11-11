#!/usr/bin/env node
// 把解压即用的 Windows 包做成单文件安装程序 Weft-Setup-<版本>.exe。
//
// 安装程序 = 安装器 exe（desktop/installer，dotnet publish 出来的自带运行时单文件）
//          + 载荷 zip（整个包 + install-manifest.json）
//          + 64 字节尾部标记：offset(u64 LE) length(u64 LE) sha256(32) "WEFTSETUPPAYLOAD"
// 安装器运行时读尾部标记，流式校验 SHA256，再按清单安装。格式见 desktop/installer/Core/Payload.cs。
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extractZipEntry, listZipEntries, zipDirectory } from './pack-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST_NAME = 'install-manifest.json';
export const TRAILER_MAGIC = 'WEFTSETUPPAYLOAD';
export const TRAILER_SIZE = 64;

function usageText() {
  return `用法: node scripts/build-installer.mjs --package <weft-*-win-x64.zip 或解压后的目录> --installer <WeftSetup.exe> --out <目录> [--version <x.y.z>]

--installer 是 dotnet publish desktop/installer 得到的 WeftSetup.exe。输出 <out>/Weft-Setup-<版本>.exe。`;
}

export function parseBuildArgs(argv) {
  const res = {};
  const keys = { '--package': 'pkg', '--installer': 'installer', '--out': 'out', '--version': 'version' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = keys[argv[i]];
    if (!key) throw new Error(`未知参数 ${argv[i]}\n${usageText()}`);
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) throw new Error(`缺少 ${argv[i]} 的值\n${usageText()}`);
    res[key] = val;
    i += 1;
  }
  for (const need of ['pkg', 'installer', 'out']) {
    if (!res[need]) throw new Error(`缺少参数\n${usageText()}`);
  }
  return res;
}

export function versionFromZipName(name) {
  const m = /^weft-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-win-x64\.zip$/.exec(path.basename(name));
  return m ? m[1] : null;
}

export function assertVersion(v) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(v || ''))) throw new Error(`版本号无效：${v}`);
}

export async function sha256File(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function walk(dir, rel, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(abs, r, out);
    else if (e.isFile()) out.push({ abs, rel: r });
  }
}

/** 目录 → 清单。清单自己不在 files 里；路径用正斜杠。 */
export async function buildManifest(dir, version) {
  assertVersion(version);
  const list = [];
  await walk(dir, '', list);
  const files = [];
  for (const f of list) {
    if (f.rel === MANIFEST_NAME) continue;
    const st = await stat(f.abs);
    files.push({ path: f.rel, size: st.size, sha256: await sha256File(f.abs) });
  }
  return { schema: 1, name: 'Weft', version, files };
}

export function buildTrailer(offset, length, sha256Hex) {
  const sha = Buffer.from(sha256Hex, 'hex');
  if (sha.length !== 32) throw new Error('sha256 必须 32 字节');
  const t = Buffer.alloc(TRAILER_SIZE);
  t.writeBigUInt64LE(BigInt(offset), 0);
  t.writeBigUInt64LE(BigInt(length), 8);
  sha.copy(t, 16);
  t.write(TRAILER_MAGIC, 48, 'ascii');
  return t;
}

export function parseTrailer(buf, fileLength) {
  if (buf.length !== TRAILER_SIZE) return null;
  if (buf.toString('ascii', 48, 64) !== TRAILER_MAGIC) return null;
  const offset = Number(buf.readBigUInt64LE(0));
  const length = Number(buf.readBigUInt64LE(8));
  if (offset <= 0 || length <= 0 || offset + length + TRAILER_SIZE !== fileLength) return null;
  return { offset, length, sha256: buf.subarray(16, 48).toString('hex') };
}

/** installer + payload + trailer → out。流式写，载荷 250MB 以上也不进内存。 */
export async function appendPayload(installerPath, payloadPath, outPath) {
  const head = await stat(installerPath);
  const payload = await stat(payloadPath);
  const sha = await sha256File(payloadPath);
  await mkdir(path.dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath);
  const done = new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  for (const file of [installerPath, payloadPath]) {
    await new Promise((resolve, reject) => {
      const rs = createReadStream(file);
      rs.on('error', reject);
      rs.on('end', resolve);
      rs.pipe(out, { end: false });
    });
  }
  out.end(buildTrailer(head.size, payload.size, sha));
  await done;
  return { offset: head.size, length: payload.size, sha256: sha, total: head.size + payload.size + TRAILER_SIZE };
}

async function stagePackage(pkg, stage) {
  const st = await stat(pkg);
  if (st.isDirectory()) {
    await cp(pkg, stage, { recursive: true });
    return;
  }
  const buf = await readFile(pkg);
  for (const entry of listZipEntries(buf)) {
    if (entry.name.endsWith('/')) continue;
    if (entry.name.split('/').some((p) => p === '..' || p === '') || /^[A-Za-z]:/.test(entry.name)) {
      throw new Error(`包里有不安全的路径：${entry.name}`);
    }
    const dest = path.join(stage, ...entry.name.split('/'));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, extractZipEntry(buf, entry.name));
  }
}

export async function buildInstaller({ pkg, installer, out, version }) {
  const pkgAbs = path.resolve(pkg);
  const ver = version || versionFromZipName(pkgAbs) || JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  assertVersion(ver);
  await stat(installer).catch(() => {
    throw new Error(`找不到安装器 ${installer}`);
  });
  const work = await mkdtemp(path.join(tmpdir(), 'weft-setup-'));
  try {
    const stage = path.join(work, 'stage');
    await mkdir(stage, { recursive: true });
    console.log(`准备载荷（${pkgAbs}）`);
    await stagePackage(pkgAbs, stage);
    for (const need of ['Weft.exe', path.join('node', 'node.exe'), path.join('app', 'bin', 'weft.mjs')]) {
      await stat(path.join(stage, need)).catch(() => {
        throw new Error(`包里缺少 ${need}，安装程序要装的是完整的 Windows 包`);
      });
    }
    const manifest = await buildManifest(stage, ver);
    await writeFile(path.join(stage, MANIFEST_NAME), JSON.stringify(manifest));
    const payloadZip = path.join(work, 'payload.zip');
    await zipDirectory(stage, payloadZip);

    const outPath = path.join(path.resolve(out), `Weft-Setup-${ver}.exe`);
    const info = await appendPayload(installer, payloadZip, outPath);
    const total = manifest.files.reduce((n, f) => n + f.size, 0);
    console.log('--- installer summary ---');
    console.log(`version: ${ver}`);
    console.log(`files: ${manifest.files.length}, unpacked bytes: ${total}`);
    console.log(`installer exe bytes: ${info.offset}`);
    console.log(`payload bytes: ${info.length}`);
    console.log(`payload sha256: ${info.sha256}`);
    console.log(`setup: ${outPath}`);
    console.log(`setup bytes: ${info.total}`);
    console.log('--- end ---');
    return { outPath, version: ver, manifest, ...info };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function isMain() {
  const entry = process.argv[1];
  return !!entry && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    await buildInstaller(parseBuildArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
