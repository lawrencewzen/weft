// Allow-list for the environment passed to Agent commands.
// Official Pi Durable path: createBashTool prepare and ExecutionEnv.exec
// both set inheritEnv: false and env to this filtered object. NodeExecutionEnv
// then spawn()s with only that env (getShellEnv returns extraEnv when inheritEnv
// is false). No custom process manager.

const BUILTIN_EXACT = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMDRIVE',
  'windir',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TZ',
  'TERM',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'SSH_AUTH_SOCK',
];

const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];

const DENIED_PREFIXES = [
  'WEFT_',
  'LLM_',
  'OPENAI_',
  'ANTHROPIC_',
  'XAI_',
  'DEEPSEEK_',
  'AWS_',
  'AZURE_',
  'GOOGLE_',
];

const DENIED_EXACT = new Set([
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
]);

const DENIED_SUBSTRINGS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD'];

const defaultWarned = new Set();
const builtinByPlatform = new Map();

function fold(name, insensitive) {
  return insensitive ? String(name).toLowerCase() : String(name);
}

function namesAreCaseInsensitive(platform) {
  return platform === 'win32';
}

function builtinExactSet(platform) {
  const cached = builtinByPlatform.get(platform);
  if (cached) return cached;
  const insensitive = namesAreCaseInsensitive(platform);
  const set = new Set();
  for (const name of BUILTIN_EXACT) set.add(fold(name, insensitive));
  for (const name of PROXY_NAMES) {
    set.add(fold(name, insensitive));
    set.add(fold(name.toLowerCase(), insensitive));
  }
  builtinByPlatform.set(platform, set);
  return set;
}

function isBuiltinAllowed(name, platform) {
  const insensitive = namesAreCaseInsensitive(platform);
  if (builtinExactSet(platform).has(fold(name, insensitive))) return true;
  return fold(name, insensitive).startsWith(insensitive ? 'lc_' : 'LC_');
}

function matchesAllowPattern(name, pattern, platform) {
  const insensitive = namesAreCaseInsensitive(platform);
  const needle = fold(name, insensitive);
  const spec = fold(pattern, insensitive);
  if (spec.endsWith('*')) return needle.startsWith(spec.slice(0, -1));
  return needle === spec;
}

function customAllowed(name, patterns, platform) {
  return patterns.some((pattern) => matchesAllowPattern(name, pattern, platform));
}

function setEnvKey(out, key, value, platform) {
  if (namesAreCaseInsensitive(platform)) {
    const folded = key.toLowerCase();
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === folded) delete out[existing];
    }
  }
  out[key] = value;
}

function hasEnvKey(out, key, platform) {
  if (Object.hasOwn(out, key)) return true;
  if (!namesAreCaseInsensitive(platform)) return false;
  const folded = key.toLowerCase();
  return Object.keys(out).some((existing) => existing.toLowerCase() === folded);
}

function readAllowRaw(source, platform) {
  if (!source) return '';
  if (source.WEFT_BASH_ENV_ALLOW != null) return source.WEFT_BASH_ENV_ALLOW;
  if (!namesAreCaseInsensitive(platform)) return '';
  const found = Object.keys(source).find((key) => key.toLowerCase() === 'weft_bash_env_allow');
  return found ? source[found] : '';
}

function defaultLog(message) {
  console.warn(message);
}

function warnBlocked(log, warned, name, reason) {
  const key = String(name).toUpperCase();
  if (warned.has(key)) return;
  warned.add(key);
  log(`WEFT_BASH_ENV: ${name} matched WEFT_BASH_ENV_ALLOW but is blocked (${reason}); agent commands do not receive it`);
}

/**
 * Why this name is never passed to Agent commands, including when listed in
 * WEFT_BASH_ENV_ALLOW. Matching is case-insensitive on every platform so
 * `openai_api_key` is blocked on Linux too.
 */
export function sensitiveEnvReason(name) {
  const upper = String(name).toUpperCase();
  for (const prefix of DENIED_PREFIXES) {
    if (upper.startsWith(prefix)) return `prefix ${prefix}*`;
  }
  if (DENIED_EXACT.has(upper)) return 'denied name';
  for (const part of DENIED_SUBSTRINGS) {
    if (upper.includes(part)) return `name contains ${part}`;
  }
  return null;
}

/** Comma-separated WEFT_BASH_ENV_ALLOW: names, optional trailing `*`. */
export function parseBashEnvAllow(raw) {
  return String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function probeSensitivePattern(pattern) {
  if (pattern === '*') return null;
  let probe = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
  if (probe.endsWith('_')) probe = `${probe}X`;
  return sensitiveEnvReason(probe);
}

/**
 * Environment object for one Agent command. Copies allowed names from `source`
 * (the service process), then overlays `extra` after the same filter. TERM is
 * `dumb` when missing. Sensitive names are omitted even if WEFT_BASH_ENV_ALLOW
 * lists them; that mismatch is logged once per name.
 */
export function bashChildEnv(source = process.env, extra, options = {}) {
  const platform = options.platform ?? process.platform;
  const log = options.log ?? defaultLog;
  const warned = options.warned ?? defaultWarned;
  const patterns = parseBashEnvAllow(options.allow ?? readAllowRaw(source, platform));

  for (const pattern of patterns) {
    const reason = probeSensitivePattern(pattern);
    if (reason) warnBlocked(log, warned, pattern, reason);
  }

  const out = {};
  const take = (key, value) => {
    if (value == null) return;
    const reason = sensitiveEnvReason(key);
    const builtin = isBuiltinAllowed(key, platform);
    const custom = customAllowed(key, patterns, platform);
    if (reason) {
      if (custom) warnBlocked(log, warned, key, reason);
      return;
    }
    if (builtin || custom) setEnvKey(out, key, String(value), platform);
  };

  for (const [key, value] of Object.entries(source || {})) take(key, value);
  for (const [key, value] of Object.entries(extra || {})) take(key, value);

  if (!hasEnvKey(out, 'TERM', platform)) setEnvKey(out, 'TERM', 'dumb', platform);
  return out;
}

/** Official createBashTool `prepare`: stop inheriting process.env, pass the allow-list. */
export function applyBashEnvAllowlist(execution, source = process.env, options) {
  execution.inheritEnv = false;
  execution.env = bashChildEnv(source, execution.env, options);
  return execution;
}
