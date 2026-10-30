import { useMemo } from 'react';
import { useSession } from './session';
import {
  archivedConversations,
  chatConversations,
  groupWorkspaces,
  latestConversation,
  type WorkspaceGroup,
} from './sidebarModel';
import { WORKSPACES_TOPIC, type ConversationSummary, type Workspace } from './store';
import { useStoreTopic } from './useStoreTopic';

export type WorkspacesState = {
  workspaces: Workspace[];
  conversations: ConversationSummary[];
  groups: WorkspaceGroup[];
  chats: ConversationSummary[];
  archived: ConversationSummary[];
  latest: ConversationSummary | undefined;
  ready: boolean;
  status: ReturnType<typeof useSession>['status'];
};

export function useWorkspaces(): WorkspacesState {
  const { store, status } = useSession();
  useStoreTopic(store, WORKSPACES_TOPIC);
  const workspaces = store.workspaces();
  const conversations = store.conversationSummaries();
  const ready = store.hasTopic(WORKSPACES_TOPIC);
  const groups = useMemo(
    () => groupWorkspaces(workspaces, conversations),
    [workspaces, conversations],
  );
  const chats = useMemo(
    () => chatConversations(workspaces, conversations),
    [workspaces, conversations],
  );
  const archived = useMemo(
    () => archivedConversations(conversations),
    [conversations],
  );
  const latest = useMemo(() => latestConversation(conversations), [conversations]);
  return { workspaces, conversations, groups, chats, archived, latest, ready, status };
}
