import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'path';
import { compileSchema } from '../../src/v2/validate.ts';
import {
  buildWorkspacesSnapshot,
  conversationSummaryView,
  workspaceView,
} from '../../src/v2/views/sidebar.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateSummary = compileSchema(structuredClone(spec.components.schemas.ConversationSummary));
const validateWorkspace = compileSchema(structuredClone(spec.components.schemas.Workspace));
const validateSnap = compileSchema(structuredClone(spec.components.schemas.WorkspacesSnapshot));

function assertSummary(view, label) {
  assert.equal(validateSummary(view), true, `${label}: ${JSON.stringify(validateSummary.errors)}`);
}

function assertWorkspace(view, label) {
  assert.equal(validateWorkspace(view), true, `${label}: ${JSON.stringify(validateWorkspace.errors)}`);
}

test('conversationSummaryView normalizes status like conversationStatus', () => {
  const cases = [
    ['idle', 'idle'],
    ['done', 'idle'],
    ['running', 'running'],
    ['recovering', 'running'],
    ['resuming', 'running'],
    ['paused', 'waiting'],
    ['waiting', 'waiting'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['stopped', 'idle'],
    ['', 'idle'],
  ];
  for (const [raw, status] of cases) {
    const view = conversationSummaryView({
      conv: { id: 'c1', workspaceId: 'w1', title: 't', updatedAt: 1 },
      status: raw,
    });
    assertSummary(view, raw);
    assert.equal(view.status, status, raw);
  }
});

test('runningAgents counts the main agent plus live sub-agents', () => {
  const idle = conversationSummaryView({
    conv: { id: 'c1', workspaceId: 'w1', title: 't', updatedAt: 1 },
    status: 'idle',
    digest: { total: 2, live: 2 },
  });
  assertSummary(idle, 'idle-live');
  assert.equal(idle.runningAgents, 2);
  assert.deepEqual(idle.subagents, { total: 2, live: 2 });

  const running = conversationSummaryView({
    conv: { id: 'c1', workspaceId: 'w1', title: 't', updatedAt: 1 },
    status: 'running',
    digest: { total: 2, live: 1 },
  });
  assertSummary(running, 'running-live');
  assert.equal(running.runningAgents, 2);
  assert.deepEqual(running.subagents, { total: 2, live: 1 });

  const solo = conversationSummaryView({
    conv: { id: 'c1', workspaceId: 'w1', title: 't', updatedAt: 1 },
    status: 'running',
  });
  assertSummary(solo, 'running-solo');
  assert.equal(solo.runningAgents, 1);
  assert.equal(solo.subagents, null);
});

test('subagents is null when total is 0', () => {
  const view = conversationSummaryView({
    conv: { id: 'c1', workspaceId: 'w1', title: 't', updatedAt: 1, archived: true },
    status: 'idle',
    digest: { total: 0, live: 0 },
  });
  assertSummary(view, 'no-subs');
  assert.equal(view.subagents, null);
  assert.equal(view.archived, true);
});

test('workspaceView counts conversations and running rows', () => {
  const conversations = [
    conversationSummaryView({ conv: { id: 'a', workspaceId: 'w', title: 'a', updatedAt: 2 }, status: 'running' }),
    conversationSummaryView({ conv: { id: 'b', workspaceId: 'w', title: 'b', updatedAt: 1 }, status: 'recovering' }),
    conversationSummaryView({ conv: { id: 'c', workspaceId: 'w', title: 'c', updatedAt: 0 }, status: 'idle' }),
  ];
  const ws = workspaceView({
    workspace: { id: 'w', name: 'n', path: '/p', source: 'git' },
    conversations,
  });
  assertWorkspace(ws, 'git');
  assert.equal(ws.source, 'git');
  assert.equal(ws.conversationCount, 3);
  assert.equal(ws.runningCount, 2);
  const local = workspaceView({
    workspace: { id: 'w', name: 'n', path: '/p' },
    conversations: [],
  });
  assertWorkspace(local, 'local');
  assert.equal(local.source, 'local');
  assert.equal(local.conversationCount, 0);
  assert.equal(local.runningCount, 0);
});

test('buildWorkspacesSnapshot sorts each workspace by updatedAt desc and skips present', async () => {
  let presentCalls = 0;
  const loader = {
    present: async () => {
      presentCalls += 1;
      throw new Error('present must not be called');
    },
    listWorkspaces: async () => [
      { id: 'w1', name: 'one', path: '/one', source: 'local' },
      { id: 'w2', name: 'two', path: '/two', source: 'git' },
    ],
    listConversations: async (wid) => {
      if (wid === 'w1') {
        return Array.from({ length: 30 }, (_, i) => ({
          id: `c${i}`,
          workspaceId: 'w1',
          title: `t${i}`,
          updatedAt: 1000 + i,
        }));
      }
      return [
        { id: 'x', workspaceId: 'w2', title: 'x', updatedAt: 9 },
        { id: 'y', workspaceId: 'w2', title: 'y', updatedAt: 11 },
      ];
    },
    statusOf: async (conv) => (conv.id === 'c29' || conv.id === 'y' ? 'running' : 'idle'),
    subagentDigests: async (convs) => new Map(convs.map((conv) => [conv.id, { total: 0, live: 0 }])),
  };
  const snap = await buildWorkspacesSnapshot(loader);
  assert.equal(validateSnap(snap), true, JSON.stringify(validateSnap.errors));
  assert.equal(presentCalls, 0);
  assert.equal(snap.workspaces.length, 2);
  assert.equal(snap.workspaces[0].conversationCount, 30);
  assert.equal(snap.workspaces[0].runningCount, 1);
  assert.equal(snap.workspaces[1].conversationCount, 2);
  assert.equal(snap.workspaces[1].runningCount, 1);
  const w1 = snap.conversations.filter((row) => row.workspaceId === 'w1');
  assert.equal(w1.length, 30);
  assert.deepEqual(w1.map((row) => row.id), Array.from({ length: 30 }, (_, i) => `c${29 - i}`));
  const w2 = snap.conversations.filter((row) => row.workspaceId === 'w2');
  assert.deepEqual(w2.map((row) => row.id), ['y', 'x']);
});
