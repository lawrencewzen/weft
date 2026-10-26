/**
 * Live git status for a workspace directory.
 * Uses execFile (no shell). Missing git / non-repo → null, never throws to callers.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildGitChildEnv, resolveGitBin } from '../../core/git-import.mjs';
import type { components } from '../contract.gen.ts';
import type { WorkspacesSnapshot } from './sidebar.ts';

const execFileP = promisify(execFile);

export type GitStatus = components['schemas']['GitStatus'];

export const GIT_TIMEOUT_MS = 3_000;

const DROP_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

export type GitRunResult = { stdout: string; code: number };
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>;

export type CollectGitOpts = {
  run?: GitRunner;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type GitStatusCache = {
  peek(id: string): GitStatus | null | undefined;
  ensure(id: string, cwd: string): Promise<GitStatus | null>;
  refresh(id: string, cwd: string): Promise<GitStatus | null>;
  overlay(snap: WorkspacesSnapshot): Promise<WorkspacesSnapshot>;
};

function gitCommandEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = { ...(buildGitChildEnv(base || process.env) as unknown as NodeJS.ProcessEnv) };
  for (const key of DROP_GIT_VARS) delete env[key];
  return env;
}

export function parsePorcelain(text: string): number {
  let count = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trim()) count += 1;
  }
  return count;
}

export function parseNumstat(text: string): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const tab1 = line.indexOf('\t');
    if (tab1 < 0) continue;
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const ins = line.slice(0, tab1);
    const del = line.slice(tab1 + 1, tab2);
    if (ins === '-' || del === '-') continue;
    const a = Number(ins);
    const b = Number(del);
    if (Number.isFinite(a)) insertions += a;
    if (Number.isFinite(b)) deletions += b;
  }
  return { insertions, deletions };
}

export function parseAheadBehind(text: string): { ahead: number; behind: number } | null {
  const line = String(text || '').trim().split(/\r?\n/, 1)[0] || '';
  const parts = line.split(/\s+/);
  if (parts.length < 2) return null;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
  return { ahead: Math.max(0, Math.trunc(ahead)), behind: Math.max(0, Math.trunc(behind)) };
}

export function parseBranch(symbolic: string, shortSha: string): { branch: string; detached: boolean } | null {
  const ref = String(symbolic || '').trim();
  if (ref && ref !== 'HEAD') return { branch: ref, detached: false };
  const sha = String(shortSha || '').trim();
  if (sha) return { branch: sha, detached: true };
  return null;
}

function defaultRunner(opts: CollectGitOpts): GitRunner {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const env = gitCommandEnv(opts.env);
  const bin = resolveGitBin(opts.env);
  return async (args, cwd) => {
    try {
      const { stdout } = await execFileP(bin, args, {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 2_000_000,
        encoding: 'utf8',
        env,
      }) as { stdout: string };
      return { stdout: String(stdout || ''), code: 0 };
    } catch (err) {
      const e = err as { code?: string | number; stdout?: string };
      if (e.code === 'ENOENT') {
        const notFound = new Error('git not found') as Error & { code: string };
        notFound.code = 'ENOENT';
        throw notFound;
      }
      return { stdout: String(e.stdout || ''), code: typeof e.code === 'number' ? e.code : 1 };
    }
  };
}

function empty(): GitRunResult {
  return { stdout: '', code: 1 };
}

export async function collectGitStatus(cwd: string, opts: CollectGitOpts = {}): Promise<GitStatus | null> {
  const dir = String(cwd || '').trim();
  if (!dir) return null;
  const run = opts.run ?? defaultRunner(opts);
  let inside: GitRunResult;
  try {
    inside = await run(['rev-parse', '--is-inside-work-tree'], dir);
  } catch {
    return null;
  }
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;

  const [porcelain, numstat, symbolic, shortSha, upstream] = await Promise.all([
    run(['status', '--porcelain=v1', '--untracked-files=all'], dir).catch(() => empty()),
    run(['diff', '--numstat', 'HEAD'], dir).catch(() => empty()),
    run(['symbolic-ref', '--short', 'HEAD'], dir).catch(() => empty()),
    run(['rev-parse', '--short', 'HEAD'], dir).catch(() => empty()),
    run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], dir).catch(() => empty()),
  ]);

  const parsed = parseBranch(symbolic.stdout, shortSha.stdout);
  if (!parsed) return null;
  const { insertions, deletions } = parseNumstat(numstat.stdout);
  const aheadBehind = upstream.code === 0 ? parseAheadBehind(upstream.stdout) : null;
  return {
    branch: parsed.branch,
    detached: parsed.detached,
    changedFiles: parsePorcelain(porcelain.stdout),
    insertions,
    deletions,
    ahead: aheadBehind ? aheadBehind.ahead : null,
    behind: aheadBehind ? aheadBehind.behind : null,
  };
}

export function createGitStatusCache(opts: CollectGitOpts = {}): GitStatusCache {
  const cache = new Map<string, GitStatus | null>();
  const inflight = new Map<string, Promise<GitStatus | null>>();

  function compute(id: string, cwd: string): Promise<GitStatus | null> {
    const existing = inflight.get(id);
    if (existing) return existing;
    const job = collectGitStatus(cwd, opts)
      .then((git) => {
        cache.set(id, git);
        return git;
      })
      .catch(() => {
        cache.set(id, null);
        return null;
      })
      .finally(() => {
        if (inflight.get(id) === job) inflight.delete(id);
      });
    inflight.set(id, job);
    return job;
  }

  async function overlay(snap: WorkspacesSnapshot): Promise<WorkspacesSnapshot> {
    const workspaces = await Promise.all(snap.workspaces.map(async (ws) => {
      const git = cache.has(ws.id) ? cache.get(ws.id)! : await compute(ws.id, ws.path);
      if (JSON.stringify(ws.git ?? null) === JSON.stringify(git)) return ws;
      return { ...ws, git };
    }));
    return { workspaces, conversations: snap.conversations };
  }

  return {
    peek(id) {
      return cache.has(id) ? cache.get(id)! : undefined;
    },
    ensure(id, cwd) {
      if (cache.has(id)) return Promise.resolve(cache.get(id)!);
      return compute(id, cwd);
    },
    refresh(id, cwd) {
      return compute(id, cwd);
    },
    overlay,
  };
}
