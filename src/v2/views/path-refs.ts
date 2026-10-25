/** Resolve inline-code text to a file that exists in the workspace. */

import fs from 'node:fs/promises';
import { lexer, walkTokens, type Token } from 'marked';
import { resolveInWorkspace } from '../../core/paths.mjs';
import type { components } from '../contract.gen.ts';

export type PathRef = components['schemas']['PathRef'];

export type PathRefHit = {
  path: string;
  line?: number;
};

export type PathRefTreeEntry = {
  path?: string;
  type?: string;
};

export type ExtractPathRefsOptions = {
  workspacePath?: string;
  exists?: (rel: string) => boolean | Promise<boolean>;
};

const EXT_RE = /\.[A-Za-z0-9]{1,10}$/;
const LINE_HASH_RE = /#L(\d+)$/;
const LINE_COLON_RE = /:(\d+)(?::(\d+))?$/;
const DRIVE_RE = /^[A-Za-z]:/;

function slash(p: unknown): string {
  return String(p ?? '').replaceAll('\\', '/');
}

function hasDrive(p: unknown): boolean {
  return DRIVE_RE.test(slash(p));
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

function ignoreCase(workspacePath: unknown, candidate: unknown): boolean {
  return hasDrive(workspacePath) || hasDrive(candidate);
}

function hasDotDot(rel: unknown): boolean {
  return String(rel || '').split('/').includes('..');
}

function lastSegmentHasExt(rel: unknown): boolean {
  const last = String(rel || '').split('/').pop() || '';
  return EXT_RE.test(last);
}

function withLine(path: string, line: unknown): PathRefHit {
  const out: PathRefHit = { path };
  if (typeof line === 'number' && Number.isFinite(line) && line >= 1) out.line = line;
  return out;
}

/** Split `:12`, `:12:3`, or `#L12` from the end of inline-code text. */
export function parseLineSuffix(text: unknown): { path: string; line: number | undefined; suffix: string } {
  const raw = String(text ?? '');
  let m = raw.match(LINE_HASH_RE);
  if (m && m.index != null) {
    return { path: raw.slice(0, m.index), line: Number(m[1]), suffix: m[0] };
  }
  m = raw.match(LINE_COLON_RE);
  if (m && m.index != null) {
    return { path: raw.slice(0, m.index), line: Number(m[1]), suffix: m[0] };
  }
  return { path: raw, line: undefined, suffix: '' };
}

export function normalizePathCandidate(raw: unknown): string {
  let p = slash(raw);
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** Absolute path inside the workspace → relative; outside → null; already relative → as-is. */
export function toWorkspaceRelative(normalized: string, workspacePath: unknown): string | null {
  if (!isAbsolute(normalized)) return normalized;
  const root = slash(workspacePath).replace(/\/+$/, '');
  if (!root) return null;
  const fold = ignoreCase(workspacePath, normalized);
  const a = fold ? normalized.toLowerCase() : normalized;
  const b = fold ? root.toLowerCase() : root;
  if (a === b) return null;
  if (!a.startsWith(`${b}/`)) return null;
  return normalized.slice(root.length + 1);
}

function treeFilePath(rel: string, tree: PathRefTreeEntry[] | undefined, workspacePath: unknown): string | null {
  const fold = ignoreCase(workspacePath, rel);
  const want = fold ? rel.toLowerCase() : rel;
  for (const ent of tree || []) {
    if (!ent || ent.type === 'dir') continue;
    const p = String(ent.path || '');
    if (!p) continue;
    if ((fold ? p.toLowerCase() : p) === want) return p;
  }
  return null;
}

/**
 * Path-like inline code without checking that the file exists.
 * Same rules as `resolvePathRef`, minus the workspace tree lookup.
 */
export function candidatePathRef(text: unknown, workspacePath = ''): PathRefHit | null {
  const raw = String(text ?? '').trim();
  if (!raw || /\s/.test(raw) || raw.includes('://')) return null;
  const parsed = parseLineSuffix(raw);
  const normalized = normalizePathCandidate(parsed.path);
  if (!normalized || hasDotDot(normalized)) return null;
  const rel = toWorkspaceRelative(normalized, workspacePath);
  if (!rel || hasDotDot(rel)) return null;
  if (!lastSegmentHasExt(rel)) return null;
  return withLine(rel, parsed.line);
}

/**
 * If `text` names a file in `tree`, return `{ path, line? }` using the tree's
 * relative path. Otherwise null.
 */
export function resolvePathRef(
  text: unknown,
  { tree = [], workspacePath = '' }: { tree?: PathRefTreeEntry[]; workspacePath?: string } = {},
): PathRefHit | null {
  const cand = candidatePathRef(text, workspacePath);
  if (!cand) return null;
  const path = treeFilePath(cand.path, tree, workspacePath);
  if (!path) return null;
  return withLine(path, cand.line);
}

function collectCodespans(markdown: string): string[] {
  const tokens = lexer(markdown);
  const out: string[] = [];
  walkTokens(tokens, (token: Token) => {
    if (token.type === 'codespan') out.push(String(token.text ?? ''));
  });
  return out;
}

async function fileExistsInWorkspace(workspacePath: string, rel: string): Promise<boolean> {
  if (!workspacePath || typeof rel !== 'string' || !rel) return false;
  try {
    const resolved = await resolveInWorkspace(workspacePath, rel);
    const st = await fs.stat(resolved);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Inline-code spans whose text names a real file in the workspace.
 * Skips fenced and indented code blocks. Dedupes by `text`, first occurrence wins.
 */
export async function extractPathRefs(
  markdown: unknown,
  { workspacePath = '', exists }: ExtractPathRefsOptions = {},
): Promise<PathRef[]> {
  const check = exists ?? ((rel: string) => fileExistsInWorkspace(workspacePath, rel));
  const seen = new Set<string>();
  const out: PathRef[] = [];
  for (const text of collectCodespans(String(markdown ?? ''))) {
    if (seen.has(text)) continue;
    const cand = candidatePathRef(text, workspacePath);
    if (!cand) continue;
    if (!await Promise.resolve(check(cand.path))) continue;
    seen.add(text);
    const item: PathRef = { text, path: cand.path };
    if (cand.line != null) item.line = cand.line;
    out.push(item);
  }
  return out;
}
