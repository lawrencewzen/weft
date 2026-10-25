export function conversationPath(id: string): string {
  return `/next/c/${encodeURIComponent(id)}`;
}

export function subagentPath(cid: string, agentId: string): string {
  return `/next/c/${encodeURIComponent(cid)}/a/${encodeURIComponent(agentId)}`;
}

export function draftPath(workspaceId: string): string {
  return `/next/w/${encodeURIComponent(workspaceId)}/new`;
}

export function homePath(): string {
  return '/next/';
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const url = path.startsWith('/next') ? path : `/next${path.startsWith('/') ? path : `/${path}`}`;
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
