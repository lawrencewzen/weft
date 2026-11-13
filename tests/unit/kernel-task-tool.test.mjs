import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { SKILL_TOOL_DESCRIPTION } from '../../src/kernel/skill-tool.mjs';
import { CHILD_HIDDEN_TOOLS, SUBAGENT_INSTRUCTIONS } from '../../src/kernel/subagents.mjs';
import {
  createTaskExtension,
  TASK_DESCRIPTION,
  TASK_TOOL_NAME,
  taskIdFromDescription,
  TasksDoc,
} from '../../src/kernel/task-tool.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { killChild, request as serverRequest, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-task-tool-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

function killed(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null || proc.signalCode != null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode, out: '' });
      return;
    }
    let out = '';
    const take = (buf) => { out += buf; };
    proc.stdout?.on('data', take);
    proc.stderr?.on('data', take);
    proc.once('exit', (code, signal) => resolve({ code, signal, out }));
    killChild(proc);
  });
}

async function waitForFile(file, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForKernel(fn, { attempts = 150, intervalMs = 50 } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (last?.ok) return last.value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for kernel state: ${JSON.stringify(last?.debug ?? null)}`);
}

async function waitForHttp(base, cid, ready, attempts = 100) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return body;
}

function assistantTexts(body) {
  return (body?.messages || [])
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text || '');
}

function toolMessages(body) {
  return (body?.messages || []).filter((message) => message.role === 'tool');
}

function toolTexts(body) {
  return toolMessages(body).map((message) => message.text || message.tool?.output || '');
}

function subagentsOf(body) {
  return (body?.agents || []).filter((agent) => String(agent.id || '').includes(':sub:'));
}

function childHarnessId(agent) {
  const id = String(agent?.id || '');
  const marker = ':sub:';
  const at = id.lastIndexOf(marker);
  return at >= 0 ? Number(id.slice(at + marker.length)) : NaN;
}

function sectionText(snapshot, key) {
  return snapshot?.sections?.find((section) => section.key === key)?.value || '';
}

function sectionInner(snapshot, key) {
  return String(sectionText(snapshot, key) || '').replace(new RegExp(`</?${key}>`, 'gi'), '').trim();
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

async function openTestKernel(turns, extraEnv = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ktask-'));
  const wsPath = path.join(dataDir, 'ws');
  await mkdir(wsPath, { recursive: true });
  const script = await writeScript(dataDir, 'script.json', turns);
  const store = createSqliteStore(dataDir);
  const ws = await store.createWorkspace({ name: 'ws', path: wsPath });
  const kernel = await openConversationKernel({
    dataDir,
    store,
    demo: true,
    extensions: createExtensionHost({ getSettings: () => store.getSettings() }),
    getSettings: () => store.getSettings(),
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_RETRY_MAX: '1',
      WEFT_RETRY_BASE_MS: '20',
      ...extraEnv,
    },
  });
  const conv = await kernel.createConversation({
    workspaceId: ws.id,
    workspacePath: wsPath,
    title: 'test',
  });
  return {
    dataDir,
    wsPath,
    store,
    kernel,
    conv,
    async close() {
      await kernel.close();
      store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('1. foreground task returns child reply verbatim without STATUS stripping, and validates dispatch args', { timeout: 60000 }, async () => {
  const verbatimReply = 'STATUS: incomplete\nLine two stays verbatim\nSTATUS: done';
  const h = await openTestKernel([
    { tool: 'task', args: { description: '   ', prompt: 'hello' } },
    { tool: 'task', args: { description: 'Missing prompt', prompt: '  ' } },
    {
      tool: 'task',
      args: {
        description: 'Inspect auth module',
        prompt: '[fg-child] Check auth module and report.',
      },
    },
    { text: 'parent-finished' },
    { when: '[fg-child]', text: verbatimReply },
  ]);
  try {
    const posted = await h.kernel.postMessage(h.conv, 'run foreground');
    assert.equal(posted.status, 202);
    const done = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      return {
        ok: view.status === 'done' && assistantTexts(view).includes('parent-finished'),
        value: view,
        debug: view.status,
      };
    });
    const tools = toolMessages(done);
    assert.equal(tools.length, 3, JSON.stringify(tools));
    assert.equal(tools[0].tool?.status, 'error');
    assert.match(tools[0].text, /description/i);
    assert.equal(tools[1].tool?.status, 'error');
    assert.match(tools[1].text, /prompt/i);
    assert.equal(tools[2].tool?.status, 'completed');
    assert.equal(tools[2].text, verbatimReply);

    const live = await h.store.getConversation(h.conv.id);
    const subs = await h.kernel.listSubagents(live);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].mode, 'foreground');
    assert.equal(subs[0].name, 'inspect-auth-module');
    assert.equal(subs[0].title, 'Inspect auth module');
    assert.equal(subs[0].status, 'done');
    assert.equal(subs[0].lastText, verbatimReply);
  } finally {
    await h.close();
  }
});

test('2. parallel foreground task calls in one round overlap in time', { timeout: 60000 }, async () => {
  const h = await openTestKernel([
    {
      tools: [
        {
          tool: 'task',
          args: {
            description: 'Worker Alpha',
            prompt: '[alpha] Run parallel task alpha',
          },
        },
        {
          tool: 'task',
          args: {
            description: 'Worker Beta',
            prompt: '[beta] Run parallel task beta',
          },
        },
      ],
    },
    { text: 'both-finished' },
    { when: '[alpha]', delayMs: 650, text: 'ALPHA_DONE' },
    { when: '[beta]', delayMs: 650, text: 'BETA_DONE' },
  ]);
  try {
    const startedWall = Date.now();
    await h.kernel.postMessage(h.conv, 'run parallel');

    // Verify both children are simultaneously in `running` status while delayed.
    const bothRunning = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const subs = await h.kernel.listSubagents(live);
      const running = subs.filter((s) => s.status === 'running');
      return {
        ok: running.length === 2,
        value: running,
        debug: subs.map((s) => ({ name: s.name, status: s.status })),
      };
    }, { attempts: 80, intervalMs: 25 });
    assert.equal(bothRunning.length, 2);

    const done = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      return {
        ok: view.status === 'done' && assistantTexts(view).includes('both-finished'),
        value: view,
      };
    });
    const elapsed = Date.now() - startedWall;
    assert.ok(toolTexts(done).includes('ALPHA_DONE'));
    assert.ok(toolTexts(done).includes('BETA_DONE'));

    const live = await h.store.getConversation(h.conv.id);
    const subs = await h.kernel.listSubagents(live);
    assert.equal(subs.length, 2);
    const [a, b] = subs;
    assert.ok(a.startedAt < b.endedAt && b.startedAt < a.endedAt, JSON.stringify({ a, b, elapsed }));
  } finally {
    await h.close();
  }
});

test('3. background task generates deduplicated short ids and delivers [task <id> completed, no reply needed] follow-up report', { timeout: 60000 }, async () => {
  assert.equal(taskIdFromDescription('Fix Login Test!'), 'fix-login-test');
  assert.equal(taskIdFromDescription('Fix Login Test!', { 'fix-login-test': {} }), 'fix-login-test-2');
  assert.equal(
    taskIdFromDescription('Fix Login Test!', new Set(['fix-login-test', 'fix-login-test-2'])),
    'fix-login-test-3',
  );
  assert.equal(taskIdFromDescription('---'), 'task');
  assert.equal(taskIdFromDescription('abcdefghijklmnopqrstuvwxyz-extra').length <= 24, true);

  const h = await openTestKernel([
    {
      tools: [
        {
          tool: 'task',
          args: {
            description: 'Fix login test',
            prompt: '[bg-one] inspect login test 1',
            run_in_background: true,
          },
        },
        {
          tool: 'task',
          args: {
            description: 'Fix login test',
            prompt: '[bg-two] inspect login test 2',
            run_in_background: true,
          },
        },
      ],
    },
    { text: 'background-started' },
    { when: 'no reply needed', text: 'ack-report' },
    { when: 'no reply needed', text: 'ack-second-report' },
    { when: '[bg-one]', delayMs: 120, text: 'FIRST_BG_REPLY' },
    { when: '[bg-two]', delayMs: 240, text: 'SECOND_BG_REPLY' },
  ]);
  try {
    await h.kernel.postMessage(h.conv, 'start two background tasks');
    const done = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      const texts = (view.messages || []).map((m) => m.text || '');
      return {
        ok: (view.status === 'done' || view.status === 'idle')
          && texts.some((t) => t.includes('[task fix-login-test completed, no reply needed] FIRST_BG_REPLY'))
          && texts.some((t) => t.includes('[task fix-login-test-2 completed, no reply needed] SECOND_BG_REPLY')),
        value: view,
        debug: texts,
      };
    });

    const outputs = toolTexts(done);
    assert.ok(outputs.includes('Started background task fix-login-test.'), JSON.stringify(outputs));
    assert.ok(outputs.includes('Started background task fix-login-test-2.'), JSON.stringify(outputs));

    const live = await h.store.getConversation(h.conv.id);
    const subs = await h.kernel.listSubagents(live);
    assert.equal(subs.length, 2);
    assert.deepEqual(subs.map((s) => s.name), ['fix-login-test', 'fix-login-test-2']);
    assert.deepEqual(subs.map((s) => s.mode), ['background', 'background']);
  } finally {
    await h.close();
  }
});

test('4. management actions (list, send, wait, stop) and error cases work without creating duplicate child entries', { timeout: 60000 }, async () => {
  const h = await openTestKernel([
    // 1) Empty list + foreground task (whose id must NOT be in background registry)
    { tool: 'task', args: { action: 'list' } },
    { tool: 'task', args: { description: 'Quick fg check', prompt: '[fg-once] do fg' } },
    // Trying to wait/send/stop a foreground or unknown id fails cleanly:
    { tool: 'task', args: { action: 'wait', id: 'quick-fg-check' } },
    { tool: 'task', args: { action: 'send', id: 'unknown-id', message: 'hi' } },
    { tool: 'task', args: { action: 'stop', id: 'unknown-id' } },
    // Spawn a background task, list it, wait for it:
    {
      tool: 'task',
      args: {
        description: 'Repo watcher',
        prompt: '[watcher-init] initial scan',
        run_in_background: true,
      },
    },
    { tool: 'task', args: { action: 'list' } },
    { tool: 'task', args: { action: 'wait', id: 'repo-watcher' } },
    // Send follow-up to background task and wait for updated answer:
    { tool: 'task', args: { action: 'send', id: 'repo-watcher', message: '[watcher-next] second scan' } },
    { tool: 'task', args: { action: 'wait', id: 'repo-watcher' } },
    // Spawn a slow background task, stop it, verify list & wait reflect stopped:
    {
      tool: 'task',
      args: {
        description: 'Long sleeper',
        prompt: '[sleeper-hold] sleep long',
        run_in_background: true,
      },
    },
    { tool: 'task', args: { action: 'stop', id: 'long-sleeper' } },
    { tool: 'task', args: { action: 'list', id: 'long-sleeper' } },
    { tool: 'task', args: { action: 'wait', id: 'long-sleeper' } },
    { text: 'management-complete' },
    { when: 'no reply needed', text: 'post-report-ack' },
    { when: '[fg-once]', text: 'FG_RESULT' },
    { when: '[watcher-init]', delayMs: 120, text: 'WATCHER_V1' },
    { when: '[watcher-next]', text: 'pad-0' },
    { when: '[watcher-next]', delayMs: 120, text: 'WATCHER_V2' },
    { when: '[sleeper-hold]', delayMs: 60000, text: 'NEVER_REACHED' },
  ]);
  try {
    await h.kernel.postMessage(h.conv, 'exercise management');
    const done = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      return {
        ok: assistantTexts(view).includes('management-complete')
          && (view.status === 'done' || view.status === 'idle'),
        value: view,
        debug: { status: view.status, tools: toolTexts(view) },
      };
    }, { attempts: 200, intervalMs: 50 });

    const tools = toolMessages(done);
    const texts = tools.map((t) => t.text || '');
    assert.equal(texts[0], 'No background tasks.');
    assert.equal(texts[1], 'FG_RESULT');
    assert.equal(tools[2].tool?.status, 'error');
    assert.match(texts[2], /Unknown background task quick-fg-check/);
    assert.equal(tools[3].tool?.status, 'error');
    assert.match(texts[3], /Unknown background task unknown-id/);
    assert.equal(tools[4].tool?.status, 'error');
    assert.match(texts[4], /Unknown background task unknown-id/);
    assert.equal(texts[5], 'Started background task repo-watcher.');
    assert.match(texts[6], /^repo-watcher: (running|idle) \(Repo watcher\)$/);
    assert.equal(texts[7], 'WATCHER_V1');
    assert.equal(texts[8], 'Sent message to repo-watcher.');
    assert.equal(texts[9], 'WATCHER_V2');
    assert.equal(texts[10], 'Started background task long-sleeper.');
    assert.equal(texts[11], 'Stopped long-sleeper.');
    assert.equal(texts[12], 'long-sleeper: stopped (Long sleeper)');
    assert.equal(texts[13], '[task long-sleeper stopped]');
    assert.equal(tools[13].tool?.status, 'completed');

    // Ensure management calls did NOT set conversationId in details or create extra subagents!
    const parentEntries = await h.kernel.harness.commit(
      (tx) => tx.scanEntries({ conversationId: h.conv.harnessId, order: 'ascending' }, 200),
      h.kernel.context,
    );
    const managementResults = parentEntries.items
      .map((e) => e.model?.[0])
      .filter((m) => m?.toolName === 'task')
      .filter((m) => {
        const out = m.content?.[0]?.text || '';
        return out === 'No background tasks.'
          || out.startsWith('Sent message to ')
          || out.startsWith('Stopped ')
          || out.startsWith('long-sleeper: ');
      });
    assert.ok(managementResults.length >= 4);
    for (const result of managementResults) {
      assert.equal(result.details?.conversationId, undefined);
    }

    const live = await h.store.getConversation(h.conv.id);
    const subs = await h.kernel.listSubagents(live);
    assert.equal(subs.length, 3); // quick-fg-check, repo-watcher, long-sleeper
  } finally {
    await h.close();
  }
});

test('5. crash-replay safety: foreground, background spawn, and send are idempotent across replays and SIGKILL', { timeout: 90000 }, async () => {
  // Part A: Direct tool execute replay with identical `api.taskId` for foreground, background start, and send.
  const h = await openTestKernel([
    { when: '[fg-replay]', text: 'FG_REPLAY_OK' },
    { when: '[bg-replay]', text: 'BG_REPLAY_OK' },
    { when: '[bg-send-replay]', text: 'BG_SEND_REPLAY_OK' },
  ]);
  try {
    const blocked = [];
    const ext = createTaskExtension({
      prepareChild: async (parent) => ({
        change: {
          tools: (parent?.tools || []).filter((t) => !CHILD_HIDDEN_TOOLS.has(t.name)),
          instructions: SUBAGENT_INSTRUCTIONS,
          ...(parent?.cwd ? { cwd: parent.cwd } : {}),
        },
      }),
      blocked,
    });
    const taskTool = ext.tools.find((t) => t.name === TASK_TOOL_NAME);
    assert.equal(taskTool.replay, 'safe');
    assert.equal(taskTool.executionMode, undefined);

    const parentConvId = h.conv.harnessId;
    const parentHandle = await h.kernel.harness.conversation(parentConvId, h.kernel.context);
    const makeApi = (taskId) => ({
      taskId,
      conversationId: parentConvId,
      callId: `call-${taskId}`,
      agent: (ctx) => parentHandle.agent(ctx),
      details: async () => {},
      commit: (fn, ctx) => h.kernel.harness.commit(fn, ctx),
      snapshot: (doc, id, ctx) => h.kernel.harness.snapshot(doc, id, ctx),
      conversation: (id, ctx) => h.kernel.harness.conversation(id, ctx),
    });

    // Create a real owning task on the parent conversation for foreground ownership test:
    const fgOwnerTaskId = await h.kernel.harness.commit(
      async (tx) => tx.createTask(
        ext.tasks[0], // TaskAnchor definition as an existing task id in storage
        null,
        { ownership: { kind: 'conversation' }, conversationId: parentConvId, background: true },
      ),
      h.kernel.context,
    );

    const fgApi = makeApi(fgOwnerTaskId);
    const fgFirst = await taskTool.execute(
      { description: 'Replay FG', prompt: '[fg-replay] once' },
      fgApi,
      h.kernel.context,
    );
    const fgSecond = await taskTool.execute(
      { description: 'Replay FG', prompt: '[fg-replay] once' },
      fgApi,
      h.kernel.context,
    );
    assert.equal(fgFirst.output[0].text, 'FG_REPLAY_OK');
    assert.equal(fgSecond.output[0].text, 'FG_REPLAY_OK');
    assert.equal(fgFirst.details.conversationId, fgSecond.details.conversationId);
    const fgChildEntries = await h.kernel.harness.commit(
      (tx) => tx.scanEntries({ conversationId: fgFirst.details.conversationId, order: 'ascending' }, 50),
      h.kernel.context,
    );
    assert.equal(fgChildEntries.items.filter((e) => e.kind === 'pi.user').length, 1);

    // Background start replay with same api.taskId:
    const bgApi = makeApi('bg-call-task-1');
    const bgFirst = await taskTool.execute(
      { description: 'Replay BG', prompt: '[bg-replay] start', run_in_background: true },
      bgApi,
      h.kernel.context,
    );
    const bgSecond = await taskTool.execute(
      { description: 'Replay BG', prompt: '[bg-replay] start', run_in_background: true },
      bgApi,
      h.kernel.context,
    );
    assert.equal(bgFirst.output[0].text, 'Started background task replay-bg.');
    assert.equal(bgSecond.output[0].text, 'Started background task replay-bg.');
    assert.equal(bgFirst.details.conversationId, bgSecond.details.conversationId);
    const docAfterSpawn = await h.kernel.harness.snapshot(TasksDoc, parentConvId, h.kernel.context);
    assert.deepEqual(Object.keys(docAfterSpawn.tasks), ['replay-bg']);

    // Wait for initial bg run to settle before testing `send` replay:
    const bgChildHandle = await h.kernel.harness.conversation(bgFirst.details.conversationId, h.kernel.context);
    await bgChildHandle.waitForIdle(h.kernel.context);

    // Background `send` replay with same api.taskId:
    const sendApi = makeApi('bg-send-task-1');
    const sendFirst = await taskTool.execute(
      { action: 'send', id: 'replay-bg', message: '[bg-send-replay] followup' },
      sendApi,
      h.kernel.context,
    );
    const sendSecond = await taskTool.execute(
      { action: 'send', id: 'replay-bg', message: '[bg-send-replay] followup' },
      sendApi,
      h.kernel.context,
    );
    assert.equal(sendFirst.output[0].text, 'Sent message to replay-bg.');
    assert.equal(sendSecond.output[0].text, 'Sent message to replay-bg.');
    await bgChildHandle.waitForIdle(h.kernel.context);
    const bgChildEntries = await h.kernel.harness.commit(
      (tx) => tx.scanEntries({ conversationId: bgFirst.details.conversationId, order: 'ascending' }, 50),
      h.kernel.context,
    );
    assert.equal(bgChildEntries.items.filter((e) => e.kind === 'pi.user').length, 2);
  } finally {
    await h.close();
  }

  // Part B: Process SIGKILL mid-flight foreground `task` resumes same child without a second submit.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ktask-kill-'));
  const ready = path.join(dataDir, 'ready');
  const script = await writeScript(dataDir, 'kill.json', [
    { tool: 'task', args: { description: 'Resume task', prompt: 'resume-task-prompt' } },
    { text: 'parent-resumed' },
    { when: 'resume-task-prompt', delayMs: 2000, text: 'RESUMED_CHILD_OK' },
  ]);
  const env = {
    WEFT_RETRY_MAX: '2',
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
    WEFT_FAUX_HOLD_READY: ready,
  };
  let proc = null;
  try {
    const first = await startServer({ token: TOKEN, env, dataDir });
    proc = first.proc;
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'recover' });
    const conv = await request(first.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'recover' });
    assert.equal((await request(first.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'go' })).status, 202);
    await waitForFile(ready);
    await killed(proc);
    proc = null;
    await rm(ready, { force: true });

    const second = await startServer({ token: TOKEN, env, dataDir });
    proc = second.proc;
    const done = await waitForHttp(second.base, conv.body.id, (body) => (
      body.status === 'done' && assistantTexts(body).includes('parent-resumed')
    ), 120);
    assert.match(toolTexts(done).join('\n'), /RESUMED_CHILD_OK/);
    const children = subagentsOf(done).filter((agent) => agent.mode === 'foreground');
    assert.equal(children.length, 1);
    assert.equal(children[0].name, 'resume-task');
    const childMsgs = await request(
      second.base,
      'GET',
      `/api/conversations/${conv.body.id}/agents/${encodeURIComponent(children[0].id)}/messages`,
    );
    assert.equal(childMsgs.status, 200);
    assert.equal(childMsgs.body.messages.filter((m) => m.role === 'user').length, 1);
  } finally {
    await stopServer(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('6. child agent cannot see task, skill, ask_user_question, handoff, or schedule tools', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ktask-child-tools-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const h = await openTestKernel([
    {
      tool: 'task',
      args: {
        description: 'Check child loadout',
        prompt: '[child-loadout] verify tools',
      },
    },
    { text: 'loadout-verified' },
    { when: '[child-loadout]', text: 'CHILD_TOOLS_OK' },
  ], { WEFT_FAUX_RECORD: record });
  try {
    await h.kernel.postMessage(h.conv, 'check child tools');
    await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      return { ok: view.status === 'done' && assistantTexts(view).includes('loadout-verified'), value: view };
    });

    const live = await h.store.getConversation(h.conv.id);
    const [sub] = await h.kernel.listSubagents(live);
    assert.ok(sub);
    const parentHandle = await h.kernel.harness.conversation(h.conv.harnessId, h.kernel.context);
    const childHandle = await h.kernel.harness.conversation(childHarnessId(sub), h.kernel.context);
    const parentAgent = await parentHandle.agent(h.kernel.context);
    const childAgent = await childHandle.agent(h.kernel.context);

    const parentToolNames = parentAgent.tools.map((t) => t.name);
    const childToolNames = childAgent.tools.map((t) => t.name);
    assert.equal(parentToolNames.includes('task'), true);
    assert.equal(parentToolNames.includes('delegate'), false);
    assert.equal(parentToolNames.includes('subagent'), false);
    assert.equal(parentToolNames.includes('skill'), true);
    assert.equal(parentToolNames.includes('schedule'), true);

    for (const forbidden of ['task', 'delegate', 'subagent', 'skill', 'ask_user_question', 'handoff', 'schedule']) {
      assert.equal(childToolNames.includes(forbidden), false, `child should not see ${forbidden}`);
    }
    assert.equal(childToolNames.includes('read'), true);
    assert.equal(childAgent.instructions ?? '', SUBAGENT_INSTRUCTIONS);
    assert.equal(/STATUS:/i.test(SUBAGENT_INSTRUCTIONS), false);
    assert.deepEqual(childAgent.model, parentAgent.model);
    assert.equal(childAgent.cwd, h.wsPath);

    const records = (await readFile(record, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const parentCall = records.find((r) => (r.tools || []).includes('task'));
    const childCall = records.find((r) => (r.users || []).some((u) => u.includes('[child-loadout]')));
    assert.ok(parentCall);
    assert.ok(childCall);
    assert.equal(parentCall.toolDescriptions?.task, TASK_DESCRIPTION);
    assert.equal(parentCall.toolDescriptions?.skill, SKILL_TOOL_DESCRIPTION);
    assert.equal((childCall.tools || []).includes('task'), false);
    assert.equal(sectionInner(childCall, 'instructions'), SUBAGENT_INSTRUCTIONS);
    assert.equal(sectionInner(childCall, 'skills'), '');
  } finally {
    await h.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('7a. stopping only the child returns [task <id> stopped] non-error and lets main agent continue its turn', { timeout: 60000 }, async () => {
  const readyFile = path.join(tmpdir(), `piw-ktask-stop-ready-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const h = await openTestKernel([
    {
      tool: 'task',
      args: {
        description: 'Slow audit',
        prompt: '[hold-child-only] wait to be stopped',
      },
    },
    { text: 'parent-continued-after-child-stop' },
    { when: '[hold-child-only]', delayMs: 60000, text: 'CHILD_NEVER_FINISHES' },
  ], { WEFT_FAUX_HOLD_READY: readyFile });
  try {
    await h.kernel.postMessage(h.conv, 'start slow audit');
    await waitForFile(readyFile);
    const runningSub = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const subs = await h.kernel.listSubagents(live);
      return { ok: subs.length === 1 && subs[0].status === 'running', value: subs[0] };
    });

    const stopped = await h.kernel.stopAgent(h.conv.id, runningSub.id);
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.status, 'stopped');

    const done = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      return {
        ok: view.status === 'done' && assistantTexts(view).includes('parent-continued-after-child-stop'),
        value: view,
        debug: view.status,
      };
    });
    const [toolMsg] = toolMessages(done);
    assert.ok(toolMsg);
    assert.equal(toolMsg.text, '[task slow-audit stopped]');
    assert.equal(toolMsg.tool?.status, 'completed');

    const live = await h.store.getConversation(h.conv.id);
    const [afterSub] = await h.kernel.listSubagents(live);
    assert.equal(afterSub.status, 'stopped');
  } finally {
    await rm(readyFile, { force: true });
    await h.close();
  }
});

test('7b. child model error marks foreground tool result isError: true, delivers failed report in background, and sets subagent status failed', { timeout: 60000 }, async () => {
  const h = await openTestKernel([
    {
      tool: 'task',
      args: {
        description: 'Broken fg task',
        prompt: '[fail-fg] trigger model failure',
      },
    },
    {
      tool: 'task',
      args: {
        description: 'Broken bg task',
        prompt: '[fail-bg] trigger bg model failure',
        run_in_background: true,
      },
    },
    { text: 'parent-handled-fg-error' },
    { text: 'parent-handled-bg-error' },
    { when: '[fail-fg]', error: 'upstream boom fg' },
    { when: '[fail-bg]', delayMs: 80, error: 'upstream boom bg' },
  ]);
  try {
    await h.kernel.postMessage(h.conv, 'run failing children');
    const done = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      return {
        ok: assistantTexts(view).includes('parent-handled-bg-error')
          && (view.status === 'done' || view.status === 'idle'),
        value: view,
        debug: {
          status: view.status,
          assistants: assistantTexts(view),
          messages: (view.messages || []).map((m) => m.text),
        },
      };
    });

    const [fgTool] = toolMessages(done);
    assert.equal(fgTool.tool?.status, 'error');
    assert.match(fgTool.text, /^task broken-fg-task failed: .*upstream boom fg/);

    const reportMsg = (done.messages || []).find((m) => (
      m.role === 'user' && String(m.text || '').startsWith('[task broken-bg-task failed:')
    ));
    assert.ok(reportMsg, JSON.stringify(done.messages));
    assert.match(reportMsg.text, /upstream boom bg/);

    const live = await h.store.getConversation(h.conv.id);
    const subs = await h.kernel.listSubagents(live);
    assert.equal(subs.length, 2);
    for (const sub of subs) {
      assert.equal(sub.status, 'failed', JSON.stringify(sub));
      assert.match(sub.lastText, /upstream boom/);
    }
  } finally {
    await h.close();
  }
});

test('stopping parent conversation aborts background tasks without waking idle parent; unknown agent messages return 404', { timeout: 60000 }, async () => {
  const readyFile = path.join(tmpdir(), `piw-ktask-parent-stop-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const h = await openTestKernel([
    {
      tool: 'task',
      args: {
        description: 'Bg sleeper',
        prompt: '[bg-parent-stop] hold forever',
        run_in_background: true,
      },
    },
    { text: 'parent-idle-now' },
    { when: '[bg-parent-stop]', delayMs: 60000, text: 'BG_SHOULD_NOT_FINISH' },
  ], { WEFT_FAUX_HOLD_READY: readyFile });
  try {
    const missingConv = await h.kernel.childMessages('missing', 'none');
    assert.equal(missingConv.status, 404);
    const missingAgent = await h.kernel.childMessages(h.conv.id, 'none');
    assert.equal(missingAgent.status, 404);

    await h.kernel.postMessage(h.conv, 'spawn sleeper');
    await waitForFile(readyFile);
    await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const view = await h.kernel.present(live, { includeMessages: true });
      return { ok: view.status === 'done' && assistantTexts(view).includes('parent-idle-now'), value: view };
    });

    const stopped = await h.kernel.stopConversation(h.conv.id);
    assert.equal(stopped.status, 200);

    const subs = await waitForKernel(async () => {
      const live = await h.store.getConversation(h.conv.id);
      const list = await h.kernel.listSubagents(live);
      return { ok: list.length === 1 && list[0].status === 'stopped', value: list };
    });
    assert.equal(subs[0].name, 'bg-sleeper');
    assert.equal(subs[0].status, 'stopped');

    // Give reporter a brief moment to settle; verify no report woke the idle parent.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const live = await h.store.getConversation(h.conv.id);
    const afterView = await h.kernel.present(live, { includeMessages: true });
    assert.equal(
      (afterView.messages || []).some((m) => String(m.text || '').includes('[task bg-sleeper')),
      false,
    );
  } finally {
    await rm(readyFile, { force: true });
    await h.close();
  }
});
