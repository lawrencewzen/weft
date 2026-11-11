// grep for the Pi Durable kernel: ripgrep finds the matches, then every matched
// line is re-read through api.env and printed as `path:LINE#HASH:content`, so
// results feed straight into the hashline `edit` tool. File access (sensitive
// path refusal, encoding) stays in api.env; ripgrep only supplies file names
// and line numbers. Without ripgrep a plain JS scan runs instead.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bool, obj, opt, str } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { computeLineHash } from '../vendor/hashline/hash.mjs';
import { bashChildEnv } from './bash-env.mjs';
import { splitVisibleLines as splitVisibleLinesOf } from '../vendor/hashline/format.mjs';
import { normalizeToLF, requireEnv, stripBom } from './hashline-tools.mjs';
import { detect, isTextEncodingDetectEnabled } from '../platform/win/text-encoding.mjs';

export const GREP_MAX_MATCHES = 200;
export const GREP_TIMEOUT_MS = 20_000;
const GREP_MAX_LINE_CHARS = 400;
const FALLBACK_MAX_FILE_BYTES = 2 * 1024 * 1024;
const NON_ASCII = /[^\x00-\x7f]/;
const GBK_DETECT_MAX_BYTES = 32 * 1024 * 1024;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where to find ripgrep: WEFT_RG_PATH, then <app>/tools/rg/rg(.exe), then PATH
 * (returned as the bare name; a missing binary surfaces as a spawn error and
 * the JS scan takes over).
 */
export function resolveRipgrep({ env = process.env, appDir = APP_DIR, platform = process.platform, exists = existsSync } = {}) {
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';
  const configured = String(env.WEFT_RG_PATH ?? '').trim();
  if (configured && exists(configured)) return configured;
  const bundled = path.join(appDir, 'tools', 'rg', exe);
  if (exists(bundled)) return bundled;
  return 'rg';
}

function displayPath(cwd, filePath) {
  const rel = path.relative(cwd, filePath);
  const text = (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? filePath : rel;
  return String(text).replaceAll('\\', '/');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchGlob(file, glob) {
  if (!glob) return true;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DS::').replace(/\*/g, '[^/]*').replace(/::DS::/g, '.*');
  return new RegExp(`^${escaped}$`).test(file) || new RegExp(`${escaped}$`).test(file);
}

/**
 * Run ripgrep and collect `{ file, line }` hits (absolute file paths).
 * Stops as soon as more than `limit` hits arrived. Resolves
 * `{ unavailable: true }` when the binary cannot be started.
 */
export function runRipgrep({ rg, args, cwd, limit, timeoutMs, signal, spawnEnv }) {
  return new Promise((resolve, reject) => {
    const hits = [];
    let truncated = false;
    let timedOut = false;
    let stderr = '';
    let buffer = '';
    let settled = false;
    let child;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const kill = () => { try { child?.kill(); } catch { /* already gone */ } };
    const onAbort = () => { kill(); finish({ hits, truncated, timedOut, aborted: true, stderr, code: null }); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    try {
      child = spawn(rg, args, { cwd, env: spawnEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') finish({ unavailable: true, hits: [], stderr: String(error.message) });
      else if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk.toString('utf8'); });
    const take = (line) => {
      if (!line || hits.length > limit) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event?.type !== 'match') return;
      const file = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (typeof file !== 'string' || !Number.isInteger(lineNumber)) return;
      hits.push({ file, line: lineNumber });
      if (hits.length > limit) { truncated = true; kill(); }
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        take(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    child.on('close', (code) => {
      take(buffer);
      finish({ hits: hits.slice(0, limit), truncated, timedOut, stderr, code });
    });
  });
}

async function walkFiles(env, start, context, acc, deadline) {
  if (Date.now() > deadline) return;
  const info = getOrThrow(await env.fileInfo(start, context));
  if (info.kind === 'directory') {
    const listing = getOrThrow(await env.listDir(start, context));
    for (const entry of listing) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const child = await env.joinPath([start, entry.name], context);
      if (!child.ok) continue;
      try {
        await walkFiles(env, child.value, context, acc, deadline);
      } catch {
        continue;
      }
    }
    return;
  }
  acc.push({ file: start, size: info.size });
}

/** JS scan used when ripgrep is unavailable: skips .git/node_modules, binaries and large files. */
async function scanWithoutRipgrep({ env, root, args, context, limit, deadline }) {
  const files = [];
  await walkFiles(env, root, context, files, deadline);
  let re;
  const flags = args.ignoreCase ? 'i' : '';
  try {
    re = new RegExp(args.literal ? escapeRegExp(args.pattern) : args.pattern, flags);
  } catch {
    re = new RegExp(escapeRegExp(args.pattern), flags);
  }
  const hits = [];
  let truncated = false;
  let timedOut = false;
  for (const { file, size } of files) {
    if (Date.now() > deadline) { timedOut = true; break; }
    const shown = displayPath(env.cwd, file);
    if (args.glob && !matchGlob(shown, args.glob) && !matchGlob(path.basename(file), args.glob)) continue;
    if (size > FALLBACK_MAX_FILE_BYTES) continue;
    const text = await env.readTextFile(file, context);
    if (!text.ok || text.value.includes('\0')) continue;
    const lines = splitVisibleLinesOf(normalizeToLF(stripBom(text.value).text));
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (hits.length >= limit) { truncated = true; break; }
      hits.push({ file, line: i + 1 });
    }
    if (truncated) break;
  }
  return { hits, truncated, timedOut };
}

function clip(line) {
  return line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…` : line;
}

const GREP_DESCRIPTION = [
  'Search file contents with ripgrep. Every matched line returns as `path:LINE#HASH:content`; copy the `LINE#HASH` part verbatim into `edit` without a prior `read`.',
  '',
  '`pattern` is a regular expression (Rust regex syntax) unless `literal: true`. Hidden files are searched except `.git`; `.gitignore` is respected and binary files are skipped. Use `path` to scope to a file or directory and `glob` to filter by file name (e.g. "**/*.ts"). Paths outside the workspace are readable except sensitive locations (credentials).',
  '',
  `At most ${GREP_MAX_MATCHES} matching lines are returned. When results are too broad, scope with path/glob first, then tighten the pattern.`,
].join('\n');

/** `rg` and `readText` are injectable for tests; defaults resolve ripgrep and read through api.env. */
/**
 * ripgrep matches bytes, so a Chinese pattern never hits a GBK file (the
 * intranet encoding). With `gbkSearch` on and a non-ASCII pattern a second
 * `--encoding gbk` pass runs; its hits count only in files the env itself
 * decodes as GBK, so UTF-8 files are never mis-hit by the GBK decoder.
 */
async function onlyGbkFiles(env, hits, context) {
  const verdict = new Map();
  const kept = [];
  for (const hit of hits) {
    const file = path.resolve(env.cwd, hit.file);
    if (!verdict.has(file)) {
      let isGbk = false;
      try {
        const info = await env.fileInfo(file, context);
        if (info.ok && info.value.size <= GBK_DETECT_MAX_BYTES) {
          const bytes = await env.readBinaryFile(file, context);
          isGbk = bytes.ok && detect(bytes.value) === 'gbk';
        }
      } catch { /* unreadable: not a GBK hit */ }
      verdict.set(file, isGbk);
    }
    if (verdict.get(file)) kept.push(hit);
  }
  return kept;
}

export function mergeHits(first, second, cwd, limit) {
  const seen = new Set(first.map((h) => `${path.resolve(cwd, h.file)}\0${h.line}`));
  const merged = [...first];
  for (const hit of second) {
    const key = `${path.resolve(cwd, hit.file)}\0${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  return { hits: merged.slice(0, limit), truncated: merged.length > limit };
}

export function createGrepTool({
  ripgrep = () => resolveRipgrep(),
  limit = GREP_MAX_MATCHES,
  timeoutMs = GREP_TIMEOUT_MS,
  gbkSearch = () => isTextEncodingDetectEnabled(),
} = {}) {
  return defineTool({
    name: 'grep',
    description: GREP_DESCRIPTION,
    parameters: obj({
      pattern: str({ description: 'Regular expression (or literal text with literal: true)' }),
      path: opt(str({ description: 'File or directory to search (default: workspace)' })),
      glob: opt(str({ description: 'File name filter such as "*.ts" or "src/**/*.mjs"' })),
      ignoreCase: opt(bool({ description: 'Case-insensitive match' })),
      literal: opt(bool({ description: 'Treat pattern as plain text, not a regular expression' })),
    }, { open: true }),
    replay: 'safe',
    async execute(args, api, context) {
      const env = requireEnv(api);
      if (typeof args.pattern !== 'string' || args.pattern === '') throw new Error('"pattern" is required.');
      const root = getOrThrow(await env.absolutePath(args.path || '.', context));
      // Fails here for a sensitive or missing root.
      getOrThrow(await env.fileInfo(root, context));
      const deadline = Date.now() + timeoutMs;

      let found;
      const rg = ripgrep();
      if (rg) {
        const rel = path.relative(env.cwd, root);
        const target = rel === '' ? '.' : (rel.startsWith('..') || path.isAbsolute(rel) ? root : rel);
        const rgArgs = [
          '--json', '--no-config', '--hidden', '--no-require-git',
          '--glob', '!.git',
          ...(args.glob ? ['--glob', args.glob] : []),
          ...(args.ignoreCase ? ['-i'] : []),
          ...(args.literal ? ['-F'] : []),
          '-e', args.pattern, '--', target,
        ];
        const pass = (extra = [], cap = limit) => runRipgrep({
          rg, args: [...extra, ...rgArgs], cwd: env.cwd, limit: cap, timeoutMs, signal: context?.abortSignal,
          spawnEnv: bashChildEnv(process.env),
        });
        const ran = await pass();
        if (ran.aborted) throw new Error('Operation aborted');
        if (!ran.unavailable) {
          if (ran.code === 2 && ran.hits.length === 0 && !ran.truncated && !ran.timedOut) {
            const reason = String(ran.stderr || '').trim().split(/\r?\n/).slice(0, 3).join('\n');
            throw new Error(`ripgrep: ${reason || 'search failed'}. Fix the pattern, or set literal: true.`);
          }
          found = ran;
          if (NON_ASCII.test(args.pattern) && gbkSearch()) {
            const gbk = await pass(['--encoding', 'gbk'], limit * 5); // UTF-8 files may hit too and are dropped below
            if (gbk.aborted) throw new Error('Operation aborted');
            if (!gbk.unavailable && gbk.code !== 2) {
              const extra = await onlyGbkFiles(env, gbk.hits, context);
              const merged = mergeHits(found.hits, extra, env.cwd, limit);
              found = {
                ...found,
                hits: merged.hits,
                truncated: found.truncated || gbk.truncated || merged.truncated,
                timedOut: found.timedOut || gbk.timedOut,
              };
            }
          }
        }
      }
      if (!found) found = await scanWithoutRipgrep({ env, root, args, context, limit, deadline });

      // rg runs multi-threaded, so hits arrive in any order: sort them for a stable result.
      found.hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
      const byFile = new Map();
      for (const hit of found.hits) {
        const file = path.resolve(env.cwd, hit.file);
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(hit.line);
      }
      const lines = [];
      for (const [file, numbers] of byFile) {
        // The env refuses sensitive locations here; such files are dropped.
        const text = await env.readTextFile(file, context);
        if (!text.ok || text.value.includes('\0')) continue;
        const fileLines = splitVisibleLinesOf(normalizeToLF(stripBom(text.value).text));
        const shown = displayPath(env.cwd, file);
        for (const n of numbers) {
          if (n > fileLines.length) continue;
          lines.push(`${shown}:${n}#${computeLineHash(fileLines, n - 1)}:${clip(fileLines[n - 1])}`);
        }
      }

      const diagnostics = [];
      if (found.truncated) {
        diagnostics.push({
          severity: 'info',
          code: 'truncated',
          message: `Stopped at ${limit} matching lines. Narrow with path/glob or a more specific pattern, then rerun.`,
        });
      }
      if (found.timedOut) {
        diagnostics.push({
          severity: 'warn',
          code: 'timeout',
          message: `Search stopped after ${Math.round(timeoutMs / 1000)}s; results are partial. Narrow with path/glob.`,
        });
      }
      const text = lines.join('\n');
      return { output: [{ type: 'text', text }], structuredOutput: text, diagnostics };
    },
  });
}
