#!/usr/bin/env node
// Build a Windows x64 zip that runs Weft without a system Node install.
// The frontend must already be built (npm run build:web). devDependencies are
// not installed. Node.exe is the official binary. Its sha256 always comes from
// https://nodejs.org/dist/v<ver>/SHASUMS256.txt, or from WEFT_NODE_SHASUMS_FILE
// when that local copy is set. Mirrors only speed up the zip download.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, open, mkdir, readFile, readdir, rm, stat, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bundleServer } from './bundle-server.mjs';
import { crc32, deflateRaw, inflateRawSync } from 'node:zlib';

const deflateRawAsync = promisify(deflateRaw);
/** Level 4 is ~2x faster than 6 for ~5% more size; the zip is a transport format. */
const DEFLATE_LEVEL = 4;
/** Files in flight at once (zlib runs on the libuv thread pool). */
const DEFLATE_PARALLEL = 4;
const STORE_EXT = new Set(['.zip', '.gz', '.br', '.7z', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.mp3', '.mp4']);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Latest Node 22 at or above engines.node, checked against nodejs.org on 2026-10-31. */
export const NODE_VERSION = '22.23.4';

/** Built-in zip fallback. Checksums are never taken from this host. */
const NODE_MIRROR_ROOT = 'https://npmmirror.com/mirrors/node';

export const REQUIRED_APP_PATHS = [
  'server.mjs',
  'bin',
  'src',
  'public-next',
  'package.json',
  'package-lock.json',
  // validate.ts reads this at import time; the server does not start without it.
  'contract/openapi.json',
];

export const OPTIONAL_APP_PATHS = ['plugins', 'skills'];

const BANNED_PACKAGE_NAMES = new Set([
  'vite',
  'rolldown',
  'lightningcss',
  'esbuild',
  'typescript',
  'eslint',
  'vitest',
  'jsdom',
  'playwright',
  '@playwright/test',
]);

const ZIP_LIMIT = 0xffff;

function usageText() {
  return `用法: node scripts/pack-release.mjs --platform win-x64 [--node-version ${NODE_VERSION}] [--shell <壳产物目录>] [--no-bundle] --out <目录>

先构建前端（npm run build:web）。只支持 Windows x64。
默认把服务端用 esbuild 打成少数几个文件（scripts/bundle-server.mjs），包里不放 src/ 和完整 node_modules；
--no-bundle（或环境变量 WEFT_PACK_BUNDLE=0）退回老方式：源码 + npm ci 的 node_modules，便于出问题时对比。
桌面壳产物目录是 dotnet publish desktop/win -c Release -o <目录> 的输出（单文件 Weft.exe，自带 .NET 8），并已把 WebView2 固定版解到其中的 webview2\\；不传则跳过，包里没有 Weft.exe。`;
}

export function assertNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) throw new Error(`Node 版本号无效：${version}（不要带 v 前缀）`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 22 || minor < 19) {
    throw new Error(`Node 版本需要 22.19 或更高的 22.x，收到 ${version}`);
  }
}

export function parsePackArgs(argv) {
  let platform;
  let nodeVersion = NODE_VERSION;
  let out;
  let shell;
  let bundle;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-bundle' || arg === '--bundle') {
      bundle = arg === '--bundle';
      continue;
    }
    if (arg === '--shell') {
      shell = argv[i + 1];
      i += 1;
      if (!shell || shell.startsWith('--')) throw new Error(`缺少 --shell 的值\n${usageText()}`);
      continue;
    }
    if (arg === '--platform') {
      platform = argv[i + 1];
      i += 1;
      if (!platform || platform.startsWith('--')) throw new Error(`缺少 --platform 的值\n${usageText()}`);
      continue;
    }
    if (arg === '--node-version') {
      nodeVersion = argv[i + 1];
      i += 1;
      if (!nodeVersion || nodeVersion.startsWith('--')) throw new Error(`缺少 --node-version 的值\n${usageText()}`);
      continue;
    }
    if (arg === '--out') {
      out = argv[i + 1];
      i += 1;
      if (!out || out.startsWith('--')) throw new Error(`缺少 --out 的值\n${usageText()}`);
      continue;
    }
    throw new Error(`未知参数 ${arg}\n${usageText()}`);
  }
  if (platform !== 'win-x64') {
    const got = platform ? `（收到 ${platform}）` : '';
    throw new Error(`只支持 --platform win-x64${got}\n${usageText()}`);
  }
  if (!out) throw new Error(`缺少 --out\n${usageText()}`);
  assertNodeVersion(nodeVersion);
  const parsed = shell ? { platform, nodeVersion, out, shell } : { platform, nodeVersion, out };
  if (bundle !== undefined) parsed.bundle = bundle;
  return parsed;
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Official SHASUMS256.txt line: `<64 hex>  <filename>` or with a binary `*`. */
export function expectedSha256(sumsText, fileName) {
  const target = String(fileName).replace(/\\/g, '/');
  for (const line of String(sumsText).split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(\S.*?)\s*$/.exec(line.trim());
    if (match && match[2] === target) return match[1].toLowerCase();
  }
  return null;
}

export function windowsCmd(action) {
  if (action !== 'open' && action !== 'stop') throw new Error(`未知启动动作 ${action}`);
  // ASCII only, CRLF. %~dp0 and %APPDATA% stay Unicode inside cmd.exe, so a
  // folder or user name with spaces or Chinese does not need literals here.
  const lines = [
    '@echo off',
    'setlocal EnableExtensions',
    'chcp 65001 >nul',
    'if not defined WEFT_DATA_DIR set "WEFT_DATA_DIR=%APPDATA%\\Weft"',
    `"%~dp0node\\node.exe" "%~dp0app\\bin\\weft.mjs" ${action}`,
    'set "RC=%ERRORLEVEL%"',
    'if not "%RC%"=="0" if not defined CI pause',
    'exit /b %RC%',
    '',
  ];
  return lines.join('\r\n');
}

export function readmeText(version) {
  const lines = [
    'Weft 便携版（Windows 64 位）',
    `版本 ${version}`,
    '',
    '一、启动',
    '双击本目录里的 Weft.exe，会打开独立窗口，不需要浏览器和登录码。',
    'Weft.exe 自带 .NET 8 运行时和 WebView2 固定版（webview2 文件夹），不需要系统另外安装。',
    '请保持 webview2 文件夹在 Weft.exe 旁边。启动时会给它补上 Windows 10 需要的读取权限（ALL APPLICATION PACKAGES）；失败只记在 %LOCALAPPDATA%\\Weft\\shell.log，不影响启动。',
    '若 webview2 文件夹缺失，会改用系统的 WebView2 Runtime；都没有时提示，并改用默认浏览器打开。',
    '自检：在命令行运行 Weft.exe --self-check，不开窗口，打印 .NET 版本、WebView2 来源和版本。',
    '点关闭按钮时按设置里的「关闭窗口时」处理：询问、缩到通知区，或退出 Weft。',
    '缩到通知区后窗口隐藏，服务继续运行，空闲约 30 分钟后仍会自动退出。',
    '双击托盘图标、托盘菜单「打开 Weft」，或再次双击 Weft.exe，都会打开原来的窗口。',
    '托盘菜单「退出 Weft」会先确认；确认后停掉服务再退出。没有设置过时，点关闭会先询问。',
    '备用：双击 Weft.cmd，会在默认浏览器中打开一次性登录链接；启动失败时窗口会停住，方便查看错误信息。',
    '不需要安装 Node.js，也不需要联网安装依赖或现场构建页面。',
    '服务只监听 127.0.0.1，供这台电脑自己使用。',
    '',
    '二、数据在哪',
    '默认数据目录是 %APPDATA%\\Weft',
    '（通常是 C:\\Users\\你的用户名\\AppData\\Roaming\\Weft）。',
    '对话、工作区和设置都在这个目录里。',
    '如果启动前已经设置了环境变量 WEFT_DATA_DIR，就用那个目录，脚本不会改掉它。',
    '',
    '三、停止',
    '双击 Weft-stop.cmd。',
    '服务正在跑任务时会拒绝退出。等任务结束后再停一次。',
    '',
    '四、升级',
    '1. 双击 Weft-stop.cmd，确认服务已经停掉。',
    '2. 用新的压缩包解压，替换整个程序文件夹（Weft.exe、webview2、tools、Weft.cmd、Weft-stop.cmd、README.txt、node、app 一起换）。',
    '数据在 %APPDATA%\\Weft，不在程序文件夹里。替换程序不会改动已有数据。',
    '',
    '五、地址和端口',
    '默认地址是 http://127.0.0.1:3300。',
    '服务只监听 127.0.0.1，只能这台电脑自己访问。',
    '若要改端口，用记事本打开 Weft.cmd，',
    '在调用 node 那一行之前加：',
    'set WEFT_PORT=xxxx',
    '把 xxxx 换成你想用的端口号。',
    '',
    '六、说明',
    '随包的 node\\node.exe 是 Node.js 官方 Windows x64 程序。',
    '随包的 tools\\rg\\rg.exe（ripgrep）和 tools\\pwsh\\pwsh.exe（PowerShell 7）供 Weft 自己和 Agent 命令使用，优先于系统里装的同名程序；许可证在 tools\\licenses。',
    '本包不包含 Git。使用「导入 Git 仓库」需要本机另外安装 Git（Git for Windows 会提供 git.exe）。',
    '',
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new Error('ZIP 缺少结束目录记录');
}

export function listZipEntries(buf) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error('暂不支持 ZIP64');
  }
  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    entries.push({ name, method, crc, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function extractZipEntry(buf, name) {
  const want = String(name).replace(/\\/g, '/');
  const entry = listZipEntries(buf).find((item) => item.name === want);
  if (!entry) throw new Error(`ZIP 里没有 ${want}`);
  return extractZipEntryData(buf, entry);
}

/** Inflate one already-listed entry (no directory re-scan). Verifies size and CRC. */
export function extractZipEntryData(buf, entry) {
  const want = entry.name;
  const local = entry.localOffset;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`ZIP 本地文件头损坏：${want}`);
  }
  const method = buf.readUInt16LE(local + 8);
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compSize;
  if (dataEnd > buf.length) throw new Error(`ZIP 条目越界：${want}`);
  const payload = buf.subarray(dataStart, dataEnd);
  let out;
  if (method === 0) out = Buffer.from(payload);
  else if (method === 8) out = Buffer.from(inflateRawSync(payload));
  else throw new Error(`不支持的 ZIP 压缩方法 ${method}：${want}`);
  if (out.length !== entry.uncompSize) {
    throw new Error(`解压后大小不符：${want}`);
  }
  if ((crc32(out) >>> 0) !== entry.crc) throw new Error(`CRC 不符：${want}`);
  return out;
}

async function collectFiles(dir) {
  const out = [];
  const rootReal = await realpath(dir);
  async function walk(current, rel, seen) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        let followed;
        try {
          followed = await stat(abs);
        } catch {
          continue;
        }
        if (followed.isDirectory()) {
          const real = await realpath(abs);
          if (seen.has(real)) continue;
          seen.add(real);
          await walk(abs, childRel, seen);
        } else if (followed.isFile()) {
          out.push({ abs, rel: childRel });
        }
        continue;
      }
      if (entry.isDirectory()) {
        let real = abs;
        try {
          real = await realpath(abs);
        } catch { /* keep abs */ }
        if (seen.has(real)) continue;
        seen.add(real);
        await walk(abs, childRel, seen);
        continue;
      }
      if (entry.isFile()) out.push({ abs, rel: childRel });
    }
  }
  await walk(dir, '', new Set([rootReal]));
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

async function writeAll(fh, buf, position) {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, position + off);
    if (bytesWritten <= 0) throw new Error('写入 zip 失败');
    off += bytesWritten;
  }
  return position + buf.length;
}

export async function zipDirectory(dir, zipPath) {
  const files = await collectFiles(dir);
  if (files.length > ZIP_LIMIT) {
    throw new Error(`文件数 ${files.length} 超过 ZIP 上限 ${ZIP_LIMIT}`);
  }
  await mkdir(path.dirname(zipPath), { recursive: true });
  const fh = await open(zipPath, 'w');
  const { time, day } = dosDateTime(new Date());
  const centrals = [];
  let offset = 0;
  try {
    let longest = 0;
    const compress = async (file) => {
      const data = await readFile(file.abs);
      const sum = crc32(data) >>> 0;
      let method = 0;
      let payload = data;
      if (data.length > 0 && !STORE_EXT.has(path.extname(file.rel).toLowerCase())) {
        const compressed = await deflateRawAsync(data, { level: DEFLATE_LEVEL });
        if (compressed.length < data.length) {
          method = 8;
          payload = compressed;
        }
      }
      return { data, sum, method, payload };
    };
    // Sliding window: keep DEFLATE_PARALLEL files compressing ahead of the (ordered) writer.
    const pending = new Map();
    const start = (i) => {
      if (i >= files.length || pending.has(i)) return;
      const job = compress(files[i]);
      job.catch(() => {}); // the ordered loop below reports it; avoid an unhandled rejection meanwhile
      pending.set(i, job);
    };
    for (let i = 0; i < DEFLATE_PARALLEL; i += 1) start(i);
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (file.rel.length > longest) longest = file.rel.length;
      const name = Buffer.from(file.rel, 'utf8');
      const { data, sum, method, payload } = await pending.get(i);
      pending.delete(i);
      start(i + DEFLATE_PARALLEL);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(sum, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      const localOffset = offset;
      offset = await writeAll(fh, local, offset);
      offset = await writeAll(fh, name, offset);
      offset = await writeAll(fh, payload, offset);
      centrals.push({
        name,
        method,
        crc: sum,
        compSize: payload.length,
        uncompSize: data.length,
        localOffset,
      });
    }
    const cdOffset = offset;
    for (const entry of centrals) {
      const hdr = Buffer.alloc(46);
      hdr.writeUInt32LE(0x02014b50, 0);
      hdr.writeUInt16LE(20, 4);
      hdr.writeUInt16LE(20, 6);
      hdr.writeUInt16LE(0x0800, 8);
      hdr.writeUInt16LE(entry.method, 10);
      hdr.writeUInt16LE(time, 12);
      hdr.writeUInt16LE(day, 14);
      hdr.writeUInt32LE(entry.crc, 16);
      hdr.writeUInt32LE(entry.compSize, 20);
      hdr.writeUInt32LE(entry.uncompSize, 24);
      hdr.writeUInt16LE(entry.name.length, 28);
      hdr.writeUInt32LE(entry.localOffset, 42);
      offset = await writeAll(fh, hdr, offset);
      offset = await writeAll(fh, entry.name, offset);
    }
    const cdSize = offset - cdOffset;
    if (cdSize > 0xffffffff || cdOffset > 0xffffffff) {
      throw new Error('zip 超过传统 ZIP 的 4GB 上限');
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(centrals.length, 8);
    eocd.writeUInt16LE(centrals.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    offset = await writeAll(fh, eocd, offset);
    console.log(`zip entries ${files.length}, longest relative path ${longest}`);
    return offset;
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(zipPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Append one stored (uncompressed) entry to an existing zip in place: the new local record goes where the
 * central directory started, then the old central directory is rewritten after it. Cheap for a 500MB+ zip.
 */
export async function appendZipEntry(zipPath, entryName, data) {
  const fh = await open(zipPath, 'r+');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    const eocdAt = findEocd(tail);
    const total = tail.readUInt16LE(eocdAt + 10);
    const cdSize = tail.readUInt32LE(eocdAt + 12);
    const cdOffset = tail.readUInt32LE(eocdAt + 16);
    if (total === 0xffff || total + 1 > ZIP_LIMIT) throw new Error('zip 条目数已到上限');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const name = Buffer.from(entryName, 'utf8');
    const sum = crc32(data) >>> 0;
    const { time, day } = dosDateTime(new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const hdr = Buffer.alloc(46);
    hdr.writeUInt32LE(0x02014b50, 0);
    hdr.writeUInt16LE(20, 4);
    hdr.writeUInt16LE(20, 6);
    hdr.writeUInt16LE(0x0800, 8);
    hdr.writeUInt16LE(0, 10);
    hdr.writeUInt16LE(time, 12);
    hdr.writeUInt16LE(day, 14);
    hdr.writeUInt32LE(sum, 16);
    hdr.writeUInt32LE(data.length, 20);
    hdr.writeUInt32LE(data.length, 24);
    hdr.writeUInt16LE(name.length, 28);
    hdr.writeUInt32LE(cdOffset, 42);
    let pos = cdOffset;
    pos = await writeAll(fh, local, pos);
    pos = await writeAll(fh, name, pos);
    pos = await writeAll(fh, data, pos);
    const newCd = pos;
    pos = await writeAll(fh, cd, pos);
    pos = await writeAll(fh, hdr, pos);
    pos = await writeAll(fh, name, pos);
    if (newCd > 0xffffffff) throw new Error('zip 超过传统 ZIP 的 4GB 上限');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(total + 1, 8);
    eocd.writeUInt16LE(total + 1, 10);
    eocd.writeUInt32LE(pos - newCd, 12);
    eocd.writeUInt32LE(newCd, 16);
    pos = await writeAll(fh, eocd, pos);
    await fh.truncate(pos);
  } finally {
    await fh.close();
  }
}

export async function findBannedPackages(nodeModulesDir) {
  const found = [];
  async function scan(dir, scoped) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const abs = path.join(dir, entry.name);
      if (!scoped && entry.name.startsWith('@')) {
        await scan(abs, true);
        continue;
      }
      const pkgPath = path.join(abs, 'package.json');
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
        if (BANNED_PACKAGE_NAMES.has(pkg.name)) found.push(pkg.name);
      } catch { /* not a package root */ }
      await scan(path.join(abs, 'node_modules'), false);
    }
  }
  await scan(nodeModulesDir, false);
  return [...new Set(found)].sort();
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function officialNodeDist(nodeVersion) {
  return `https://nodejs.org/dist/v${nodeVersion}`;
}

function envText(env, key) {
  const value = env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Dist root → `.../v<version>`. A URL whose last path segment is already
 * `v<version>` is returned unchanged, so `/v<ver>` is not appended twice.
 */
export function resolveNodeDistBase(base, nodeVersion) {
  const trimmed = String(base || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Node 下载地址为空');
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (segment === `v${nodeVersion}`) return trimmed;
  return `${trimmed}/v${nodeVersion}`;
}

/** Zip bases: configured mirrors, then nodejs.org, then the built-in npmmirror fallback. */
export function nodeArchiveBases(nodeVersion, env = process.env) {
  const ordered = [];
  const push = (raw) => {
    const text = String(raw || '').trim();
    if (!text) return;
    const base = resolveNodeDistBase(text, nodeVersion);
    if (!ordered.includes(base)) ordered.push(base);
  };
  push(envText(env, 'WEFT_NODE_MIRROR'));
  push(envText(env, 'NODE_DIST_URL'));
  push(officialNodeDist(nodeVersion));
  push(NODE_MIRROR_ROOT);
  return ordered;
}

async function fetchBuffer(url, timeoutMs = 60_000, fetchImpl = fetch) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'weft-pack-release' },
      });
      if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      console.error(`下载失败（第 ${attempt} 次）：${err instanceof Error ? err.message : err}`);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastErr;
}

async function downloadVerified(url, sumsText, fileName, timeoutMs, fetchImpl, sumsNote) {
  const expected = expectedSha256(sumsText, fileName);
  if (!expected) throw new Error(`SHASUMS256.txt 没有 ${fileName}`);
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const buf = await fetchBuffer(url, timeoutMs, fetchImpl);
    const actual = sha256Hex(buf);
    if (actual === expected) {
      console.log(`${fileName} 从 ${url} 下载，sha256 已对照${sumsNote}：${actual}`);
      return buf;
    }
    last = actual;
    console.error(`${fileName} sha256 不符（第 ${attempt} 次）：${actual}`);
  }
  throw new Error(`下载 ${fileName} 的 sha256 与${sumsNote}不一致：${last}，期望 ${expected}`);
}

async function loadNodeSums({ nodeVersion, env, fetchImpl }) {
  const officialUrl = `${officialNodeDist(nodeVersion)}/SHASUMS256.txt`;
  const file = envText(env, 'WEFT_NODE_SHASUMS_FILE');
  if (file) {
    try {
      const sums = await readFile(file, 'utf8');
      console.log(`SHASUMS256.txt 来自本地文件 ${file}`);
      return { sums, sumsNote: '本地 SHASUMS256.txt' };
    } catch (err) {
      console.warn(`读取本地 SHASUMS256.txt 失败（${file}）：${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`获取官方 SHASUMS256.txt：${officialUrl}`);
  try {
    const sums = (await fetchBuffer(officialUrl, 15_000, fetchImpl)).toString('utf8');
    console.log(`SHASUMS256.txt 来自官方 ${officialUrl}`);
    return { sums, sumsNote: '官方 SHASUMS256.txt' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `无法获取官方 SHASUMS256.txt（${officialUrl}）：${reason}。断网时可设置 WEFT_NODE_SHASUMS_FILE 指向本地副本`,
    );
  }
}

export async function acquireNodeExe({
  nodeVersion = NODE_VERSION,
  outDir,
  root = ROOT,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  if (!outDir) throw new Error('缺少输出目录');
  const resolvedOut = path.resolve(outDir);
  const { sums, sumsNote } = await loadNodeSums({ nodeVersion, env, fetchImpl });
  const archiveName = `node-v${nodeVersion}-win-x64.zip`;
  const exeName = `node-v${nodeVersion}-win-x64/node.exe`;
  const standalone = expectedSha256(sums, 'win-x64/node.exe');
  if (!standalone) throw new Error('SHASUMS256.txt 没有 win-x64/node.exe');

  const cacheLocations = [
    envText(env, 'WEFT_NODE_EXE'),
    path.join(resolvedOut, '.cache', `node-${nodeVersion}-win-x64.exe`),
    path.join(root, 'dist', '.cache', `node-${nodeVersion}-win-x64.exe`),
  ].filter(Boolean);

  for (const loc of cacheLocations) {
    if (!await pathExists(loc)) continue;
    try {
      const buf = await readFile(loc);
      const hash = sha256Hex(buf);
      if (hash === standalone) {
        console.log(`使用本地 node.exe 缓存 (${loc})，sha256 已对照${sumsNote}：${hash}`);
        return { exe: buf, exeHash: hash, sumsNote, zipSource: null };
      }
      console.warn(`忽略本地 node.exe 缓存 (${loc})，sha256 与${sumsNote}不符：${hash}`);
    } catch { /* ignore read error, try next */ }
  }

  const bases = nodeArchiveBases(nodeVersion, env);
  let archive = null;
  let zipSource = null;
  for (const base of bases) {
    const url = `${base}/${archiveName}`;
    try {
      console.log(`尝试从 ${base} 下载 ${archiveName}`);
      archive = await downloadVerified(url, sums, archiveName, 180_000, fetchImpl, sumsNote);
      zipSource = base;
      break;
    } catch (err) {
      console.warn(`从 ${base} 下载 ${archiveName} 失败，尝试备选源：${err instanceof Error ? err.message : err}`);
    }
  }
  if (!archive) throw new Error(`无法从任何源下载并校验 ${archiveName}`);

  const exe = extractZipEntry(archive, exeName);
  const exeHash = sha256Hex(exe);
  if (standalone !== exeHash) {
    throw new Error(`解出的 node.exe sha256 ${exeHash} 与${sumsNote}中 win-x64/node.exe ${standalone} 不一致`);
  }
  console.log(`node.exe sha256 已对照${sumsNote}：${exeHash}`);
  try {
    const defaultCache = path.join(resolvedOut, '.cache', `node-${nodeVersion}-win-x64.exe`);
    await mkdir(path.dirname(defaultCache), { recursive: true });
    await writeFile(defaultCache, exe);
  } catch { /* ignore cache write failure */ }
  return { exe, exeHash, sumsNote, zipSource };
}

/**
 * 裁剪规则（全部集中在这一段）。目的：内网安装时安全软件逐个扫描文件，文件数越少越快。
 * 只删运行时用不到的东西；.js/.mjs/.cjs/.json/.node/.wasm、package.json、许可文件一律保留。
 * Node 不会从 node_modules 里加载 .ts（也不会读 .d.ts / .map），所以这些可以安全删除。
 */

/** 只给前端（vite 构建时已打进 public-next）用、服务端不 import 的依赖。相对 node_modules，正斜杠。
 *  marked 不在其中：src/v2/views/path-refs.ts 服务端要用。 */
export const PRUNE_PACKAGES = [
  'codemirror',
  'dompurify',
  '@lobehub/icons-static-svg',
  '@codemirror', // 整个 scope：lang-*、view、state、…
  '@lezer', // codemirror 语法解析器
  '@marijn', // codemirror 的依赖
  'crelt',
  'style-mod',
  'w3c-keyname',
  '@types', // 纯类型包
];

/** 包内这些目录名是测试 / 示例 / 文档，运行时不加载。 */
export const PRUNE_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', 'example', 'examples', 'docs', 'doc', '.github', 'benchmark', 'benchmarks',
]);

const KEEP_RUNTIME_FILE = /\.(?:[cm]?js|json|node|wasm)$/i;
const KEEP_LICENSE_FILE = /^(?:licen[cs]e|notice|copying|unlicense|patents)(?:[-_.].*)?$/i;
const PRUNE_FILE_PATTERNS = [
  /\.d\.[cm]?ts$/i, // 类型声明
  /\.map$/i, // source map
  /\.[cm]?tsx?$/i, // .ts 源码（.d.ts 已在上面）
  /\.(?:md|markdown)$/i, // 文档
  /\.tsbuildinfo$/i,
  /^(?:readme|changelog|changes|history|contributing|authors|code_of_conduct)$/i, // 无扩展名的文档
  /^\.(?:npmignore|eslintrc(?:\..+)?|prettierrc(?:\..+)?|editorconfig|travis\.yml|gitattributes|babelrc)$/i,
];

/** rel：相对 node_modules 的路径，正斜杠。 */
export function shouldPruneFile(rel) {
  const base = rel.split('/').pop();
  if (base === 'package.json') return false;
  if (KEEP_LICENSE_FILE.test(base)) return false;
  if (KEEP_RUNTIME_FILE.test(base)) return false;
  return PRUNE_FILE_PATTERNS.some((re) => re.test(base));
}

/** 目录要不要整个删。只对包内的子目录生效，不会删包根目录本身（比如一个叫 test 的包）。 */
export function shouldPruneDir(rel) {
  const segs = rel.split('/');
  const nm = segs.lastIndexOf('node_modules');
  if (nm < 0 && PRUNE_PACKAGES.includes(rel)) return true; // 顶层按包名整包删
  const pkg = segs.slice(nm + 1);
  if (pkg.length === 0) return false;
  const rootLen = pkg[0].startsWith('@') ? 2 : 1;
  if (pkg.length <= rootLen) return false; // 包根目录或 scope 目录，不按目录名删
  return PRUNE_DIR_NAMES.has(pkg[pkg.length - 1]);
}

/** WebView2 固定版只留这些语言包；缺了的语言 Chromium 回落到 en-US。相对包根，小写。 */
export const WEBVIEW2_KEEP_LOCALES = new Set(['en-us', 'zh-cn']);

export function shouldPruneShellPath(relPosixLower) {
  const m = /^webview2\/(?:[^/]+\/)?locales\/([^/]+)\.pak$/.exec(relPosixLower);
  return Boolean(m) && !WEBVIEW2_KEEP_LOCALES.has(m[1]);
}

export async function treeStats(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(abs)).size;
      }
    }
  }
  await walk(dir);
  return { files, bytes };
}

/** 裁剪 node_modules，返回裁剪前后的文件数和字节数。 */
export async function pruneNodeModules(nodeModulesDir) {
  const before = await treeStats(nodeModulesDir);
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.bin' && !rel) continue;
        if (shouldPruneDir(childRel)) await rm(abs, { recursive: true, force: true });
        else await walk(abs, childRel);
      } else if (entry.isFile() && shouldPruneFile(childRel)) {
        await rm(abs, { force: true });
      }
    }
  }
  await walk(nodeModulesDir, '');
  const after = await treeStats(nodeModulesDir);
  return { before, after };
}

/** 裁剪后，检查每个包 package.json 声明的入口文件还在（不含通配和类型）。返回缺失列表。 */
export async function findMissingEntryPoints(nodeModulesDir) {
  const missing = [];
  const RUNTIME = /\.(?:[cm]?js|json|node|wasm)$/i;
  function targets(pkg) {
    const out = [];
    const walkExports = (value, key) => {
      if (typeof value === 'string') {
        if (key !== 'types' && value.startsWith('./') && !value.includes('*') && RUNTIME.test(value)) out.push(value);
      } else if (Array.isArray(value)) value.forEach((v) => walkExports(v, key));
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walkExports(v, k);
      }
    };
    walkExports(pkg.exports, '');
    for (const field of ['main', 'module']) {
      if (typeof pkg[field] === 'string' && RUNTIME.test(pkg[field])) out.push(pkg[field]);
    }
    if (typeof pkg.bin === 'string') out.push(pkg.bin);
    else if (pkg.bin && typeof pkg.bin === 'object') out.push(...Object.values(pkg.bin).filter((v) => typeof v === 'string'));
    return out;
  }
  async function scan(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      const abs = path.join(dir, entry.name);
      if (entry.name.startsWith('@')) {
        await scan(abs);
        continue;
      }
      let pkg;
      try {
        pkg = JSON.parse(await readFile(path.join(abs, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      for (const target of new Set(targets(pkg))) {
        if (!await pathExists(path.join(abs, target))) missing.push(`${pkg.name}: ${target}`);
      }
      await scan(path.join(abs, 'node_modules'));
    }
  }
  await scan(nodeModulesDir);
  return missing.sort();
}

function formatMB(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function npmEnv() {
  return {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

function runNpmCi(appDir) {
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'];
  const npmExec = process.env.npm_execpath;
  const result = npmExec
    ? spawnSync(process.execPath, [npmExec, ...args], {
      cwd: appDir,
      stdio: 'inherit',
      env: npmEnv(),
    })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: appDir,
      stdio: 'inherit',
      env: npmEnv(),
      shell: process.platform === 'win32',
    });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci --omit=dev --ignore-scripts 失败（退出码 ${result.status}）`);
}

async function listTopPackages(nodeModulesDir) {
  const labels = [];
  const entries = await readdir(nodeModulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      const scoped = await readdir(abs, { withFileTypes: true });
      for (const child of scoped) {
        if (!child.isDirectory()) continue;
        labels.push(await packageLabel(path.join(abs, child.name)));
      }
      continue;
    }
    labels.push(await packageLabel(abs));
  }
  labels.sort();
  return labels;
}

async function packageLabel(dir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    return `${pkg.name}@${pkg.version}`;
  } catch {
    return path.basename(dir);
  }
}

async function copyApp(root, appDir) {
  await mkdir(appDir, { recursive: true });
  for (const rel of REQUIRED_APP_PATHS) {
    const from = path.join(root, rel);
    if (!await pathExists(from)) {
      throw new Error(`缺少运行文件 ${rel}${rel === 'public-next' ? '。请先运行 npm run build:web' : ''}`);
    }
    await mkdir(path.dirname(path.join(appDir, rel)), { recursive: true });
    await cp(from, path.join(appDir, rel), {
      recursive: true,
      filter(source) {
        const base = path.basename(source);
        return base !== 'node_modules' && base !== '.git';
      },
    });
  }
  for (const rel of OPTIONAL_APP_PATHS) {
    const from = path.join(root, rel);
    if (!await pathExists(from)) continue;
    await cp(from, path.join(appDir, rel), {
      recursive: true,
      filter(source) {
        const base = path.basename(source);
        return base !== 'node_modules' && base !== '.git';
      },
    });
  }
  await assertFrontendBuilt(appDir);
}

async function assertFrontendBuilt(appDir) {
  const indexPath = path.join(appDir, 'public-next', 'index.html');
  if (!await pathExists(indexPath)) {
    throw new Error('public-next/index.html 不存在。请先运行 npm run build:web');
  }
  const html = await readFile(indexPath, 'utf8');
  if (!html.includes('id="root"') || html.includes('/src/main.tsx')) {
    throw new Error('public-next/index.html 不是构建产物。请先运行 npm run build:web');
  }
}

/** 打包模式下 app/package.json 只留运行时读的字段（server.mjs 读 name / version / description；type 决定 .js 的模块类型）。 */
export function bundledPackageJson(pkg) {
  const out = {};
  for (const key of ['name', 'version', 'private', 'description', 'type', 'engines']) {
    if (pkg[key] !== undefined) out[key] = pkg[key];
  }
  return out;
}

/** 从 names 出发，沿 dependencies / optionalDependencies 在 node_modules 里找出要保留的顶层包目录名（含 @scope/name）。 */
export async function dependencyClosure(nodeModulesDir, names) {
  const keep = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.pop();
    if (keep.has(name)) continue;
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path.join(nodeModulesDir, name, 'package.json'), 'utf8'));
    } catch {
      continue; // 可选依赖没装，或者在嵌套 node_modules 里
    }
    keep.add(name);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) queue.push(dep);
  }
  return keep;
}

/** 只留 keep 里的顶层包（含 scope 下的包），其余整个删掉。返回删除前后的文件数。 */
export async function keepOnlyPackages(nodeModulesDir, keep) {
  const before = await treeStats(nodeModulesDir);
  for (const entry of await readdir(nodeModulesDir, { withFileTypes: true })) {
    const abs = path.join(nodeModulesDir, entry.name);
    if (entry.name === '.bin' || entry.name.startsWith('.')) {
      await rm(abs, { recursive: true, force: true });
    } else if (entry.name.startsWith('@')) {
      for (const child of await readdir(abs, { withFileTypes: true })) {
        if (!keep.has(`${entry.name}/${child.name}`)) await rm(path.join(abs, child.name), { recursive: true, force: true });
      }
      if ((await readdir(abs)).length === 0) await rm(abs, { recursive: true, force: true });
    } else if (!keep.has(entry.name)) {
      await rm(abs, { recursive: true, force: true });
    }
  }
  return { before, after: await treeStats(nodeModulesDir) };
}

/** 包内文件按大类统计（相对包根的顶层目录；app/ 再往下分一层），给 PR 和日志看分布。 */
export async function categoryStats(stage) {
  const buckets = new Map();
  async function walk(dir, rel) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, childRel);
      } else if (entry.isFile()) {
        const segs = childRel.split('/');
        const key = segs.length === 1 ? '(根目录文件)' : segs[0] === 'app' && segs.length > 2 ? `app/${segs[1]}` : segs[0];
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
    }
  }
  await walk(stage, '');
  return [...buckets.entries()].sort((a, b) => b[1] - a[1]);
}

/** 打包模式：app/ 里放 esbuild 的 bundle、前端、技能和必要数据文件；只有打不进 bundle 的包才装 node_modules。 */
async function prepareBundledApp(root, appDir, pkg) {
  const { files, externals } = await bundleServer({ root, outDir: appDir });
  console.log(`esbuild bundle：${files.length} 个文件`);
  await cp(path.join(root, 'public-next'), path.join(appDir, 'public-next'), { recursive: true });
  await assertFrontendBuilt(appDir);
  for (const rel of OPTIONAL_APP_PATHS) {
    const from = path.join(root, rel);
    // plugins 已经由 bundle 产出；skills 原样带上
    if (rel === 'plugins' || !await pathExists(from)) continue;
    await cp(from, path.join(appDir, rel), { recursive: true });
  }
  await writeFile(path.join(appDir, 'package.json'), `${JSON.stringify(bundledPackageJson(pkg), null, 2)}\n`);
  let prune = null;
  if (externals.length) {
    const deps = { ...pkg.dependencies };
    const wanted = Object.fromEntries(externals.map((name) => [name, deps[name]]).filter(([, v]) => v));
    await writeFile(path.join(appDir, 'package.json'), `${JSON.stringify({ ...bundledPackageJson(pkg), dependencies: wanted }, null, 2)}\n`);
    await cp(path.join(root, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
    console.log('npm ci --omit=dev --ignore-scripts（只为 external 包）');
    runNpmCi(appDir);
    const nodeModulesDir = path.join(appDir, 'node_modules');
    prune = await keepOnlyPackages(nodeModulesDir, await dependencyClosure(nodeModulesDir, externals));
    await rm(path.join(appDir, 'package-lock.json'), { force: true });
  }
  return { externals, prune };
}

async function stripPostinstall(appDir) {
  const pkgPath = path.join(appDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (pkg.scripts && Object.hasOwn(pkg.scripts, 'postinstall')) {
    delete pkg.scripts.postinstall;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return pkg;
}

/** WebView2 固定版自带、Weft 用不到的独立程序（相对包根，小写、正斜杠）。 */
export const WEBVIEW2_STRIP = ['webview2/copilotapp.exe', 'webview2/mscopilot.exe', 'webview2/installer/copilot_setup.exe'];

/** Copy the dotnet build output of desktop/win into the zip root (Weft.exe must sit there). */
export async function copyShell(shellDir, stage) {
  const src = path.resolve(shellDir);
  if (!(await stat(path.join(src, 'Weft.exe')).catch(() => null))) {
    throw new Error(`壳产物目录里没有 Weft.exe：${src}（先 dotnet publish desktop/win -c Release，再把 WebView2 固定版解到 webview2\\）`);
  }
  if (!(await stat(path.join(src, 'webview2', 'msedgewebview2.exe')).catch(() => null))) {
    throw new Error(`壳产物目录里没有 webview2\\msedgewebview2.exe（WebView2 固定版运行库）：${src}`);
  }
  const toolsDir = path.join(src, 'tools') + path.sep;
  let prunedLocales = 0;
  await cp(src, stage, {
    recursive: true,
    // Drop .pdb/.xml from the shell build only; tools\ (ripgrep, PowerShell 7) is copied as is.
    filter: (from) => {
      const rel = path.relative(src, from).split(path.sep).join('/').toLowerCase();
      if (WEBVIEW2_STRIP.includes(rel)) return false;
      if (shouldPruneShellPath(rel)) {
        prunedLocales += 1;
        return false;
      }
      return from.startsWith(toolsDir) || !/\.(pdb|xml)$/i.test(from);
    },
  });
  // Installer\ 只剩 copilot_setup.exe 时删后为空，一并去掉
  const inst = path.join(stage, 'webview2', 'Installer');
  if ((await readdir(inst).catch(() => null))?.length === 0) await rm(inst, { recursive: true });
  return { prunedLocales };
}

export async function packRelease({
  nodeVersion = NODE_VERSION,
  out,
  root = ROOT,
  shell,
  bundle = process.env.WEFT_PACK_BUNDLE !== '0',
} = {}) {
  assertNodeVersion(nodeVersion);
  if (!out) throw new Error('缺少输出目录');
  const outDir = path.resolve(out);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version || '').trim();
  if (!version || /[\\/]/.test(version)) throw new Error(`package.json version 无效：${version}`);

  const stage = await mkdtemp(path.join(tmpdir(), 'weft-pack-'));
  const appDir = path.join(stage, 'app');
  try {
    console.log(`准备 app/（Node ${nodeVersion}，${bundle ? 'esbuild 打包' : '不打包：源码 + 完整 node_modules'}）`);
    let prune = null;
    let packages = [];
    if (bundle) {
      const prepared = await prepareBundledApp(root, appDir, pkg);
      prune = prepared.prune;
      if (prepared.externals.length) packages = await listTopPackages(path.join(appDir, 'node_modules'));
    } else {
      await copyApp(root, appDir);
      console.log('npm ci --omit=dev --ignore-scripts');
      runNpmCi(appDir);
      // esbuild 是 chord 的可选 peer，又是我们打包用的 devDependency，npm 会把它装进 --omit=dev 的树里；运行时用不到。
      await rm(path.join(appDir, 'node_modules', 'esbuild'), { recursive: true, force: true });
      await rm(path.join(appDir, 'node_modules', '@esbuild'), { recursive: true, force: true });
      const banned = await findBannedPackages(path.join(appDir, 'node_modules'));
      if (banned.length) {
        throw new Error(`运行时依赖里出现了开发包：${banned.join(', ')}`);
      }
      const nodeModulesDir = path.join(appDir, 'node_modules');
      const missingBefore = new Set(await findMissingEntryPoints(nodeModulesDir)); // 上游自己就缺的不算
      prune = await pruneNodeModules(nodeModulesDir);
      const missingEntries = (await findMissingEntryPoints(nodeModulesDir)).filter((item) => !missingBefore.has(item));
      if (missingEntries.length) {
        throw new Error(`裁剪后缺少包入口文件：\n  ${missingEntries.join('\n  ')}`);
      }
      await stripPostinstall(appDir);
      packages = await listTopPackages(path.join(appDir, 'node_modules'));
    }
    for (const rel of ['server.mjs', 'bin/weft.mjs']) {
      if (!await pathExists(path.join(appDir, rel))) throw new Error(`app/ 缺少入口 ${rel}`);
    }

    const { exe, exeHash } = await acquireNodeExe({ nodeVersion, outDir, root });
    await mkdir(path.join(stage, 'node'), { recursive: true });
    await writeFile(path.join(stage, 'node', 'node.exe'), exe);

    let shellPruned = 0;
    if (shell) {
      shellPruned = (await copyShell(shell, stage)).prunedLocales;
      console.log(`桌面壳：${path.resolve(shell)}`);
    } else {
      console.log('跳过桌面壳：没有传 --shell，包里不含 Weft.exe（用 Weft.cmd 启动）');
    }
    await writeFile(path.join(stage, 'Weft.cmd'), windowsCmd('open'));
    await writeFile(path.join(stage, 'Weft-stop.cmd'), windowsCmd('stop'));
    await writeFile(path.join(stage, 'README.txt'), readmeText(version));

    const zipName = `weft-${version}-win-x64.zip`;
    const zipPath = path.join(outDir, zipName);
    await mkdir(outDir, { recursive: true });
    console.log(`打包 ${zipPath}`);
    await zipDirectory(stage, zipPath);
    const zipBuf = await readFile(zipPath);
    const zipHash = sha256Hex(zipBuf);
    console.log('--- pack summary ---');
    console.log(`node: ${nodeVersion}`);
    console.log(`node.exe sha256: ${exeHash}`);
    console.log(`zip: ${zipPath}`);
    console.log(`zip bytes: ${zipBuf.length}`);
    const total = await treeStats(stage);
    console.log(`服务端：${bundle ? 'esbuild bundle' : '源码 + 完整 node_modules（--no-bundle）'}`);
    if (prune) {
      console.log(`app/node_modules 裁剪前：${prune.before.files} 个文件，${formatMB(prune.before.bytes)}`);
      console.log(`app/node_modules 裁剪后：${prune.after.files} 个文件，${formatMB(prune.after.bytes)}`);
    } else {
      console.log('app/node_modules：无（全部打进 bundle）');
    }
    console.log('文件分布（个数）：');
    for (const [name, count] of await categoryStats(stage)) console.log(`  ${name}: ${count}`);
    console.log(`WebView2 语言包裁掉：${shellPruned} 个`);
    console.log(`包内文件总数（zip 条目）：${total.files}，解压后 ${formatMB(total.bytes)}`);
    console.log(`zip sha256: ${zipHash}`);
    console.log(`app/node_modules packages (${packages.length}):`);
    for (const label of packages) console.log(`  ${label}`);
    console.log('--- end ---');
    return { zipPath, zipHash, zipBytes: zipBuf.length, packages, nodeVersion, exeHash };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  try {
    const args = parsePackArgs(process.argv.slice(2));
    await packRelease(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
