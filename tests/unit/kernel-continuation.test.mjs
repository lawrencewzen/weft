import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDoc } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import { AUTO_CONTINUE_PREFIX, isAutoContinueText } from '../../src/kernel/continuation.mjs';
import { createKernelModels, DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokensFromEnv } from '../../src/kernel/models.mjs';
import { autoTitleFromText } from '../../src/kernel/agent-config.mjs';
import { EXTENSION_NAMES } from '../../src/kernel/ids.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { buildThread } from '../../src/v2/views/thread.ts';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';
import { ROOT } from './_root.mjs';

const TOKEN = 'unit-kernel-continuation-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);
const LEGACY_AUTO = `${AUTO_CONTINUE_PREFIX} 上一条回复因输出长度上限被截断`;

async function openConversation(base, title = 'continuation') {
  const ws = await request(base, 'POST', '/api/workspaces', { name: 'continuation-ws' });
  assert.equal(ws.status, 201);
  const conv = await request(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title });
  assert.equal(conv.status, 201);
  return { ws: ws.body, conv: conv.body };
}

async function waitFor(base, cid, ready, attempts = 80) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}

async function writeScript(dataDir, name, turns) {
  const file = path.join(dataDir, name);
  await writeFile(file, JSON.stringify({ turns }));
  return file;
}

function settingsFor(api) {
  return {
    version: 3,
    providers: [{
      id: 'custom-aaaaaaaa',
      kind: 'custom',
      name: 'Default',
      baseUrl: 'http://127.0.0.1:4101/v1',
      api,
      enabled: ['model-default'],
      overrides: {},
    }],
    defaultModel: { providerId: 'custom-aaaaaaaa', modelId: 'model-default' },
  };
}

test('output limit: env default is 64000; unknown openai sends 0; other unknown APIs use 64000', async () => {
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS, 64000);
  assert.equal(maxOutputTokensFromEnv({}), 64000);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '2048' }), 2048);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: 'nope' }), 64000);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '0' }), 64000);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '-8' }), 64000);
  assert.equal(maxOutputTokensFromEnv({ WEFT_MAX_OUTPUT_TOKENS: '1.5' }), 64000);

  async function tokensFor(api, env) {
    const models = createModels();
    const routes = createKernelModels({ models, getSettings: async () => settingsFor(api), env });
    const main = await routes.modelFor({});
    return models.getModel(main.provider, main.modelId).maxTokens;
  }

  assert.equal(await tokensFor('openai-completions', {}), 0);
  assert.equal(await tokensFor('openai-completions', { WEFT_MAX_OUTPUT_TOKENS: '8192' }), 8192);
  assert.equal(await tokensFor('openai-completions', { WEFT_MAX_OUTPUT_TOKENS: 'abc' }), 0);
  assert.equal(await tokensFor('anthropic-messages', {}), 64000);
  assert.equal(await tokensFor('openai-responses', {}), 64000);
  assert.equal(await tokensFor('anthropic-messages', { WEFT_MAX_OUTPUT_TOKENS: '1000' }), 1000);
});

test('legacy auto-continue text is still recognized and skipped by titles', () => {
  assert.equal(isAutoContinueText(LEGACY_AUTO), true);
  assert.equal(isAutoContinueText('hello'), false);
  assert.equal(autoTitleFromText('New conversation', LEGACY_AUTO), undefined);
  assert.equal(autoTitleFromText('New conversation', 'hello world'), 'hello world');
});

test('assistant snapshots still tag legacy auto-continue user messages', () => {
  const { messages } = messagesFromEntries([
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'part-one' }],
        stopReason: 'length',
      }],
    },
    {
      id: 3,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: LEGACY_AUTO }] }],
    },
  ]);
  assert.equal(messages.find((message) => message.id === '2').stopReason, 'length');
  assert.equal(messages.find((message) => message.id === '3').kind, 'auto-continue');
  assert.equal(Object.hasOwn(messages.find((message) => message.id === '1'), 'kind'), false);
});

test('kernel path: a length stop ends the run and does not send another user message', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kcont-'));
  const script = await writeScript(dataDir, 'continue.json', [
    { text: 'part-one', stopReason: 'length' },
    { text: 'part-two' },
  ]);
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
  });
  try {
    const { conv } = await openConversation(srv.base);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'write a long answer' });
    assert.equal(sent.status, 202);
    const body = await waitFor(srv.base, conv.id, (row) => row.status === 'done' || row.status === 'failed');
    assert.equal(body.status, 'done', srv.logs());
    const users = body.messages.filter((message) => message.role === 'user');
    const assistants = body.messages.filter((message) => message.role === 'assistant');
    assert.equal(users.length, 1);
    assert.equal(users[0].text, 'write a long answer');
    assert.equal(users.some((message) => isAutoContinueText(message.text)), false);
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].text, 'part-one');
    assert.equal(assistants[0].stopReason, 'length');
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('kernel path: a length answer with a tool call does not run the tool, and the next user message continues', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-klen-tool-'));
  const script = await writeScript(dataDir, 'length-tool.json', [
    {
      text: 'cut off',
      stopReason: 'length',
      tool: 'write',
      args: { path: 'nope.txt', content: 'should-not\n' },
    },
    { text: 'resumed' },
  ]);
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script },
  });
  try {
    const { ws, conv } = await openConversation(srv.base, 'length-tool');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'write it' });
    assert.equal(sent.status, 202);
    const first = await waitFor(srv.base, conv.id, (row) => row.status === 'done' || row.status === 'failed');
    assert.equal(first.status, 'done', srv.logs());
    assert.equal(first.messages.filter((message) => message.role === 'user').length, 1);
    const assistant = first.messages.filter((message) => message.role === 'assistant');
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].stopReason, 'length');
    const tools = first.messages.filter((message) => message.role === 'tool');
    assert.equal(tools.some((message) => message.tool?.status === 'completed'), false);
    await assert.rejects(() => readFile(path.join(ws.path, 'nope.txt'), 'utf8'));

    const next = await request(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'go on' });
    assert.equal(next.status, 202);
    const second = await waitFor(srv.base, conv.id, (row) => (
      row.status === 'done' && row.messages.some((message) => message.role === 'assistant' && message.text === 'resumed')
    ));
    assert.equal(second.status, 'done', srv.logs());
    assert.equal(second.messages.filter((message) => message.role === 'user').at(-1).text, 'go on');
    assert.equal(second.messages.some((message) => message.role === 'assistant' && message.text === 'resumed'), true);
    await assert.rejects(() => readFile(path.join(ws.path, 'nope.txt'), 'utf8'));
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a stored weft-continuation extension and an old auto-continue message still open and accept a send', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-klegacy-ext-'));
  const wsPath = path.join(dataDir, 'ws');
  await mkdir(wsPath, { recursive: true });
  let store = createSqliteStore(dataDir);
  let kernel = null;
  try {
    kernel = await openConversationKernel({
      dataDir,
      store,
      demo: true,
      extensions: createExtensionHost({
        skillDirs: [path.join(ROOT, 'skills')],
        getSettings: () => store.getSettings(),
      }),
      getSettings: () => store.getSettings(),
      env: {
        WEFT_LLM: 'faux',
        WEFT_FAUX_TEXT: 'still-here',
        WEFT_RETRY_MAX: '1',
        WEFT_RETRY_BASE_MS: '20',
      },
    });
    const ws = await store.createWorkspace({ name: 'legacy', path: wsPath, kind: 'project' });
    const conv = await kernel.createConversation({
      workspaceId: ws.id,
      workspacePath: wsPath,
      title: 'legacy',
    });
    const handle = await kernel.harness.conversation(conv.harnessId, kernel.context);
    await handle.configure({
      extensions: [...EXTENSION_NAMES, 'weft-continuation'].map((name) => ({ name })),
    }, kernel.context);
    const agent = await kernel.harness.snapshot(AgentDoc, conv.harnessId, kernel.context);
    assert.equal(Array.isArray(agent.extensions), true);
    assert.equal(agent.extensions.includes('weft-continuation'), true);

    const posted = await kernel.postMessage(conv, LEGACY_AUTO);
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const hidden = await waitKernel(kernel, store, conv.id);
    assert.equal(hidden.status, 'done', JSON.stringify(hidden.llmError || hidden.status));
    const thread = await buildThread(hidden.messages, { lang: 'zh' });
    assert.equal(thread.items.some((item) => item.kind === 'user' && isAutoContinueText(item.text)), false);
    assert.equal(thread.items.some((item) => item.noteKind === 'auto_continue'), false);
    assert.equal(hidden.messages.some((message) => message.role === 'user' && isAutoContinueText(message.text)), true);

    await kernel.close();
    kernel = null;
    store.close();
    store = createSqliteStore(dataDir);
    kernel = await openConversationKernel({
      dataDir,
      store,
      demo: true,
      extensions: createExtensionHost({
        skillDirs: [path.join(ROOT, 'skills')],
        getSettings: () => store.getSettings(),
      }),
      getSettings: () => store.getSettings(),
      env: {
        WEFT_LLM: 'faux',
        WEFT_FAUX_TEXT: 'after-reopen',
        WEFT_RETRY_MAX: '1',
        WEFT_RETRY_BASE_MS: '20',
      },
    });
    const again = await store.getConversation(conv.id);
    const opened = await kernel.present(again, { includeMessages: true });
    assert.equal(opened.status, 'done', JSON.stringify(opened.llmError || opened.status));
    const openedThread = await buildThread(opened.messages, { lang: 'zh' });
    assert.equal(openedThread.items.some((item) => isAutoContinueText(item.text)), false);
    const follow = await kernel.postMessage(again, 'keep going');
    assert.equal(follow.status, 202, JSON.stringify(follow.body));
    const done = await waitKernel(kernel, store, conv.id, (body) => (
      body.status === 'done' && body.messages.some((message) => message.text === 'after-reopen')
    ));
    assert.equal(done.status, 'done', JSON.stringify(done.llmError || done.status));
    assert.equal(done.messages.some((message) => message.role === 'assistant' && message.text === 'after-reopen'), true);
  } finally {
    if (kernel) await kernel.close();
    if (store) store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function waitKernel(kernel, store, id, ready = (body) => body.status === 'done' || body.status === 'failed') {
  let body = null;
  for (let i = 0; i < 100; i += 1) {
    const live = await store.getConversation(id);
    body = await kernel.present(live, { includeMessages: true });
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}
