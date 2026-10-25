export type AppRoute =
  | { name: 'home' }
  | { name: 'conversation'; id: string };

export function parseRoute(pathname: string): AppRoute {
  const raw = String(pathname || '');
  const stripped = raw.replace(/^\/next(?=\/|$)/, '') || '/';
  const trimmed = stripped.replace(/\/+$/, '') || '/';
  const match = /^\/c\/([^/]+)$/.exec(trimmed);
  if (match) {
    try {
      return { name: 'conversation', id: decodeURIComponent(match[1]) };
    } catch {
      return { name: 'conversation', id: match[1] };
    }
  }
  return { name: 'home' };
}
