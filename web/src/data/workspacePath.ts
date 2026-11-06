const ELLIPSIS = '…';

export const WORKSPACE_PATH_MAX = 32;

export type ShortenWorkspacePathOpts = {
  home?: string | null;
  max?: number;
};

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.includes('\\');
}

function sepOf(path: string): '\\' | '/' {
  return isWindowsPath(path) ? '\\' : '/';
}

function trimTrailingSep(path: string, sep: string): string {
  if (path.length <= 1) return path;
  let end = path.length;
  while (end > 1 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1;
  return path.slice(0, end).replaceAll('/', sep).replaceAll('\\', sep);
}

function startsWithPath(path: string, prefix: string, ignoreCase: boolean): boolean {
  if (path.length < prefix.length) return false;
  const head = path.slice(0, prefix.length);
  if (ignoreCase ? head.toLowerCase() !== prefix.toLowerCase() : head !== prefix) return false;
  return path.length === prefix.length || path[prefix.length] === '/' || path[prefix.length] === '\\';
}

function inferredHome(path: string): string | null {
  const posix = path.match(/^\/Users\/[^/]+/);
  if (posix) return posix[0];
  const win = path.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i);
  return win ? win[0] : null;
}

function lastSegment(path: string, sep: string): string {
  const trimmed = trimTrailingSep(path, sep);
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return slash < 0 ? trimmed : trimmed.slice(slash + 1);
}

function clipTail(name: string, budget: number): string {
  if (name.length <= budget) return name;
  if (budget <= 1) return ELLIPSIS.slice(0, Math.max(0, budget));
  return `${ELLIPSIS}${name.slice(-(budget - 1))}`;
}

export function shortenWorkspacePath(raw: string, opts: ShortenWorkspacePathOpts = {}): string {
  const input = String(raw || '');
  if (!input) return '';
  const max = opts.max ?? WORKSPACE_PATH_MAX;
  const sep = sepOf(input);
  const path = input.replaceAll('/', sep).replaceAll('\\', sep);
  const ignoreCase = sep === '\\';

  let home = opts.home ? trimTrailingSep(opts.home, sep) : null;
  if (!home) {
    const inferred = inferredHome(path);
    if (inferred) home = trimTrailingSep(inferred, sep);
  }

  let display = path;
  if (home && startsWithPath(path, home, ignoreCase)) {
    const rest = path.slice(home.length);
    display = rest === '' || rest === sep ? '~' : `~${rest}`;
  }

  if (display.length <= max) return display;

  const last = lastSegment(display, sep) || display;
  let prefix: string;
  if (display.startsWith('~')) {
    prefix = `~${sep}${ELLIPSIS}${sep}`;
  } else if (sep === '/' && display.startsWith('/')) {
    const first = display.slice(1).split('/')[0] || '';
    prefix = first ? `/${first}/${ELLIPSIS}/` : `/${ELLIPSIS}/`;
  } else if (/^[A-Za-z]:\\/.test(display)) {
    const first = display.slice(3).split('\\')[0] || '';
    prefix = first ? `${display.slice(0, 2)}\\${first}\\${ELLIPSIS}\\` : `${display.slice(0, 2)}\\${ELLIPSIS}\\`;
  } else {
    const first = display.split(sep)[0] || '';
    prefix = first ? `${first}${sep}${ELLIPSIS}${sep}` : `${ELLIPSIS}${sep}`;
  }

  if (prefix.length >= max) return `${display.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`;
  return prefix + clipTail(last, max - prefix.length);
}

export type Breadcrumb = {
  name: string;
  path: string;
};

export type SplitBreadcrumbsOpts = {
  thisPc?: string;
  parent?: string | null;
};

export function splitBreadcrumbs(raw: string, opts: SplitBreadcrumbsOpts = {}): Breadcrumb[] {
  const input = String(raw || '').trim();
  if (!input) {
    if (opts.thisPc) {
      return [{ name: opts.thisPc, path: '' }];
    }
    return [];
  }

  if (input.startsWith('~')) {
    const isWin = input.includes('\\');
    const sep = isWin ? '\\' : '/';
    const parts = input.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
    const crumbs: Breadcrumb[] = [];
    let curr = '';
    for (let i = 0; i < parts.length; i++) {
      curr = i === 0 ? parts[i] : `${curr}${sep}${parts[i]}`;
      crumbs.push({ name: parts[i], path: curr });
    }
    if (opts.thisPc && opts.parent === '') {
      crumbs.unshift({ name: opts.thisPc, path: '' });
    }
    return crumbs;
  }

  const isWin = /^[A-Za-z]:[\\/]/.test(input) || /^[A-Za-z]:$/.test(input);
  if (isWin) {
    const driveLetter = input.slice(0, 2);
    const rest = input.slice(2).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    const driveRoot = `${driveLetter}\\`;
    const crumbs: Breadcrumb[] = [];
    if (opts.thisPc) {
      crumbs.push({ name: opts.thisPc, path: '' });
    }
    crumbs.push({ name: driveRoot, path: driveRoot });
    if (!rest) return crumbs;
    const parts = rest.split(/[\\/]+/).filter(Boolean);
    let curr = driveRoot;
    for (let i = 0; i < parts.length; i++) {
      curr = i === 0 ? `${driveLetter}\\${parts[i]}` : `${curr}\\${parts[i]}`;
      crumbs.push({ name: parts[i], path: curr });
    }
    return crumbs;
  }

  // POSIX
  const clean = input.replace(/\/+$/, '');
  if (!clean || clean === '/') {
    const crumbs: Breadcrumb[] = [{ name: '/', path: '/' }];
    if (opts.thisPc && opts.parent === '') {
      crumbs.unshift({ name: opts.thisPc, path: '' });
    }
    return crumbs;
  }
  const parts = clean.split('/').filter(Boolean);
  const crumbs: Breadcrumb[] = [{ name: '/', path: '/' }];
  let curr = '';
  for (const part of parts) {
    curr = `${curr}/${part}`;
    crumbs.push({ name: part, path: curr });
  }
  if (opts.thisPc && opts.parent === '') {
    crumbs.unshift({ name: opts.thisPc, path: '' });
  }
  return crumbs;
}

