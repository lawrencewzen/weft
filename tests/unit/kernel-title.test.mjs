import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createModels } from '@earendil-works/pi-ai/models';
import { contentText } from '@earendil-works/pi-ai';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { CONTINUE_TEXT } from '../../src/kernel/continuation-text.mjs';
import { scriptPool, titleReplyFromScript } from '../../src/kernel/faux-script.mjs';
import { FAUX_MODEL, registerFaux } from '../../src/kernel/index.mjs';
import {
  TITLE_MAX_TOKENS,
  TITLE_PROMPT_MARKER,
  TITLE_TIMEOUT_MS,
  buildTitlePrompt,
  completeTitle,
  firstTurnTexts,
  isTitleRequest,
  maybeGenerateConversationTitle,
  sanitizeGeneratedTitle,
  shouldGenerateTitle,
} from '../../src/kernel/title.mjs';
import { APP_DB_FILE, createSqliteStore } from '../../src/store/sqlite.mjs';
import { ROOT } from './_root.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const TOKEN = 'unit-kernel-title-token';
const TITLE_SCRIPT = path.join(ROOT, 'tests/fixtures/title.json');
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

function memoryStore(seed) {
  const row = { ...seed };
  return {
    row,
    async getConversation() {
      return { ...row };
    },
    async updateConversation(_id, patch) {
      Object.assign(row, patch);
      return { ...row };
    },
  };
}

function titleModels(raw, { stopReason = 'stop', error } = {}) {
  const calls = [];
  return {
    calls,
    models: {
      async completeSimple(model, context, options) {
        calls.push({ model, context, options });
        if (error) throw error;
        return {
          content: [{ type: 'text', text: raw }],
          stopReason,
        };
      },
    },
  };
}

async function generate(overrides = {}) {
  const cid = overrides.cid || `c-${Math.random().toString(16).slice(2)}`;
  const conv = {
    id: cid,
    title: '帮我写一个用户登录页面',
    titleSource: 'auto',
    titleGeneratedAt: null,
    harnessId: 1,
    ...(overrides.conv || {}),
  };
  const store = overrides.store || memoryStore(conv);
  const { models, calls } = overrides.models
    ? { models: overrides.models, calls: overrides.calls || [] }
    : titleModels(overrides.rawTitle ?? '登录功能');
  const emitted = [];
  const result = await maybeGenerateConversationTitle(cid, {
    store,
    models,
    resolveModel: overrides.resolveModel || (async () => ({ id: 'faux-1', provider: 'faux' })),
    readTranscript: overrides.readTranscript || (async () => ({
      messages: [
        { role: 'user', text: '帮我写一个用户登录页面' },
        { role: 'assistant', text: '好的，开始写。' },
      ],
    })),
    emit: overrides.emit || (async (id, event) => { emitted.push({ id, event }); }),
    status: overrides.status ?? 'done',
    isSubagent: overrides.isSubagent ?? false,
    now: overrides.now || (() => 1_700_000_000_000),
  });
  return { result, store, calls, cid, emitted };
}

test('sanitizeGeneratedTitle strips quotes, prefixes, punctuation, and newlines', () => {
  assert.equal(sanitizeGeneratedTitle(''), '');
  assert.equal(sanitizeGeneratedTitle('   \n  '), '');
  assert.equal(sanitizeGeneratedTitle('"登录功能"'), '登录功能');
  assert.equal(sanitizeGeneratedTitle('「登录功能」'), '登录功能');
  assert.equal(sanitizeGeneratedTitle('“Login form”'), 'Login form');
  assert.equal(sanitizeGeneratedTitle('标题：登录功能'), '登录功能');
  assert.equal(sanitizeGeneratedTitle('Title: Login form'), 'Login form');
  assert.equal(sanitizeGeneratedTitle('登录功能。'), '登录功能');
  assert.equal(sanitizeGeneratedTitle('Login form.'), 'Login form');
  assert.equal(sanitizeGeneratedTitle('登录\n功能'), '登录 功能');
  assert.equal(sanitizeGeneratedTitle(TITLE_PROMPT_MARKER), '');
});

test('sanitizeGeneratedTitle caps CJK length and English word count', () => {
  assert.equal(sanitizeGeneratedTitle('一二三四五六七八九十一二三四五六七八九十多余'), '一二三四五六七八九十一二三四五六七八九十');
  assert.equal(
    sanitizeGeneratedTitle('one two three four five six seven eight'),
    'one two three four five six',
  );
  assert.equal(
    sanitizeGeneratedTitle('abcdefghijklmnopqrstuvwxyz0123456789EXTRA'),
    'abcdefghijklmnopqrstuvwxyz012345',
  );
});

test('shouldGenerateTitle skips subagents, non-done, user titles, and already generated', () => {
  const auto = { titleSource: 'auto', titleGeneratedAt: null };
  assert.equal(shouldGenerateTitle(auto, { status: 'done' }), true);
  assert.equal(shouldGenerateTitle(auto, { status: 'failed' }), false);
  assert.equal(shouldGenerateTitle(auto, { status: 'stopped' }), false);
  assert.equal(shouldGenerateTitle(auto, { status: 'running' }), false);
  assert.equal(shouldGenerateTitle(auto, { status: 'done', isSubagent: true }), false);
  assert.equal(shouldGenerateTitle({ titleSource: 'user', titleGeneratedAt: null }, { status: 'done' }), false);
  assert.equal(shouldGenerateTitle({ titleSource: 'auto', titleGeneratedAt: 1 }, { status: 'done' }), false);
  assert.equal(shouldGenerateTitle(null, { status: 'done' }), false);
});

test('firstTurnTexts uses the first real user prompt and first assistant text', () => {
  assert.deepEqual(firstTurnTexts([
    { role: 'user', text: CONTINUE_TEXT, kind: 'auto-continue' },
    { role: 'user', text: '帮我写一个用户登录页面' },
    { role: 'assistant', text: '' },
    { role: 'assistant', text: '好的' },
  ]), { userText: '帮我写一个用户登录页面', assistantText: '好的' });
});

test('isTitleRequest only matches the host title completion', () => {
  const prompt = buildTitlePrompt('帮我写一个用户登录页面', '好的');
  assert.equal(prompt.includes(TITLE_PROMPT_MARKER), true);
  assert.equal(isTitleRequest({ messages: [{ role: 'user', content: prompt }] }), true);
  assert.equal(isTitleRequest({
    messages: [
      { role: 'system', content: 'tools' },
      { role: 'user', content: prompt },
    ],
  }), false);
  assert.equal(isTitleRequest({ messages: [{ role: 'user', content: '帮我写一个用户登录页面' }] }), false);
});

test('scriptPool ignores title turns and titleReplyFromScript matches them', () => {
  const turns = [
    { text: 'conversation reply' },
    { title: true, when: '帮我写一个用户登录页面', text: '登录功能' },
  ];
  const convCtx = { messages: [{ role: 'user', content: '帮我写一个用户登录页面' }] };
  assert.deepEqual(scriptPool(turns, convCtx).map((turn) => turn.text), ['conversation reply']);
  const titleCtx = {
    messages: [{ role: 'user', content: buildTitlePrompt('帮我写一个用户登录页面', '好的') }],
  };
  const reply = titleReplyFromScript(turns, titleCtx);
  assert.equal(contentText(reply.content), '登录功能');
  const empty = titleReplyFromScript([{ text: 'conversation reply' }], titleCtx);
  assert.equal(contentText(empty.content), '');
});

test('completeTitle calls completeSimple with off thinking, 64 tokens, and the title prompt', async () => {
  const models = createModels();
  const faux = registerFaux(models);
  const seen = [];
  const orig = models.completeSimple.bind(models);
  models.completeSimple = async (model, context, options) => {
    seen.push({ model, context, options });
    return orig(model, context, options);
  };
  faux.setResponses([fauxAssistantMessage('  「登录功能」。  ')]);
  const model = models.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId);
  const raw = await completeTitle({
    models,
    model,
    userText: '帮我写一个用户登录页面',
    assistantText: '好的',
  });
  assert.equal(sanitizeGeneratedTitle(raw), '登录功能');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.maxTokens, TITLE_MAX_TOKENS);
  assert.equal(seen[0].options.maxRetries, 0);
  assert.equal(seen[0].options.toolChoice, 'none');
  assert.equal(seen[0].options.timeoutMs, TITLE_TIMEOUT_MS);
  assert.equal(seen[0].options.reasoning, 'off');
  assert.equal(seen[0].context.messages[0].content.includes(TITLE_PROMPT_MARKER), true);
});

test('maybeGenerateConversationTitle writes once and emits status done', async () => {
  const first = await generate();
  assert.equal(first.result.title, '登录功能');
  assert.equal(first.store.row.titleGeneratedAt, 1_700_000_000_000);
  assert.equal(first.calls.length, 1);
  assert.deepEqual(first.emitted, [{ id: first.cid, event: { event: 'status', data: { status: 'done' } } }]);

  const again = titleModels('另一个标题');
  const retry = await maybeGenerateConversationTitle(first.cid, {
    store: first.store,
    models: again.models,
    resolveModel: async () => ({ id: 'faux-1' }),
    readTranscript: async () => ({
      messages: [
        { role: 'user', text: '帮我写一个用户登录页面' },
        { role: 'assistant', text: '好的，开始写。' },
      ],
    }),
    emit: async () => {},
    status: 'done',
    now: () => 1_800_000_000_000,
  });
  assert.equal(retry, null);
  assert.equal(again.calls.length, 0);
  assert.equal(first.store.row.title, '登录功能');
});

test('title_source user is not overwritten', async () => {
  const { models, calls } = titleModels('登录功能');
  const out = await generate({
    conv: { title: '手动标题', titleSource: 'user' },
    models,
    calls,
  });
  assert.equal(out.result, null);
  assert.equal(out.store.row.title, '手动标题');
  assert.equal(calls.length, 0);
});

test('subagent, auto-continue, failed, and stopped runs do not generate', async () => {
  const cases = [
    { isSubagent: true },
    { status: 'failed' },
    { status: 'stopped' },
    {
      readTranscript: async () => ({
        messages: [
          { role: 'user', text: CONTINUE_TEXT },
          { role: 'assistant', text: '续写' },
        ],
      }),
    },
  ];
  for (const extra of cases) {
    const { models, calls } = titleModels('登录功能');
    const out = await generate({ ...extra, models, calls });
    assert.equal(out.result, null, JSON.stringify(extra));
    assert.equal(out.store.row.title, '帮我写一个用户登录页面');
    assert.equal(out.store.row.titleGeneratedAt, null);
    assert.equal(calls.length, 0);
  }
});

test('empty or failed model result keeps the temporary title', async () => {
  for (const models of [
    titleModels('').models,
    titleModels('x', { stopReason: 'error' }).models,
    titleModels('x', { error: new Error('no creds') }).models,
  ]) {
    const out = await generate({
      models,
      conv: { title: '帮我写一个用户登录页面', titleSource: 'auto', titleGeneratedAt: null, harnessId: 1 },
    });
    assert.equal(out.result, null);
    assert.equal(out.store.row.title, '帮我写一个用户登录页面');
    assert.equal(out.store.row.titleGeneratedAt, null);
  }
});

test('migrating an old conversations row defaults title_source to auto', async () => {
  const dir = await makeTempDir('weft-title-migrate-');
  try {
    const db = new DatabaseSync(path.join(dir, APP_DB_FILE));
    db.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        title TEXT,
        status TEXT,
        auto_continues INTEGER DEFAULT 0,
        retries INTEGER DEFAULT 0,
        last_checkpoint_at INTEGER,
        current_step INTEGER DEFAULT 0,
        updated_at INTEGER,
        created_at INTEGER,
        workspace_path TEXT,
        last_progress_at INTEGER,
        original_text TEXT,
        usage_json TEXT,
        harness_id INTEGER,
        host_mark TEXT,
        last_submission_id INTEGER,
        model_source_id TEXT,
        model_id TEXT,
        thinking_level TEXT
      );
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (9);
      INSERT INTO conversations (id, title, updated_at, created_at)
        VALUES ('old-c', 'old title', 1, 1);
    `);
    db.close();
    const store = createSqliteStore(dir);
    try {
      const conv = await store.getConversation('old-c');
      assert.equal(conv.title, 'old title');
      assert.equal(conv.titleSource, 'auto');
      assert.equal(conv.titleGeneratedAt, null);
      const created = await store.createConversation({ title: 'New conversation' });
      assert.equal(created.titleSource, 'auto');
      assert.equal(created.titleGeneratedAt, null);
    } finally {
      store.close();
    }
  } finally {
    await removeTempDir(dir);
  }
});

test('PATCH title marks user source and a later run keeps it', { timeout: 30000 }, async () => {
  const dataDir = await makeTempDir('weft-title-patch-');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: TITLE_SCRIPT,
    },
  });
  try {
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'title-patch' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {});
    assert.equal(conv.status, 201);
    assert.equal(conv.body.title, 'New conversation');
    const patched = await request(srv.base, 'PATCH', `/api/conversations/${conv.body.id}`, { title: '手动标题' });
    assert.equal(patched.status, 200, patched.text);
    const named = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}`);
    assert.equal(named.body.title, '手动标题');
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, {
      text: '帮我写一个用户登录页面',
    });
    assert.equal(sent.status, 202);
    let last = null;
    for (let i = 0; i < 80; i += 1) {
      last = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}`);
      if (last.body?.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(last.body.status, 'done', srv.logs());
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}`);
    assert.equal(after.body.title, '手动标题');
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});

test('first successful done replaces the temp title from the faux title turn', { timeout: 30000 }, async () => {
  const dataDir = await makeTempDir('weft-title-gen-');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: TITLE_SCRIPT,
    },
  });
  try {
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'title-gen' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, {});
    assert.equal(conv.status, 201);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, {
      text: '帮我写一个用户登录页面',
    });
    assert.equal(sent.status, 202);
    let last = null;
    for (let i = 0; i < 80; i += 1) {
      last = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}`);
      if (last.body?.status === 'running') {
        assert.equal(last.body.title, '帮我写一个用户登录页面');
      }
      if (last.body?.status === 'done' && last.body?.title === '登录功能') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(last.body.status, 'done', srv.logs());
    assert.equal(last.body.title, '登录功能');

    const again = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, {
      text: '帮我写一个用户登录页面',
    });
    assert.equal(again.status, 202);
    for (let i = 0; i < 80; i += 1) {
      last = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}`);
      if (last.body?.status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(last.body.status, 'done', srv.logs());
    assert.equal(last.body.title, '登录功能');
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
