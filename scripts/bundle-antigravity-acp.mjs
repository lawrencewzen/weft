/**
 * Regenerate src/vendor/antigravity-acp.mjs.
 *
 * pi-antigravity-acp-provider is not a runtime dependency. Its peerDependencies
 * pull @earendil-works/pi-coding-agent (and the rest of the 1.4.x set). Weft
 * stays on pi-ai / pi-durable 1.3.0 and only ships the bundle.
 *
 * The plugin is installed for this script only:
 *   npm i --no-save --no-package-lock --legacy-peer-deps pi-antigravity-acp-provider@0.1.17
 * --legacy-peer-deps keeps that install from adding the 1.4.x peers.
 * --no-save / --no-package-lock leave package.json and package-lock.json alone.
 *
 * Runtime packages that stay external are direct dependencies of Weft, pinned
 * to the plugin's package.json: @agentclientprotocol/sdk 1.8.0,
 * @modelcontextprotocol/sdk 1.32.1, proper-lockfile 4.1.2, unzipper 0.12.5,
 * zod 4.6.7. typebox stays on the version already in Weft's tree (1.3.27).
 *
 * createBinding's cwd is rewritten to an injectable resolver (setCwdResolver,
 * or AntigravityRuntime's 4th constructor argument). A missing workspace fails
 * the turn. It does not fall back to process.cwd().
 *
 * discoverModels, loginGoogle, and verifyApiKey still call process.cwd().
 * Those are temporary sessions for the model list and Google login, not the
 * conversation that edits files.
 *
 * The bundle resolves its ACP supervisor with
 * fileURLToPath(new URL("./supervisor.mjs", import.meta.url)). That file is
 * copied next to the bundle from the plugin's src/acp/supervisor.mjs. It only
 * imports node:child_process, so it is not passed through esbuild.
 *
 * Both generated files start with the plugin LICENSE text.
 *
 *   npm run bundle:antigravity-acp
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const PLUGIN_NAME = 'pi-antigravity-acp-provider';
const PLUGIN_VERSION = '0.1.17';
const NO_WORKSPACE = 'agy_err_no_workspace';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const VENDOR_DIR = path.join(ROOT, 'src/vendor');
const outfile = path.join(VENDOR_DIR, 'antigravity-acp.mjs');
const supervisorOutfile = path.join(VENDOR_DIR, 'supervisor.mjs');

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function installedVersion() {
  try {
    const pkgPath = require.resolve(`${PLUGIN_NAME}/package.json`);
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return '';
  }
}

function installPlugin() {
  const spec = `${PLUGIN_NAME}@${PLUGIN_VERSION}`;
  execFileSync(npmCmd(), [
    'i',
    '--no-save',
    '--no-package-lock',
    '--legacy-peer-deps',
    spec,
  ], { cwd: ROOT, stdio: 'inherit' });
  const version = installedVersion();
  if (version !== PLUGIN_VERSION) {
    throw new Error(`expected ${spec} after install, found ${version || 'nothing'}`);
  }
}

function mustReplace(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`bundle rewrite missed ${label}`);
  return source.replace(from, to);
}

function rewriteRuntime(source) {
  const cwdCalls = source.split('process.cwd()').length - 1;
  if (cwdCalls !== 7) {
    throw new Error(`expected 7 process.cwd() calls in runtime.ts, found ${cwdCalls}`);
  }
  let next = mustReplace(
    source,
    '\t\tconst cwd = process.cwd();\n',
    '\t\tconst cwd = await this.resolveBindingCwd(key);\n',
    'createBinding cwd',
  );
  if (next.split('\t\tconst cwd = process.cwd();\n').length !== 1) {
    throw new Error('createBinding still assigns process.cwd()');
  }
  next = mustReplace(
    next,
    `\tconstructor(
\t\tconnectionFactory?: AntigravityConnectionFactory,
\t\tpermissionMode: PermissionMode = "yolo",
\t\tsessionStore?: AcpSessionStore,
\t) {
\t\tthis.connectionFactory = connectionFactory ?? ((options) => new AntigravityAcpConnection(options));
\t\tthis.ensureAgent = connectionFactory === undefined;
\t\tthis.permissionMode = permissionMode;
\t\tthis.sessionStore = sessionStore ?? (this.ensureAgent ? new AcpSessionStore() : undefined);
\t}`,
    `\tconstructor(
\t\tconnectionFactory?: AntigravityConnectionFactory,
\t\tpermissionMode: PermissionMode = "yolo",
\t\tsessionStore?: AcpSessionStore,
\t\tresolveCwd?: AntigravityCwdResolver,
\t) {
\t\tthis.connectionFactory = connectionFactory ?? ((options) => new AntigravityAcpConnection(options));
\t\tthis.ensureAgent = connectionFactory === undefined;
\t\tthis.permissionMode = permissionMode;
\t\tthis.sessionStore = sessionStore ?? (this.ensureAgent ? new AcpSessionStore() : undefined);
\t\tthis.resolveCwd = resolveCwd;
\t}`,
    'AntigravityRuntime constructor',
  );
  next = mustReplace(
    next,
    '\tprivate permissionMode: PermissionMode;\n',
    '\tprivate permissionMode: PermissionMode;\n\tprivate readonly resolveCwd: AntigravityCwdResolver | undefined;\n',
    'resolveCwd field',
  );
  next = mustReplace(
    next,
    'export class AntigravityRuntime {',
    `export type AntigravityCwdResolver = (options: { sessionId?: string }) => string | Promise<string>;

let cwdResolver: AntigravityCwdResolver | undefined;

/** Conversation workspace for ACP sessions. Empty or unset fails the turn. */
export function setCwdResolver(resolver: AntigravityCwdResolver | undefined): void {
	cwdResolver = resolver;
}

export class AntigravityRuntime {`,
    'setCwdResolver',
  );
  next = mustReplace(
    next,
    '\tprivate async createBinding(',
    `\tprivate async resolveBindingCwd(key: string): Promise<string> {
\t\tconst sessionId = key.startsWith("sid:") ? key.slice(4) : undefined;
\t\tconst resolver = this.resolveCwd ?? cwdResolver;
\t\tif (!resolver) throw new AntigravityAcpError("invalid_input", "${NO_WORKSPACE}");
\t\tlet resolved: string;
\t\ttry {
\t\t\tresolved = await resolver({ sessionId });
\t\t} catch (error) {
\t\t\tif (error instanceof AntigravityAcpError) throw error;
\t\t\tconst message = error instanceof Error && error.message ? error.message : "${NO_WORKSPACE}";
\t\t\tthrow new AntigravityAcpError("invalid_input", message);
\t\t}
\t\tif (typeof resolved !== "string" || !resolved.trim()) {
\t\t\tthrow new AntigravityAcpError("invalid_input", "${NO_WORKSPACE}");
\t\t}
\t\treturn resolved;
\t}

\tprivate async createBinding(`,
    'resolveBindingCwd',
  );
  const remaining = next.split('process.cwd()').length - 1;
  if (remaining !== 6) {
    throw new Error(`expected discover/login/verify to keep 6 process.cwd() calls, found ${remaining}`);
  }
  return next;
}

function rewriteProvider(source) {
  return mustReplace(
    source,
    'import { AntigravityRuntime, MANAGED_AUTH_MARKER } from "./runtime.js";',
    'import { AntigravityRuntime, MANAGED_AUTH_MARKER, setCwdResolver } from "./runtime.js";\nexport { AntigravityRuntime, setCwdResolver };',
    'provider re-export',
  );
}

function rewritePluginSource() {
  return {
    name: 'weft-antigravity-cwd',
    setup(build) {
      build.onLoad({ filter: /[/\\]pi-antigravity-acp-provider[/\\]src[/\\]runtime\.ts$/ }, async (args) => {
        const contents = rewriteRuntime(await readFile(args.path));
        return { contents, loader: 'ts' };
      });
      build.onLoad({ filter: /[/\\]pi-antigravity-acp-provider[/\\]src[/\\]provider\.ts$/ }, async (args) => {
        const contents = rewriteProvider(await readFile(args.path));
        return { contents, loader: 'ts' };
      });
    },
  };
}

async function readFile(file) {
  const { readFile: read } = await import('node:fs/promises');
  return read(file, 'utf8');
}

function readPluginLicense() {
  const licensePath = require.resolve(`${PLUGIN_NAME}/LICENSE`);
  const text = readFileSync(licensePath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (text.includes('*/')) throw new Error(`${PLUGIN_NAME} LICENSE cannot be embedded in a block comment`);
  if (!text.startsWith('MIT License\n') || !/^Copyright \(c\) /mu.test(text)) {
    throw new Error(`${PLUGIN_NAME} LICENSE is missing the MIT copyright notice`);
  }
  if (!text.includes('Permission is hereby granted, free of charge')) {
    throw new Error(`${PLUGIN_NAME} LICENSE is missing the MIT permission paragraph`);
  }
  return text;
}

function blockComment(parts) {
  const lines = [];
  for (const part of parts) {
    if (lines.length) lines.push('');
    for (const line of part.split('\n')) lines.push(line);
  }
  return `/*\n${lines.map((line) => (line ? ` * ${line}` : ' *')).join('\n')}\n */\n`;
}

function bundleBanner(license) {
  return blockComment([
    `Generated by scripts/bundle-antigravity-acp.mjs from ${PLUGIN_NAME}@${PLUGIN_VERSION}. Do not edit.`,
    'Regenerate: npm run bundle:antigravity-acp',
    "createBinding cwd comes from setCwdResolver (or AntigravityRuntime's resolveCwd).",
    `A missing workspace fails the turn (${NO_WORKSPACE}) and does not use the process working directory.`,
    'discoverModels, loginGoogle, and verifyApiKey still use the process working directory for temporary login and model-list sessions.',
    'The ACP child process is node ./supervisor.mjs next to this file.',
    license,
  ]);
}

function writeVendoredSupervisor(license) {
  const srcPath = require.resolve(`${PLUGIN_NAME}/src/acp/supervisor.mjs`);
  const original = readFileSync(srcPath, 'utf8');
  let body = original;
  let shebang = '';
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n');
    shebang = body.slice(0, nl + 1);
    body = body.slice(nl + 1);
  }
  if (!body.includes('from "node:child_process"') && !body.includes("from 'node:child_process'")) {
    throw new Error('supervisor.mjs does not import node:child_process');
  }
  const header = blockComment([
    `Copied by scripts/bundle-antigravity-acp.mjs from ${PLUGIN_NAME}@${PLUGIN_VERSION} src/acp/supervisor.mjs. Do not edit.`,
    'Regenerate: npm run bundle:antigravity-acp',
    'ACP starts this process as `node <this directory>/supervisor.mjs --command <agent>`. It is not bundled; it only depends on node:child_process.',
    license,
  ]);
  writeFileSync(supervisorOutfile, shebang + header + body);
}

function relativeMetaUrls(source) {
  const found = [];
  const re = /new URL\(\s*(["'])(\.[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;
  for (let match = re.exec(source); match; match = re.exec(source)) found.push(match[2]);
  return found;
}

function walkSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkSourceFiles(full, out);
    else if (/\.(?:mjs|cjs|js|ts|tsx)$/u.test(name)) out.push(full);
  }
  return out;
}

function reportSiblingRefs(bundleSource) {
  const bundled = relativeMetaUrls(bundleSource);
  const sameDir = [...new Set(bundled.filter((spec) => /^\.\/[^/]+$/u.test(spec)))];
  const other = [...new Set(bundled.filter((spec) => !sameDir.includes(spec)))];
  if (sameDir.length !== 1 || sameDir[0] !== './supervisor.mjs') {
    throw new Error(
      `expected the bundle's only same-directory import.meta.url file to be ./supervisor.mjs, found ${sameDir.join(', ') || 'none'}`,
    );
  }
  const pluginSrc = path.dirname(require.resolve(`${PLUGIN_NAME}/src/provider.ts`));
  const fromSource = [];
  for (const file of walkSourceFiles(pluginSrc)) {
    const refs = relativeMetaUrls(readFileSync(file, 'utf8'));
    for (const spec of refs) fromSource.push(`${path.relative(pluginSrc, file)} -> ${spec}`);
  }
  console.log(`same-directory import.meta.url files copied next to the bundle: ${sameDir.join(', ')}`);
  console.log(`bundle import.meta.url refs outside that directory (not copied): ${other.join(', ') || 'none'}`);
  console.log(`plugin source import.meta.url refs: ${fromSource.join('; ') || 'none'}`);
}

if (installedVersion() !== PLUGIN_VERSION) installPlugin();

const entry = require.resolve(`${PLUGIN_NAME}/src/provider.ts`);
const license = readPluginLicense();

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  plugins: [rewritePluginSource()],
  external: [
    '@earendil-works/pi-ai',
    '@agentclientprotocol/sdk',
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/types.js',
    '@modelcontextprotocol/sdk/server/index.js',
    '@modelcontextprotocol/sdk/server/streamableHttp.js',
    'proper-lockfile',
    'unzipper',
    'zod',
    'typebox',
    'typebox/value',
  ],
  banner: { js: bundleBanner(license) },
  footer: {
    js: '\nexport { resolveSupervisorEntry, AntigravityAcpConnection };\n',
  },
  logLevel: 'info',
});

writeVendoredSupervisor(license);
reportSiblingRefs(readFileSync(outfile, 'utf8'));
