import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { discoveryPath, type ServiceDiscovery } from './daemon/discovery.ts';
import { LAUNCHER_ID } from './daemon/idle.ts';
import { PROTOCOL_VERSION } from './version.ts';

export const PROBE_TIMEOUT_MS = 3_000;
export const LAUNCH_TIMEOUT_MS = 30_000;
export const EXIT_WAIT_MS = 15_000;

export function probeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.WEFT_PROBE_TIMEOUT_MS || '').trim();
  if (!raw) return PROBE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PROBE_TIMEOUT_MS;
  return n;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server.mjs');
const LOG_REL = path.join('logs', 'service.log');

const USAGE = `用法: weft [--data-dir <路径>] <open|status|stop> [--print]

  open    找到或拉起服务，打开浏览器登录 /next
  status  显示服务是否在运行
  stop    请求空闲的服务退出`;

class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export type CliCommand = 'open' | 'status' | 'stop';

export type CliArgs = {
  command: CliCommand;
  dataDir?: string;
  print: boolean;
};

type ServiceInfo = {
  protocolVersion: string;
  serviceVersion: string;
  pid: number;
  startedAt: number;
};

type LiveService = {
  discovery: ServiceDiscovery;
  info: ServiceInfo;
};

export function expectedProtocolVersion(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.WEFT_EXPECT_PROTOCOL || '').trim();
  return override || PROTOCOL_VERSION;
}

export function resolveDataDir(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = REPO_ROOT,
): string {
  if (flag) return path.resolve(flag);
  const fromEnv = String(env.WEFT_DATA_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(repoRoot, 'data');
}

export function parseArgs(argv: string[]): CliArgs {
  let command: CliCommand | undefined;
  let dataDir: string | undefined;
  let print = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--print') {
      print = true;
      continue;
    }
    if (arg === '--data-dir') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new CliError('缺少 --data-dir 的路径', 1);
      }
      dataDir = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliError(`未知参数 ${arg}\n${USAGE}`, 1);
    }
    if (arg === 'open' || arg === 'status' || arg === 'stop') {
      if (command) throw new CliError(`多余的命令 ${arg}\n${USAGE}`, 1);
      command = arg;
      continue;
    }
    throw new CliError(`未知参数 ${arg}\n${USAGE}`, 1);
  }
  if (!command) throw new CliError(USAGE, 1);
  if (print && command !== 'open') {
    throw new CliError('--print 只能和 open 一起用', 1);
  }
  return { command, dataDir, print };
}

function pidIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (existsSync(path.join('/proc', String(pid)))) return true;
  } catch { /* no /proc */ }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'EPERM');
  }
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version || '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function protocolCompatible(cliVersion: string, serviceVersion: string): boolean {
  const cli = parseSemver(cliVersion);
  const svc = parseSemver(serviceVersion);
  if (!cli || !svc) return false;
  if (cli[0] !== svc[0]) return false;
  const cmp = compareSemver(serviceVersion, cliVersion);
  return cmp != null && cmp >= 0;
}

function incompatibleReason(cliVersion: string, serviceVersion: string): string {
  const cli = parseSemver(cliVersion);
  const svc = parseSemver(serviceVersion);
  if (!cli || !svc) {
    return `服务协议版本 ${serviceVersion} 与命令行要求的 ${cliVersion} 不兼容`;
  }
  if (cli[0] !== svc[0]) {
    return `协议大版本不同（服务 ${serviceVersion}，命令行 ${cliVersion}）`;
  }
  return `服务协议版本 ${serviceVersion} 低于命令行要求的 ${cliVersion}`;
}

function isDiscovery(value: unknown): value is ServiceDiscovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.protocolVersion === 'string'
    && typeof row.serviceVersion === 'string'
    && Number.isInteger(row.pid)
    && Number(row.pid) > 0
    && Number.isInteger(row.port)
    && Number(row.port) > 0
    && Number(row.port) <= 65535
    && typeof row.startedAt === 'number'
    && Number.isFinite(row.startedAt)
    && typeof row.token === 'string'
    && row.token.length > 0;
}

function isServiceInfo(value: unknown): value is ServiceInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.protocolVersion === 'string'
    && typeof row.serviceVersion === 'string'
    && Number.isInteger(row.pid)
    && Number(row.pid) > 0
    && typeof row.startedAt === 'number'
    && Number.isFinite(row.startedAt);
}

function loadDiscovery(dataDir: string):
  | { status: 'missing' }
  | { status: 'invalid' }
  | { status: 'ok'; value: ServiceDiscovery } {
  const file = discoveryPath(dataDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'invalid' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isDiscovery(parsed)) return { status: 'invalid' };
    return { status: 'ok', value: parsed };
  } catch {
    return { status: 'invalid' };
  }
}

function removeDiscoveryFile(dataDir: string): void {
  try { unlinkSync(discoveryPath(dataDir)); } catch { /* already gone */ }
}

type NetworkFailKind = 'refused' | 'unresponsive';

type HttpResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; kind: NetworkFailKind; error: string };

type ProbeResult =
  | { kind: 'ok'; info: ServiceInfo }
  | { kind: 'stale' }
  | { kind: 'unresponsive' };

function collectErrorCodes(err: unknown, out: string[] = [], depth = 0): string[] {
  if (!err || typeof err !== 'object' || depth > 8) return out;
  const row = err as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
  if (typeof row.code === 'string') out.push(row.code);
  if (typeof row.name === 'string') out.push(row.name);
  if (row.cause) collectErrorCodes(row.cause, out, depth + 1);
  if (Array.isArray(row.errors)) {
    for (const nested of row.errors) collectErrorCodes(nested, out, depth + 1);
  }
  return out;
}

function networkFailKind(err: unknown): NetworkFailKind {
  const codes = collectErrorCodes(err);
  if (codes.includes('ECONNREFUSED') || codes.includes('WSAECONNREFUSED')) return 'refused';
  return 'unresponsive';
}

function unresponsiveError(pid: number): CliError {
  return new CliError(`服务进程在运行但没有响应（pid ${pid}），请稍后再试`, 1);
}

async function v2Request(opts: {
  port: number;
  method: string;
  pathname: string;
  token: string;
  body?: string;
  timeoutMs?: number;
}): Promise<HttpResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token}`,
  };
  if (opts.body != null) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(`http://127.0.0.1:${opts.port}${opts.pathname}`, {
      method: opts.method,
      headers,
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? probeTimeoutMs()),
      redirect: 'manual',
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: true, status: res.status, json };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'request failed';
    return { ok: false, kind: networkFailKind(err), error: message };
  }
}

async function probeService(discovery: ServiceDiscovery): Promise<ProbeResult> {
  const res = await v2Request({
    port: discovery.port,
    method: 'GET',
    pathname: '/api/v2/service',
    token: discovery.token,
    timeoutMs: probeTimeoutMs(),
  });
  if (!res.ok) return { kind: res.kind === 'refused' ? 'stale' : 'unresponsive' };
  if (res.status === 401) return { kind: 'stale' };
  if (res.status >= 500) return { kind: 'unresponsive' };
  if (res.status !== 200 || !isServiceInfo(res.json)) return { kind: 'unresponsive' };
  if (res.json.pid !== discovery.pid || res.json.startedAt !== discovery.startedAt) {
    return { kind: 'stale' };
  }
  return { kind: 'ok', info: res.json };
}

async function resolveService(dataDir: string): Promise<LiveService | null> {
  const loaded = loadDiscovery(dataDir);
  if (loaded.status === 'missing') return null;
  if (loaded.status === 'invalid') {
    removeDiscoveryFile(dataDir);
    return null;
  }
  const discovery = loaded.value;
  if (!pidIsLive(discovery.pid)) {
    removeDiscoveryFile(dataDir);
    return null;
  }
  const probed = await probeService(discovery);
  if (probed.kind === 'unresponsive') throw unresponsiveError(discovery.pid);
  if (probed.kind === 'stale') {
    removeDiscoveryFile(dataDir);
    return null;
  }
  return { discovery, info: probed.info };
}

function logPath(dataDir: string): string {
  return path.join(dataDir, LOG_REL);
}

function tailLog(dataDir: string, lines = 40): string {
  try {
    const text = readFileSync(logPath(dataDir), 'utf8');
    const parts = text.split(/\r?\n/);
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts.slice(-lines).join('\n');
  } catch {
    return '(没有日志)';
  }
}

function launchService(dataDir: string): number {
  mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  const outFd = openSync(logPath(dataDir), 'a');
  const errFd = openSync(logPath(dataDir), 'a');
  let child;
  try {
    child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO_ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: {
        ...process.env,
        PORT: '0',
        WEFT_DATA_DIR: dataDir,
        WEFT_LAUNCHED_BY: LAUNCHER_ID,
      },
    });
  } finally {
    try { closeSync(outFd); } catch { /* ignore */ }
    try { closeSync(errFd); } catch { /* ignore */ }
  }
  const pid = child.pid;
  if (pid == null) {
    throw new CliError('无法启动服务进程', 1);
  }
  child.once('error', () => {});
  child.unref();
  return pid;
}

async function waitPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!pidIsLive(pid)) return true;
    await sleep(100);
  }
  return !pidIsLive(pid);
}

async function waitForLaunched(dataDir: string, pid: number): Promise<LiveService> {
  const started = Date.now();
  while (Date.now() - started < LAUNCH_TIMEOUT_MS) {
    if (!pidIsLive(pid)) {
      throw new CliError(`服务进程已退出。最近日志：\n${tailLog(dataDir)}`, 1);
    }
    const loaded = loadDiscovery(dataDir);
    if (loaded.status === 'ok' && loaded.value.pid === pid) {
      const probed = await probeService(loaded.value);
      if (probed.kind === 'ok') return { discovery: loaded.value, info: probed.info };
    }
    await sleep(100);
  }
  throw new CliError(`启动服务超时。最近日志：\n${tailLog(dataDir)}`, 1);
}

async function ensureLaunched(dataDir: string): Promise<LiveService> {
  const pid = launchService(dataDir);
  return waitForLaunched(dataDir, pid);
}

type RestartResult = { status: 'exiting' } | { status: 'busy' } | { status: 'error'; message: string };

async function requestRestart(service: LiveService): Promise<RestartResult> {
  const res = await v2Request({
    port: service.discovery.port,
    method: 'POST',
    pathname: '/api/v2/service/restart',
    token: service.discovery.token,
    body: '{}',
  });
  if (!res.ok) return { status: 'error', message: `请求服务重启失败：${res.error}` };
  if (res.status === 409) return { status: 'busy' };
  if (res.status === 202) return { status: 'exiting' };
  return { status: 'error', message: `请求服务重启失败（HTTP ${res.status}）` };
}

async function restartAndRelaunch(dataDir: string, service: LiveService): Promise<LiveService> {
  const oldPid = service.discovery.pid;
  const result = await requestRestart(service);
  if (result.status === 'busy') {
    throw new CliError('服务正在运行任务，等任务结束后再试', 2);
  }
  if (result.status === 'error') {
    throw new CliError(result.message, 1);
  }
  if (!await waitPidExit(oldPid, EXIT_WAIT_MS)) {
    throw new CliError('等待旧服务退出超时', 1);
  }
  return ensureLaunched(dataDir);
}

async function issueLoginUrl(service: LiveService): Promise<string> {
  const res = await v2Request({
    port: service.discovery.port,
    method: 'POST',
    pathname: '/api/v2/auth/web-code',
    token: service.discovery.token,
    body: '{}',
  });
  if (!res.ok) throw new CliError(`申请登录码失败：${res.error}`, 1);
  if (res.status !== 200 || !res.json || typeof res.json !== 'object' || Array.isArray(res.json)) {
    throw new CliError(`申请登录码失败（HTTP ${res.status}）`, 1);
  }
  const code = (res.json as { code?: unknown }).code;
  if (typeof code !== 'string' || !code) {
    throw new CliError('申请登录码失败：响应无效', 1);
  }
  return `http://127.0.0.1:${service.discovery.port}/next/login?code=${encodeURIComponent(code)}`;
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === 'darwin') return { command: 'open', args: [url] };
  if (process.platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

function openInBrowser(url: string): Promise<boolean> {
  const spec = browserCommand(url);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(spec.command, spec.args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.once('error', () => done(false));
      child.once('spawn', () => {
        child.unref();
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

async function cmdOpen(dataDir: string, printOnly: boolean, out: NodeJS.WritableStream, err: NodeJS.WritableStream): Promise<number> {
  const expected = expectedProtocolVersion();
  let service = await resolveService(dataDir);
  if (!service) {
    service = await ensureLaunched(dataDir);
  } else if (!protocolCompatible(expected, service.info.protocolVersion)) {
    service = await restartAndRelaunch(dataDir, service);
  }
  if (!protocolCompatible(expected, service.info.protocolVersion)) {
    err.write(`${incompatibleReason(expected, service.info.protocolVersion)}\n`);
    return 3;
  }
  const url = await issueLoginUrl(service);
  if (printOnly) {
    out.write(`${url}\n`);
    return 0;
  }
  const opened = await openInBrowser(url);
  if (!opened) {
    err.write('无法打开浏览器，请手动访问：\n');
    out.write(`${url}\n`);
    return 0;
  }
  out.write('已在浏览器中打开\n');
  return 0;
}

function formatStartedAt(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}

async function cmdStatus(dataDir: string, out: NodeJS.WritableStream): Promise<number> {
  const service = await resolveService(dataDir);
  if (!service) {
    out.write('服务没有运行\n');
    return 1;
  }
  out.write(`端口: ${service.discovery.port}\n`);
  out.write(`pid: ${service.discovery.pid}\n`);
  out.write(`协议版本: ${service.info.protocolVersion}\n`);
  out.write(`服务版本: ${service.info.serviceVersion}\n`);
  out.write(`启动时间: ${formatStartedAt(service.info.startedAt)}\n`);
  return 0;
}

async function cmdStop(dataDir: string, out: NodeJS.WritableStream): Promise<number> {
  const service = await resolveService(dataDir);
  if (!service) return 0;
  const pid = service.discovery.pid;
  const result = await requestRestart(service);
  if (result.status === 'busy') {
    out.write('服务正在运行任务，没有停止\n');
    return 2;
  }
  if (result.status === 'error') {
    throw new CliError(result.message, 1);
  }
  if (!await waitPidExit(pid, EXIT_WAIT_MS)) {
    throw new CliError('等待服务退出超时', 1);
  }
  out.write('已停止\n');
  return 0;
}

export async function main(
  argv: string[],
  io: { out?: NodeJS.WritableStream; err?: NodeJS.WritableStream } = {},
): Promise<number> {
  const out = io.out ?? process.stdout;
  const err = io.err ?? process.stderr;
  try {
    const args = parseArgs(argv);
    const dataDir = resolveDataDir(args.dataDir);
    if (args.command === 'open') return await cmdOpen(dataDir, args.print, out, err);
    if (args.command === 'status') return await cmdStatus(dataDir, out);
    return await cmdStop(dataDir, out);
  } catch (errObj) {
    if (errObj instanceof CliError) {
      err.write(`${errObj.message}\n`);
      return errObj.exitCode;
    }
    const message = errObj instanceof Error ? errObj.message : String(errObj);
    err.write(`${message}\n`);
    return 1;
  }
}
