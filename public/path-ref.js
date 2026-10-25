/** Resolve inline-code text to a file that exists in the workspace tree. */

const EXT_RE = /\.[A-Za-z0-9]{1,10}$/;
const LINE_HASH_RE = /#L(\d+)$/;
const LINE_COLON_RE = /:(\d+)(?::(\d+))?$/;
const DRIVE_RE = /^[A-Za-z]:/;

function slash(p) {
  return String(p ?? '').replaceAll('\\', '/');
}

function hasDrive(p) {
  return DRIVE_RE.test(slash(p));
}

function isAbsolute(p) {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}

function ignoreCase(workspacePath, candidate) {
  return hasDrive(workspacePath) || hasDrive(candidate);
}

function hasDotDot(rel) {
  return String(rel || '').split('/').includes('..');
}

function lastSegmentHasExt(rel) {
  const last = String(rel || '').split('/').pop() || '';
  return EXT_RE.test(last);
}

/** Split `:12`, `:12:3`, or `#L12` from the end of inline-code text. */
export function parseLineSuffix(text) {
  const raw = String(text ?? '');
  let m = raw.match(LINE_HASH_RE);
  if (m) {
    return { path: raw.slice(0, m.index), line: Number(m[1]), suffix: m[0] };
  }
  m = raw.match(LINE_COLON_RE);
  if (m) {
    return { path: raw.slice(0, m.index), line: Number(m[1]), suffix: m[0] };
  }
  return { path: raw, line: undefined, suffix: '' };
}

export function normalizePathCandidate(raw) {
  let p = slash(raw);
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** Absolute path inside the workspace → relative; outside → null; already relative → as-is. */
export function toWorkspaceRelative(normalized, workspacePath) {
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

function treeFilePath(rel, tree, workspacePath) {
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
 * If `text` names a file in `tree`, return `{ path, line? }` using the tree's
 * relative path. Otherwise null. Used both when rendering chips and when
 * handling a click (including forged data-path attributes).
 */
export function resolvePathRef(text, { tree = [], workspacePath = '' } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw || /\s/.test(raw) || raw.includes('://')) return null;
  const parsed = parseLineSuffix(raw);
  const normalized = normalizePathCandidate(parsed.path);
  if (!normalized || hasDotDot(normalized)) return null;
  const rel = toWorkspaceRelative(normalized, workspacePath);
  if (!rel || hasDotDot(rel)) return null;
  if (!lastSegmentHasExt(rel)) return null;
  const path = treeFilePath(rel, tree, workspacePath);
  if (!path) return null;
  const out = { path };
  if (Number.isFinite(parsed.line) && parsed.line >= 1) out.line = parsed.line;
  return out;
}
