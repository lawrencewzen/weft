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
 *   npm run bundle:antigravity-acp
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const PLUGIN_NAME = 'pi-antigravity-acp-provider';
const PLUGIN_VERSION = '0.1.17';
const NO_WORKSPACE = 'agy_err_no_workspace';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const outfile = path.join(ROOT, 'src/vendor/antigravity-acp.mjs');

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

if (installedVersion() !== PLUGIN_VERSION) installPlugin();

const entry = require.resolve(`${PLUGIN_NAME}/src/provider.ts`);

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
  banner: {
    js: `/* Generated by scripts/bundle-antigravity-acp.mjs from ${PLUGIN_NAME}@${PLUGIN_VERSION}. Do not edit.
 * Regenerate: npm run bundle:antigravity-acp
 * createBinding cwd comes from setCwdResolver (or AntigravityRuntime's resolveCwd).
 * A missing workspace fails the turn (${NO_WORKSPACE}) and does not use the process working directory.
 * discoverModels, loginGoogle, and verifyApiKey still use the process working directory for temporary login and model-list sessions.
 */`,
  },
  logLevel: 'info',
});
