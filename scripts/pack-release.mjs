#!/usr/bin/env node
// Build a Windows x64 zip that runs Weft without a system Node install.
// The frontend must already be built (npm run build:web). devDependencies are
// not installed. Node.exe is the official binary, checked against SHASUMS256.txt.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, open, mkdir, readFile, readdir, rm, stat, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Latest Node 22 at or above engines.node, checked against nodejs.org on 2026-10-31. */
export const NODE_VERSION = '22.23.4';

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
  return `用法: node scripts/pack-release.mjs --platform win-x64 [--node-version ${NODE_VERSION}] --out <目录>

先构建前端（npm run build:web）。只支持 Windows x64。`;
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
  return { platform, nodeVersion, out };
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
    '双击本目录里的 Weft.cmd。',
    '不需要安装 Node.js，也不需要联网安装依赖或现场构建页面。',
    '脚本会在本机拉起服务，并在浏览器中打开一次性登录链接。',
    '服务只监听 127.0.0.1，供这台电脑自己使用。',
    '如果启动失败，窗口会停住，方便查看错误信息。',
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
    '2. 用新的压缩包解压，替换整个程序文件夹（Weft.cmd、Weft-stop.cmd、README.txt、node、app 一起换）。',
    '数据在 %APPDATA%\\Weft，不在程序文件夹里。替换程序不会改动已有数据。',
    '',
    '五、说明',
    '随包的 node\\node.exe 是 Node.js 官方 Windows x64 程序。',
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
    for (const file of files) {
      if (file.rel.length > longest) longest = file.rel.length;
      const data = await readFile(file.abs);
      const name = Buffer.from(file.rel, 'utf8');
      const sum = crc32(data) >>> 0;
      let method = 0;
      let payload = data;
      if (data.length > 0) {
        const compressed = deflateRawSync(data, { level: 6 });
        if (compressed.length < data.length) {
          method = 8;
          payload = compressed;
        }
      }
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

async function fetchBuffer(url) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(180_000),
        headers: { 'user-agent': 'weft-pack-release' },
      });
      if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      console.error(`下载失败（第 ${attempt} 次）：${err instanceof Error ? err.message : err}`);
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastErr;
}

async function downloadVerified(url, sumsText, fileName) {
  const expected = expectedSha256(sumsText, fileName);
  if (!expected) throw new Error(`SHASUMS256.txt 没有 ${fileName}`);
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const buf = await fetchBuffer(url);
    const actual = sha256Hex(buf);
    if (actual === expected) {
      console.log(`${fileName} sha256 已对照官方 SHASUMS256.txt：${actual}`);
      return buf;
    }
    last = actual;
    console.error(`${fileName} sha256 不符（第 ${attempt} 次）：${actual}`);
  }
  throw new Error(`下载 ${fileName} 的 sha256 与官方记录不一致：${last}，期望 ${expected}`);
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
  const args = ['ci', '--omit=dev', '--ignore-scripts'];
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
  const indexPath = path.join(appDir, 'public-next', 'index.html');
  if (!await pathExists(indexPath)) {
    throw new Error('public-next/index.html 不存在。请先运行 npm run build:web');
  }
  const html = await readFile(indexPath, 'utf8');
  if (!html.includes('id="root"') || html.includes('/src/main.tsx')) {
    throw new Error('public-next/index.html 不是构建产物。请先运行 npm run build:web');
  }
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

export async function packRelease({
  nodeVersion = NODE_VERSION,
  out,
  root = ROOT,
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
    console.log(`准备 app/（Node ${nodeVersion}）`);
    await copyApp(root, appDir);
    console.log('npm ci --omit=dev --ignore-scripts');
    runNpmCi(appDir);
    const banned = await findBannedPackages(path.join(appDir, 'node_modules'));
    if (banned.length) {
      throw new Error(`运行时依赖里出现了开发包：${banned.join(', ')}`);
    }
    await stripPostinstall(appDir);
    const packages = await listTopPackages(path.join(appDir, 'node_modules'));

    const base = `https://nodejs.org/dist/v${nodeVersion}`;
    const archiveName = `node-v${nodeVersion}-win-x64.zip`;
    const exeName = `node-v${nodeVersion}-win-x64/node.exe`;
    console.log(`下载 ${base}/SHASUMS256.txt`);
    const sums = (await fetchBuffer(`${base}/SHASUMS256.txt`)).toString('utf8');
    console.log(`下载 ${archiveName}`);
    let archive = await downloadVerified(`${base}/${archiveName}`, sums, archiveName);
    const exe = extractZipEntry(archive, exeName);
    archive = null;
    const standalone = expectedSha256(sums, 'win-x64/node.exe');
    const exeHash = sha256Hex(exe);
    if (!standalone) throw new Error('SHASUMS256.txt 没有 win-x64/node.exe');
    if (standalone !== exeHash) {
      throw new Error(`解出的 node.exe sha256 ${exeHash} 与官方 win-x64/node.exe ${standalone} 不一致`);
    }
    console.log(`node.exe sha256 已对照官方 SHASUMS256.txt：${exeHash}`);
    await mkdir(path.join(stage, 'node'), { recursive: true });
    await writeFile(path.join(stage, 'node', 'node.exe'), exe);

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
