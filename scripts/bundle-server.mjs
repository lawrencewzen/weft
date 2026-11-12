#!/usr/bin/env node
// 把服务端用 esbuild 打成少数几个文件，给内网包用（减少 Node 加载的模块数和安装包文件数）。
// 只改打包方式，不改运行逻辑；开发模式仍然直接 node server.mjs。
//
// 产物布局（相对 --out，与源码目录里的相对位置保持一致，源码里按 import.meta.url 找文件的写法不用改）：
//   server.mjs                              服务入口 bundle
//   bin/weft.mjs                            CLI 入口 bundle
//   src/platform/win/pwsh-utf8-wrapper.mjs  node 去跑的 pwsh 包装脚本（独立 bundle）
//   plugins/<id>/index.mjs + plugin.json    内置插件（各自打成单文件）
//   src/v2/views/brand-data.json、contract/openapi.json  按文件路径读的数据
//   node_modules/                           只留无法打进 bundle 的包（见 EXTERNAL_PACKAGES）
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 与包内自带 node 对齐（engines >=22.19，包里是 22.x）。 */
export const BUNDLE_TARGET = 'node22';

/**
 * 不打进 bundle、留在 node_modules 的包（含它们的依赖闭包，由 npm ci 装好）。
 * 原则：按"文件路径"读资源或拉子进程/线程的包。
 */
export const EXTERNAL_PACKAGES = [];


/** 把项目自有源码里的 import.meta.url 换成"该模块在源码树里的虚拟位置"，让相对路径照旧解析到 app 根下的数据文件。 */
function virtualUrlPlugin(root) {
  return {
    name: 'weft-virtual-import-meta-url',
    setup(b) {
      b.onLoad({ filter: /\.(?:mjs|ts)$/ }, async (args) => {
        const rel = path.relative(root, args.path).split(path.sep).join('/');
        if (rel.startsWith('..') || rel.split('/').includes('node_modules')) return undefined;
        const src = await readFile(args.path, 'utf8');
        if (!src.includes('import.meta.url')) return undefined;
        const text = src.replace(/import\.meta\.url/g, `new URL(${JSON.stringify(rel)}, __weftAppRoot).href`);
        return { contents: text, loader: path.extname(args.path) === '.ts' ? 'ts' : 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

/**
 * pi-ai 用"变量 + .ts 改 .js"的写法懒加载 bedrock 和各 OAuth 模块，esbuild 看不见，打包后运行时会找不到文件。
 * 这里把它改成字面量 import("./x.js")，让 esbuild 一并打进 bundle（运行时仍然是用到才初始化）。
 * 匹配不到就报错：pi-ai 升级改了写法时，打包要失败，不能悄悄少打。
 */
const LAZY_IMPORT_FILES = [
  { match: /node_modules\/@earendil-works\/pi-ai\/dist\/api\/bedrock-converse-stream\.lazy\.js$/, fn: 'importNodeOnlyApi' },
  { match: /node_modules\/@earendil-works\/pi-ai\/dist\/auth\/oauth\/load\.js$/, fn: 'importOAuthModule' },
];

function lazyImportPlugin() {
  return {
    name: 'weft-lazy-import-literal',
    setup(b) {
      b.onLoad({ filter: /\.js$/ }, async (args) => {
        const norm = args.path.split(path.sep).join('/');
        const rule = LAZY_IMPORT_FILES.find((r) => r.match.test(norm));
        if (!rule) return undefined;
        const src = await readFile(args.path, 'utf8');
        const re = new RegExp(`${rule.fn}\\\("(\\./[^"]+)\\.ts"\\)`, 'g');
        let count = 0;
        const text = src.replace(re, (_m, base) => {
          count += 1;
          return `import(${JSON.stringify(`${base}.js`)})`;
        });
        if (count === 0) throw new Error(`打包：${norm} 里没找到 ${rule.fn}("./x.ts")，pi-ai 的懒加载写法变了，需要更新 scripts/bundle-server.mjs`);
        return { contents: text, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

function banner(outRel) {
  const depth = outRel.split('/').length - 1;
  const up = depth === 0 ? './' : '../'.repeat(depth);
  return [
    "import { createRequire as __weftCreateRequire } from 'node:module';",
    'const require = __weftCreateRequire(import.meta.url);',
    `const __weftAppRoot = new URL(${JSON.stringify(up)}, import.meta.url);`,
  ].join('\n');
}

async function listPluginEntries(root) {
  const dir = path.join(root, 'plugins');
  const out = [];
  let items = [];
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const item of items) {
    if (!item.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, item.name, 'plugin.json'), 'utf8'));
      const main = typeof manifest.main === 'string' ? manifest.main : 'index.mjs';
      out.push({ id: item.name, main });
    } catch { /* not a plugin */ }
  }
  return out;
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ root?: string, outDir: string, external?: string[], minify?: boolean, sourcemap?: boolean }} opts
 * @returns {Promise<{ files: string[], externals: string[] }>}
 */
export async function bundleServer({ root = ROOT, outDir, external = EXTERNAL_PACKAGES, minify = false } = {}) {
  if (!outDir) throw new Error('缺少输出目录');
  const out = path.resolve(outDir);
  await mkdir(out, { recursive: true });
  const externals = external.flatMap((name) => [name, `${name}/*`]);

  const entries = [
    { in: 'server.mjs', out: 'server.mjs' },
    { in: 'bin/weft.mjs', out: 'bin/weft.mjs' },
    { in: 'src/platform/win/pwsh-utf8-wrapper.mjs', out: 'src/platform/win/pwsh-utf8-wrapper.mjs' },
  ];
  for (const plugin of await listPluginEntries(root)) {
    entries.push({ in: `plugins/${plugin.id}/${plugin.main}`, out: `plugins/${plugin.id}/${plugin.main}` });
  }
  const files = [];
  for (const entry of entries) {
    const outfile = path.join(out, entry.out);
    await build({
      entryPoints: [path.join(root, entry.in)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: BUNDLE_TARGET,
      external: externals,
      plugins: [virtualUrlPlugin(root), lazyImportPlugin()],
      banner: { js: banner(entry.out) },
      legalComments: 'none',
      logLevel: 'warning',
      minify,
      absWorkingDir: root,
    });
    files.push(entry.out);
  }

  // 按文件路径读取的数据文件，放在源码里相对 import.meta.url 的位置。
  const data = ['src/v2/views/brand-data.json', 'contract/openapi.json'];
  for (const rel of data) {
    await mkdir(path.dirname(path.join(out, rel)), { recursive: true });
    await cp(path.join(root, rel), path.join(out, rel));
    files.push(rel);
  }
  for (const plugin of await listPluginEntries(root)) {
    const rel = `plugins/${plugin.id}/plugin.json`;
    await cp(path.join(root, rel), path.join(out, rel));
    files.push(rel);
  }
  return { files, externals: [...external] };
}

function parseArgs(argv) {
  let outDir;
  let minify = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') outDir = argv[++i];
    else if (argv[i] === '--minify') minify = true;
    else throw new Error(`未知参数 ${argv[i]}\n用法: node scripts/bundle-server.mjs --out <目录> [--minify]`);
  }
  if (!outDir) throw new Error('缺少 --out\n用法: node scripts/bundle-server.mjs --out <目录> [--minify]');
  return { outDir, minify };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { files } = await bundleServer(parseArgs(process.argv.slice(2)));
    console.log(`bundle 完成，${files.length} 个文件：\n  ${files.join('\n  ')}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
