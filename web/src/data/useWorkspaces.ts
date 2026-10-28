import { useMemo, useSyncExternalStore } from 'react';
import { useSession } from './session';
import {
  archivedConversations,
  groupWorkspaces,
  latestConversation,
  type WorkspaceGroup,
} from './sidebarModel';
import { WORKSPACES_TOPIC, type ConversationSummary, type Workspace } from './store';

export type WorkspacesState = {
  workspaces: Workspace[];
  conversations: ConversationSummary[];
  groups: WorkspaceGroup[];
  archived: ConversationSummary[];
  latest: ConversationSummary | undefined;
  ready: boolean;
  status: ReturnType<typeof useSession>['status'];
};

export function useWorkspaces(): WorkspacesState {
  const { store, status } = useSession();
  useSyncExternalStore(store.subscribe, store.getVersion);
  const workspaces = store.workspaces();
  const conversations = store.conversationSummaries();
  const ready = store.hasTopic(WORKSPACES_TOPIC);
  const groups = useMemo(
    () => groupWorkspaces(workspaces, conversations),
    [workspaces, conversations],
  );
  const archived = useMemo(
    () => archivedConversations(conversations),
    [conversations],
  );
  const latest = useMemo(() => latestConversation(conversations), [conversations]);
  return { workspaces, conversations, groups, archived, latest, ready, status };
}
