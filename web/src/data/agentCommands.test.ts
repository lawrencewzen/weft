import { describe, expect, it } from 'vitest';
import { agentCommands } from './agentCommands';
import {
  conversationTopic,
  createEntityStore,
  subagentTopic,
  type EntityRef,
  type Subagent,
  type ThreadItem,
  type ToolCall,
} from './store';

const CID = 'c1';
const TOPIC = conversationTopic(CID);
const AGENT_ID = 'c1:sub:1';
const CHILD_TOPIC = subagentTopic(CID, AGENT_ID);

function bash(id: string, extra?: Partial<ToolCall>): ToolCall {
  return {
    id,
    groupId: 'g1',
    kind: 'bash',
    status: 'done',
    heading: { title: 'npm test', detail: '', fromIntent: false },
    hint: { text: '', failed: false },
    failure: 'none',
    diff: null,
    exitCode: 0,
    output: { preview: 'ok', truncated: false, totalLines: 1 },
    ...extra,
  };
}

function group(id: string, toolIds: string[]): ThreadItem {
  return {
    kind: 'tool_group',
    id,
    toolIds,
    summary: { text: 'ran', failed: 0, running: false },
    live: false,
  };
}

function agent(): Subagent {
  return {
    id: AGENT_ID,
    parentConversationId: CID,
    title: '巡查',
    name: '巡查',
    mode: 'background',
    status: 'running',
    startedAt: 1,
    lastActivityAt: 1,
    endedAt: null,
    currentAction: null,
    progress: { step: 1, total: 1 },
    toolCallId: null,
  };
}

describe('agentCommands', () => {
  it('lists main-agent bash first, then each sub-agent, and skips non-bash', () => {
    const store = createEntityStore();
    store.applySnapshot({
      protocolVersion: '2.0.0',
      topics: [TOPIC, CHILD_TOPIC],
      entities: [
        {
          topic: TOPIC,
          entity: 'item',
          id: 'g1',
          value: group('g1', ['b1', 'r1']) as EntityRef['value'],
        },
        {
          topic: TOPIC,
          entity: 'tool',
          id: 'b1',
          value: bash('b1', { status: 'running' }) as EntityRef['value'],
        },
        {
          topic: TOPIC,
          entity: 'tool',
          id: 'r1',
          value: { ...bash('r1'), kind: 'read', heading: { title: 'a.ts', detail: '', fromIntent: false } } as EntityRef['value'],
        },
        {
          topic: TOPIC,
          entity: 'subagent',
          id: AGENT_ID,
          value: agent() as EntityRef['value'],
        },
        {
          topic: CHILD_TOPIC,
          entity: 'tool',
          id: 'b2',
          value: bash('b2', {
            heading: { title: 'git status', detail: '', fromIntent: false },
            status: 'done',
            exitCode: 0,
          }) as EntityRef['value'],
        },
      ],
    });
    const rows = agentCommands(store, CID, store.subagents(CID));
    expect(rows.map((row) => row.toolId)).toEqual(['b1', 'b2']);
    expect(rows[0]).toMatchObject({
      ownerKind: 'main',
      running: true,
      title: 'npm test',
    });
    expect(rows[1]).toMatchObject({
      ownerKind: 'subagent',
      ownerName: '巡查',
      running: false,
      title: 'git status',
    });
  });
});
