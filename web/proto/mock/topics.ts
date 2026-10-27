import type { Entity, TopicReader } from './hub';
import { conversationEntities, extensionsEntities, providersEntities, workspacesEntities } from './views';
import { subagentEntities, subagentKey } from './subagents';
import type { Lang, MockDb } from './types';

const CONVERSATION_PREFIX = 'conversation:';
const SUBAGENT_PREFIX = 'subagent:';

function subagentTopicOf(topic: string): { cid: string; agentId: string } | null {
  if (!topic.startsWith(SUBAGENT_PREFIX)) return null;
  const rest = topic.slice(SUBAGENT_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const cid = rest.slice(0, colon);
  const agentId = rest.slice(colon + 1);
  if (!cid || !agentId) return null;
  return { cid, agentId };
}

export function readTopic(db: MockDb): TopicReader {
  return (topic: string, _lang: Lang): Entity[] | null => {
    if (topic === 'workspaces') return workspacesEntities(db);
    if (topic === 'providers') return providersEntities(db);
    if (topic === 'extensions') return extensionsEntities(db);
    if (topic.startsWith(CONVERSATION_PREFIX)) {
      const cid = topic.slice(CONVERSATION_PREFIX.length);
      const conv = db.conversations.get(cid);
      return conv ? conversationEntities(conv) : null;
    }
    const sub = subagentTopicOf(topic);
    if (sub) {
      const thread = db.subagents.get(subagentKey(sub.cid, sub.agentId));
      if (!thread || !db.conversations.has(sub.cid)) return null;
      return subagentEntities(thread);
    }
    return null;
  };
}
