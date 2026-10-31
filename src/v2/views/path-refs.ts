/** Resolve inline-code text and Markdown link hrefs to files in the workspace. */

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
const LINE_HASH_RANGE_RE = /#L(\d+)(?:-L?\d+)?$/;
const LINE_COLON_RE = /:(\d+)(?::(\d+))?$/;
const DRIVE_RE = /^[A-Za-z]:/;
const DRIVE_PREFIX_RE = /^[A-Za-z]:[\\/]/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** fileURLToPath on a non-Windows host leaves a leading slash: `/C:/...`. */
const POSIX_FILE_DRIVE_RE = /^\/([A-Za-z]:\/.*)$/;

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

/** `#L12`, `#L12-L20`, or `#L12-20` → the start line. Anything else is not a line fragment. */
function lineFromHash(hash: string): number | undefined {
  const m = /^#L(\d+)(?:-L?\d+)?$/.exec(hash);
  if (!m) return undefined;
  const line = Number(m[1]);
  return line >= 1 ? line : undefined;
}

/**
 * Split `#L12`, `#L12-L20`, `#L12-20`, `:12`, or `:12:3` off a link href
 * or a decoded file path. Inline code keeps using `parseLineSuffix`.
 */
function parseLinkLocation(raw: string): { path: string; line: number | undefined } {
  let m = raw.match(LINE_HASH_RANGE_RE);
  if (m && m.index != null) {
    return { path: raw.slice(0, m.index), line: Number(m[1]) };
  }
  m = raw.match(LINE_COLON_RE);
  if (m && m.index != null) {
    return { path: raw.slice(0, m.index), line: Number(m[1]) };
  }
  return { path: raw, line: undefined };
}

function isOtherScheme(href: string): boolean {
  // `README.md:3` matches a scheme grammar (`README.md:`). Peel a trailing
  // line suffix first so only real schemes (http, mailto, …) are ignored.
  const peeled = href.replace(LINE_COLON_RE, '');
  if (DRIVE_PREFIX_RE.test(href) || DRIVE_PREFIX_RE.test(peeled)) return false;
  return SCHEME_RE.test(peeled);
}

/**
 * `file://` href → filesystem path with the fragment removed.
 * Percent-decoding follows `fileURLToPath` (`%20`, UTF-8 sequences).
 * `file:///C:/...` becomes `C:/...` on every host.
 */
function decodeFileHref(href: string): { path: string; line: number | undefined } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') return null;
  const pathUrl = new URL(url.href);
  pathUrl.hash = '';
  let fsPath: string;
  try {
    fsPath = slash(fileURLToPath(pathUrl));
  } catch {
    return null;
  }
  const drive = POSIX_FILE_DRIVE_RE.exec(fsPath);
  if (drive) fsPath = drive[1];
  const parsed = parseLinkLocation(fsPath);
  return { path: parsed.path, line: lineFromHash(url.hash) ?? parsed.line };
}

function locatedPathRef(pathText: string, line: number | undefined, workspacePath: string): PathRefHit | null {
  const normalized = normalizePathCandidate(pathText);
  if (!normalized || hasDotDot(normalized)) return null;
  const rel = toWorkspaceRelative(normalized, workspacePath);
  if (!rel || hasDotDot(rel)) return null;
  if (!lastSegmentHasExt(rel)) return null;
  return withLine(rel, line);
}

/**
 * Link href that names a workspace file, without checking that the file exists.
 * `text` stored by the caller is the href unchanged. `http`, `https`, `mailto`,
 * and any other non-file scheme are ignored.
 */
function candidateLinkPathRef(href: string, workspacePath: string): PathRefHit | null {
  const raw = href.trim();
  if (!raw) return null;
  if (/^file:/i.test(raw)) {
    const decoded = decodeFileHref(raw);
    if (!decoded) return null;
    return locatedPathRef(decoded.path, decoded.line, workspacePath);
  }
  if (isOtherScheme(raw) || /\s/.test(raw)) return null;
  const parsed = parseLinkLocation(raw);
  return locatedPathRef(parsed.path, parsed.line, workspacePath);
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

type PathText = { kind: 'code' | 'link'; text: string };

function collectPathTexts(markdown: string): PathText[] {
  const tokens = lexer(markdown);
  const out: PathText[] = [];
  walkTokens(tokens, (token: Token) => {
    if (token.type === 'codespan') {
      out.push({ kind: 'code', text: String(token.text ?? '') });
    } else if (token.type === 'link' && token.href) {
      out.push({ kind: 'link', text: token.href });
    }
  });
  return out;
}

export async function fileExistsInWorkspace(workspacePath: string, rel: string): Promise<boolean> {
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
 * Inline-code spans and Markdown link hrefs that name a real file in the workspace.
 * A link's `text` is the href as marked parsed it, with no rewriting.
 * Codespan rules are unchanged. Skips fenced and indented code blocks.
 * Dedupes by `text`, first occurrence wins.
 */
export async function extractPathRefs(
  markdown: unknown,
  { workspacePath = '', exists }: ExtractPathRefsOptions = {},
): Promise<PathRef[]> {
  const check = exists ?? ((rel: string) => fileExistsInWorkspace(workspacePath, rel));
  const seen = new Set<string>();
  const out: PathRef[] = [];
  for (const hit of collectPathTexts(String(markdown ?? ''))) {
    if (seen.has(hit.text)) continue;
    const cand = hit.kind === 'link'
      ? candidateLinkPathRef(hit.text, workspacePath)
      : candidatePathRef(hit.text, workspacePath);
    if (!cand) continue;
    if (!await Promise.resolve(check(cand.path))) continue;
    seen.add(hit.text);
    const item: PathRef = { text: hit.text, path: cand.path };
    if (cand.line != null) item.line = cand.line;
    out.push(item);
  }
  return out;
}
