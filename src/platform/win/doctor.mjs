/**
 * `weft doctor`: environment self-check for intranet Windows (GBK / pwsh).
 * Runnable on every platform; Windows-only items print「不适用」.
 *
 * Does not print Token / Key / password / env values — only whether they are set.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const NA = '不适用';
export const ROUNDTRIP_TEXT = '中文自检';
/** Same prefix WorkspaceExecutionEnv prepends when falling back to PowerShell. */
export const PWSH_UTF8_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}';
export const CODE_PAGE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage';
export const LOCALE_KEY = 'HKCU\\Control Panel\\International';
export const WINNT_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD/;
const ALWAYS_ENV = ['WEFT_LLM', 'LLM_API', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'];
const SKIP_ENV_REPORT = new Set(['WEFT_DATA_DIR', 'PATH', 'PATHEXT', 'Path']);

const SHELL_FN_NAMES = [
  'describeAgentShell',
  'resolveAgentShell',
  'detectAgentShell',
  'chooseAgentShell',
  'agentShell',
  'preferredShell',
];

export function decodeRegOutput(buf) {
  const raw = asBuffer(buf);
  if (!raw.length) return '';
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.toString('utf16le');
  if (raw.includes(0) && raw.length % 2 === 0) return raw.toString('utf16le');
  return raw.toString('utf8');
}

export function parseRegValues(stdout) {
  const text = typeof stdout === 'string' ? stdout : decodeRegOutput(stdout);
  const out = {};
  const re = /^\s+(\S+)\s+REG_\w+\s+(.*)$/gm;
  let match;
  while ((match = re.exec(text))) {
    out[match[1]] = match[2].trim();
  }
  return out;
}

export function parseCodePageRegistry(stdout) {
  const values = parseRegValues(stdout);
  return { acp: values.ACP || '', oemcp: values.OEMCP || '' };
}

export function findOnPath(program, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const pathEnv = opts.pathEnv ?? '';
  const exists = opts.existsSync ?? existsSync;
  const join = opts.join ?? path.join;
  const sep = opts.pathSep ?? (platform === 'win32' ? ';' : ':');
  if (!program || !pathEnv) return null;
  const names = candidateNames(program, platform, opts.pathext);
  for (const dir of String(pathEnv).split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

function candidateNames(program, platform, pathext) {
  if (platform !== 'win32') return [program];
  if (/\.[^./\\]+$/.test(program)) return [program];
  const exts = String(pathext || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const names = [program];
  for (const ext of exts) {
    names.push(program + ext);
    names.push(program + ext.toLowerCase());
  }
  return names;
}

export function gbkDecoderAvailable(Decoder = TextDecoder) {
  try {
    const dec = new Decoder('gbk');
    return typeof dec.decode === 'function';
  } catch {
    return false;
  }
}

export function quotePwshLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildPwshRoundtripArgs(text = ROUNDTRIP_TEXT) {
  const script = `${PWSH_UTF8_PREFIX}\nWrite-Output ${quotePwshLiteral(text)}`;
  return ['-NoProfile', '-NonInteractive', '-Command', script];
}

export function normalizeRoundtripText(text) {
  let s = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
    || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s.split('\n')[0].trim();
}

export function judgeRoundtrip(stdout, expected = ROUNDTRIP_TEXT, Decoder = TextDecoder) {
  const buf = asBuffer(stdout);
  const utf8 = normalizeRoundtripText(buf.toString('utf8'));
  if (utf8 === expected) return { verdict: '正常', encoding: 'utf-8' };
  let gbk = '';
  try {
    gbk = normalizeRoundtripText(new Decoder('gbk').decode(buf));
  } catch { /* no gbk */ }
  if (gbk === expected) return { verdict: '乱码', encoding: 'gbk' };
  return { verdict: '乱码', encoding: 'unknown' };
}

export function envPresenceLines(env, names = ALWAYS_ENV) {
  const keys = Object.keys(env || {});
  const seen = new Set();
  const lines = [];
  const add = (name, set) => {
    if (SKIP_ENV_REPORT.has(name) || seen.has(name.toUpperCase())) return;
    seen.add(name.toUpperCase());
    lines.push(`${name}: ${set ? '已设置' : '未设置'}`);
  };
  for (const name of names) add(name, hasEnv(env, name));
  for (const key of keys) {
    if (!SECRET_NAME_RE.test(key.toUpperCase())) continue;
    if (!hasEnv(env, key)) continue;
    add(key, true);
  }
  return lines;
}

export function reportContainsSecrets(text, env) {
  const values = [];
  for (const [key, value] of Object.entries(env || {})) {
    if (!value) continue;
    if (SKIP_ENV_REPORT.has(key)) continue;
    if (!SECRET_NAME_RE.test(key.toUpperCase()) && !ALWAYS_ENV.includes(key)) continue;
    if (String(value).length >= 4) values.push(String(value));
  }
  return values.filter((value) => text.includes(value));
}

export function interpretShellModule(mod) {
  if (!mod || typeof mod !== 'object') return null;
  for (const name of SHELL_FN_NAMES) {
    if (typeof mod[name] === 'function') return { kind: 'fn', name, fn: mod[name] };
  }
  if (typeof mod.default === 'function') return { kind: 'fn', name: 'default', fn: mod.default };
  const obj = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  if (obj.program || obj.path || obj.shell || obj.name || obj.label) {
    return { kind: 'value', value: obj };
  }
  return null;
}

export function formatShellChoice(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  const program = value.program || value.shell || value.name || value.label || '';
  if (program === NA) {
    return value.detail ? `${NA}（${value.detail}）` : NA;
  }
  const bits = [program];
  if (value.path || value.exe) bits.push(String(value.path || value.exe));
  if (value.version) bits.push(String(value.version));
  if (value.detail) bits.push(String(value.detail));
  return bits.filter(Boolean).join('，');
}

export function chooseShellPwshFirst({ platform, pwsh, powershell, bash }) {
  if (platform !== 'win32') {
    return { label: NA, detail: '非 Windows，Agent 走 Pi Durable 默认 bash' };
  }
  if (pwsh?.path) return { program: 'pwsh', path: pwsh.path, version: pwsh.version };
  if (powershell?.path) {
    return { program: 'Windows PowerShell', path: powershell.path, version: powershell.version };
  }
  if (bash?.path) return { program: 'bash', path: bash.path, version: bash.version };
  return { label: '未找到', detail: '未找到 pwsh、Windows PowerShell 或 bash' };
}

export async function runDoctor(opts = {}) {
  const deps = makeDeps(opts);
  const system = await collectSystem(deps);
  const node = collectNode(deps);
  const ps = await collectPowerShell(deps);
  const git = await collectGit(deps);
  const weft = await collectWeft(deps);
  const roundtrip = await collectRoundtrip(deps, ps);
  const envLines = envPresenceLines(deps.env);
  return [
    'Weft 自检',
    '========',
    '',
    render('系统', system),
    '',
    render('Node', node),
    '',
    render('PowerShell', ps.lines),
    '',
    render('Git', git),
    '',
    render('Weft', weft),
    '',
    render('往返', roundtrip),
    '',
    render('环境变量', envLines),
  ].join('\n');
}

function render(title, lines) {
  return [`[${title}]`, ...lines].join('\n');
}

function makeDeps(opts) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const which = opts.which ?? ((name) => findOnPath(name, {
    platform,
    pathEnv: env.PATH || env.Path || '',
    pathext: env.PATHEXT,
    existsSync: opts.existsSync ?? existsSync,
  }));
  return {
    platform,
    env,
    exec,
    which,
    os: opts.os ?? os,
    nodeVersion: opts.nodeVersion ?? process.version,
    execPath: opts.execPath ?? process.execPath,
    locale: opts.locale ?? (() => Intl.DateTimeFormat().resolvedOptions().locale),
    gbk: opts.gbk ?? gbkDecoderAvailable(),
    Decoder: opts.Decoder ?? TextDecoder,
    dataDir: opts.dataDir ?? '',
    inspectService: opts.inspectService,
    loadShellModule: opts.loadShellModule ?? defaultLoadShellModule,
    readRegistry: opts.readRegistry ?? ((key) => defaultReadRegistry(key, exec)),
    existsSync: opts.existsSync ?? existsSync,
    readFileSync: opts.readFileSync ?? readFileSync,
    pidIsLive: opts.pidIsLive ?? pidIsLive,
  };
}

async function collectSystem(deps) {
  const lines = [];
  const type = deps.os.type?.() ?? '';
  const release = deps.os.release?.() ?? '';
  const arch = deps.os.arch?.() ?? '';
  const version = deps.os.version?.() ?? '';
  lines.push(`OS: ${[type, release, arch].filter(Boolean).join(' ')}`);
  if (version && version !== release) lines.push(`内核: ${version}`);
  if (deps.platform === 'win32') {
    const nt = parseRegValues(await deps.readRegistry(WINNT_KEY));
    const product = [nt.ProductName, nt.DisplayVersion, nt.CurrentBuild].filter(Boolean).join(' ');
    if (product) lines.push(`Windows: ${product}`);
    const loc = parseRegValues(await deps.readRegistry(LOCALE_KEY));
    lines.push(`系统区域: ${loc.LocaleName || deps.locale()}`);
    const cp = parseCodePageRegistry(await deps.readRegistry(CODE_PAGE_KEY));
    lines.push(`ACP: ${cp.acp || '读不到'}`);
    lines.push(`OEMCP: ${cp.oemcp || '读不到'}`);
  } else {
    lines.push(`系统区域: ${deps.locale()}`);
    lines.push(`ACP: ${NA}`);
    lines.push(`OEMCP: ${NA}`);
  }
  return lines;
}

function collectNode(deps) {
  return [
    `版本: ${deps.nodeVersion}`,
    `可执行文件: ${deps.execPath}`,
    `TextDecoder('gbk'): ${deps.gbk ? '可用' : '不可用'}`,
  ];
}

async function collectPowerShell(deps) {
  const pwshPath = deps.which('pwsh');
  const powershellPath = deps.platform === 'win32'
    ? (deps.which('powershell') || deps.which('powershell.exe'))
    : null;
  const bashPath = deps.which('bash');
  const pwsh = await describeProgram(deps, pwshPath, async (bin) => {
    const r = await deps.exec(bin, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
    return firstLine(r);
  });
  let powershell = null;
  if (deps.platform === 'win32') {
    powershell = await describeProgram(deps, powershellPath, async (bin) => {
      const r = await deps.exec(bin, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']);
      return firstLine(r);
    });
  }
  const bash = await describeProgram(deps, bashPath, async (bin) => {
    const r = await deps.exec(bin, ['--version']);
    return firstLine(r);
  });
  const agent = await resolveAgentShell(deps, { pwsh, powershell, bash });
  const lines = [
    `pwsh: ${formatProg(pwsh)}`,
    `Windows PowerShell: ${deps.platform === 'win32' ? formatProg(powershell) : NA}`,
    `Agent 命令将使用: ${agent}`,
  ];
  return { lines, pwsh, powershell, bash, agent };
}

async function resolveAgentShell(deps, found) {
  let mod = null;
  try {
    mod = await deps.loadShellModule();
  } catch {
    const fallback = formatShellChoice(chooseShellPwshFirst({ platform: deps.platform, ...found }));
    return `${fallback}（读取 shell.mjs 失败，改用 pwsh 优先规则）`;
  }
  if (mod && mod.__loadError) {
    const fallback = formatShellChoice(chooseShellPwshFirst({ platform: deps.platform, ...found }));
    return `${fallback}（读取 shell.mjs 失败，改用 pwsh 优先规则）`;
  }
  const interpreted = interpretShellModule(mod);
  if (!interpreted) {
    return formatShellChoice(chooseShellPwshFirst({ platform: deps.platform, ...found }));
  }
  if (interpreted.kind === 'value') return formatShellChoice(interpreted.value);
  try {
    const result = await interpreted.fn({
      platform: deps.platform,
      env: deps.env,
      exec: deps.exec,
      which: deps.which,
      pwsh: found.pwsh,
      powershell: found.powershell,
      bash: found.bash,
    });
    const text = formatShellChoice(result);
    return text || formatShellChoice(chooseShellPwshFirst({ platform: deps.platform, ...found }));
  } catch {
    return formatShellChoice(chooseShellPwshFirst({ platform: deps.platform, ...found }));
  }
}

async function collectGit(deps) {
  const gitPath = deps.which('git') || deps.which('git.exe');
  if (!gitPath) return ['路径: 未找到', '版本: 未找到', 'core.quotepath: 未找到'];
  const version = firstLine(await deps.exec(gitPath, ['--version']));
  const quote = firstLine(await deps.exec(gitPath, ['config', '--get', 'core.quotepath']));
  const quoteLine = quote || '未设置（默认 true）';
  return [
    `路径: ${gitPath}`,
    `版本: ${version || '读不到'}`,
    `core.quotepath: ${quoteLine}`,
  ];
}

async function collectWeft(deps) {
  const dataDir = deps.dataDir || '（未指定）';
  const lines = [`数据目录: ${dataDir}`];
  let info = { running: false };
  try {
    info = deps.inspectService
      ? await deps.inspectService()
      : defaultInspectService(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`服务: 检查失败（${message}）`);
    lines.push('端口: 未知');
    return lines;
  }
  if (info?.running) {
    lines.push(`端口: ${info.port ?? '未知'}`);
    const pid = info.pid != null ? `（pid ${info.pid}）` : '';
    lines.push(`服务: 正在运行${pid}`);
  } else {
    lines.push('端口: 未运行');
    lines.push(info?.error ? `服务: 未运行（${info.error}）` : '服务: 未运行');
  }
  return lines;
}

function defaultInspectService(deps) {
  const file = path.join(deps.dataDir, 'service.json');
  let discovery;
  try {
    discovery = JSON.parse(deps.readFileSync(file, 'utf8'));
  } catch {
    return { running: false };
  }
  const pid = Number(discovery?.pid);
  const port = Number(discovery?.port);
  if (!Number.isInteger(pid) || pid <= 0 || !deps.pidIsLive(pid)) return { running: false };
  return { running: true, pid, port: Number.isInteger(port) && port > 0 ? port : undefined };
}

async function collectRoundtrip(deps, ps) {
  const lines = [];
  if (ps.pwsh?.path) {
    const args = buildPwshRoundtripArgs(ROUNDTRIP_TEXT);
    const result = await deps.exec(ps.pwsh.path, args);
    const judged = judgeRoundtrip(result.stdout, ROUNDTRIP_TEXT, deps.Decoder);
    const fail = result.error ? `（执行失败）` : result.code && result.code !== 0 ? `（退出码 ${result.code}）` : '';
    lines.push(`pwsh（UTF-8 前缀）: ${judged.verdict}${fail}`);
  } else {
    lines.push(`pwsh（UTF-8 前缀）: 未安装 pwsh`);
  }
  if (deps.platform === 'win32') {
    const cmd = deps.env.ComSpec || deps.which('cmd') || deps.which('cmd.exe') || 'cmd.exe';
    const result = await deps.exec(cmd, ['/d', '/s', '/c', `echo ${ROUNDTRIP_TEXT}`]);
    const judged = judgeRoundtrip(result.stdout, ROUNDTRIP_TEXT, deps.Decoder);
    const fail = result.error ? `（执行失败）` : '';
    lines.push(`cmd /c echo: ${judged.verdict}${fail}`);
  } else {
    lines.push(`cmd /c echo: ${NA}`);
  }
  return lines;
}

async function describeProgram(deps, bin, versionOf) {
  if (!bin) return null;
  let version = '';
  try { version = (await versionOf(bin)) || ''; } catch { version = ''; }
  return { path: bin, version };
}

function formatProg(prog) {
  if (!prog?.path) return '未找到';
  return prog.version ? `${prog.path}（${prog.version}）` : prog.path;
}

function firstLine(result) {
  const text = asBuffer(result?.stdout).toString('utf8').replace(/\r/g, '').trim();
  return text.split('\n')[0].trim();
}

function hasEnv(env, name) {
  if (!env) return false;
  if (Object.prototype.hasOwnProperty.call(env, name) && String(env[name] ?? '').trim() !== '') {
    return true;
  }
  const folded = name.toLowerCase();
  return Object.keys(env).some(
    (key) => key.toLowerCase() === folded && String(env[key] ?? '').trim() !== '',
  );
}

function pidIsLive(pid) {
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

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(String(value), 'utf8');
}

function isModuleNotFound(err) {
  const code = err && typeof err === 'object' ? err.code : '';
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const message = err instanceof Error ? err.message : String(err || '');
  return /Cannot find module|ERR_MODULE_NOT_FOUND/.test(message);
}

async function defaultLoadShellModule() {
  const href = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'shell.mjs')).href;
  try {
    return await import(href);
  } catch (err) {
    if (isModuleNotFound(err)) return null;
    return { __loadError: err };
  }
}

export async function defaultExec(command, args = [], options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env,
        cwd: options.cwd,
      });
    } catch (err) {
      done({ code: null, error: err, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done({
        code: null,
        error: new Error('timeout'),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      done({ code: null, error: err, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

async function defaultReadRegistry(key, exec) {
  const result = await exec('reg', ['query', key]);
  if (result.error || (result.code != null && result.code !== 0)) return Buffer.alloc(0);
  return result.stdout;
}
