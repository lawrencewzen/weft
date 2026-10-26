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
