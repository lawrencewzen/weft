const MAX_RECENT_FILES = 8;
const recentFilesByWorkspace = new Map<string, string[]>();

export function recordRecentFile(workspaceId: string, filePath: string): void {
  if (!workspaceId || !filePath) return;
  const current = recentFilesByWorkspace.get(workspaceId) ?? [];
  const next = [filePath, ...current.filter((p) => p !== filePath)].slice(0, MAX_RECENT_FILES);
  recentFilesByWorkspace.set(workspaceId, next);
}

export function getRecentFiles(workspaceId: string): string[] {
  if (!workspaceId) return [];
  return recentFilesByWorkspace.get(workspaceId) ?? [];
}

export function clearRecentFiles(): void {
  recentFilesByWorkspace.clear();
}
