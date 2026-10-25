export type AppRoute =
  | { name: 'home' }
  | { name: 'conversation'; id: string }
  | { name: 'subagent'; conversationId: string; agentId: string }
  | { name: 'draft'; workspaceId: string };

function decodePart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseRoute(pathname: string): AppRoute {
  const raw = String(pathname || '');
  const stripped = raw.replace(/^\/next(?=\/|$)/, '') || '/';
  const trimmed = stripped.replace(/\/+$/, '') || '/';
  const sub = /^\/c\/([^/]+)\/a\/([^/]+)$/.exec(trimmed);
  if (sub) {
    return { name: 'subagent', conversationId: decodePart(sub[1]), agentId: decodePart(sub[2]) };
  }
  const conv = /^\/c\/([^/]+)$/.exec(trimmed);
  if (conv) {
    return { name: 'conversation', id: decodePart(conv[1]) };
  }
  const draft = /^\/w\/([^/]+)\/new$/.exec(trimmed);
  if (draft) {
    return { name: 'draft', workspaceId: decodePart(draft[1]) };
  }
  return { name: 'home' };
}
