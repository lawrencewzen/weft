export type FileNodeLike = {
  path: string;
  type: 'file' | 'dir';
};

export type TreeRow = {
  path: string;
  name: string;
  type: 'file' | 'dir';
  depth: number;
  expanded?: boolean;
};

function posix(path: string): string {
  return String(path || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function nameOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function dirPaths(entries: readonly FileNodeLike[]): string[] {
  const dirs = new Set<string>();
  for (const ent of entries) {
    const path = posix(ent.path);
    if (!path) continue;
    if (ent.type === 'dir') dirs.add(path);
    const parts = path.split('/');
    const last = ent.type === 'dir' ? parts.length : parts.length - 1;
    for (let i = 1; i <= last; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs];
}

/** Default: every directory is expanded so the tree matches the old flat listing. */
export function defaultExpanded(entries: readonly FileNodeLike[]): Set<string> {
  return new Set(dirPaths(entries));
}

export function expandAncestors(expanded: Set<string>, filePath: string): Set<string> {
  const next = new Set(expanded);
  const parts = posix(filePath).split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) next.add(parts.slice(0, i).join('/'));
  return next;
}

export function toggleDir(expanded: Set<string>, dirPath: string): Set<string> {
  const next = new Set(expanded);
  const path = posix(dirPath);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

export function visibleTreeRows(entries: readonly FileNodeLike[], expanded: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const ent of entries) {
    const path = posix(ent.path);
    if (!path) continue;
    const parts = path.split('/');
    let hidden = false;
    for (let i = 1; i < parts.length; i += 1) {
      if (!expanded.has(parts.slice(0, i).join('/'))) {
        hidden = true;
        break;
      }
    }
    if (hidden) continue;
    rows.push({
      path,
      name: nameOf(path),
      type: ent.type,
      depth: parts.length - 1,
      expanded: ent.type === 'dir' ? expanded.has(path) : undefined,
    });
  }
  return rows;
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.md$/i.test(posix(filePath));
}
