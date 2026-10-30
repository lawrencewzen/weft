import type { ConversationSummary, Workspace } from './store';
import type { WorkspaceGroup } from './sidebarModel';

export interface SearchItem {
  conv: ConversationSummary;
  workspace: Workspace;
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent || navigator.platform || '');
}

export function filterSearchConversations(
  groups: WorkspaceGroup[],
  query: string,
  extra: SearchItem[] = [],
): SearchItem[] {
  const all: SearchItem[] = [...extra];
  for (const group of groups) {
    for (const conv of group.conversations) {
      if (conv.archived) continue;
      all.push({
        conv,
        workspace: group.workspace,
      });
    }
  }

  // Sort descending by updatedAt
  all.sort((a, b) => (Number(b.conv.updatedAt) || 0) - (Number(a.conv.updatedAt) || 0));

  const q = query.trim().toLowerCase();
  if (!q) return all;

  return all.filter((item) => (item.conv.title || '').toLowerCase().includes(q));
}
