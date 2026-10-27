import type { Entity, TopicReader } from './hub';
import { conversationEntities, extensionsEntities, providersEntities, workspacesEntities } from './views';
import type { Lang, MockDb } from './types';

const CONVERSATION_PREFIX = 'conversation:';

export function readTopic(db: MockDb): TopicReader {
  return (topic: string, _lang: Lang): Entity[] | null => {
    if (topic === 'workspaces') return workspacesEntities(db);
    if (topic === 'providers') return providersEntities(db);
    if (topic === 'extensions') return extensionsEntities();
    if (topic.startsWith(CONVERSATION_PREFIX)) {
      const cid = topic.slice(CONVERSATION_PREFIX.length);
      const conv = db.conversations.get(cid);
      return conv ? conversationEntities(conv) : null;
    }
    return null;
  };
}
