import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../../src/core/sse.mjs';
import { createRegistry } from '@earendil-works/pi-durable';
import {
  ASK_ANSWER_KIND,
  ASK_WAITING_TEXT,
  askByToolCall,
  buildAskSubmission,
  formatAskContent,
  validateAskArgs,
} from '../../src/kernel/ask.mjs';
import { messagesFromEntries } from '../../src/kernel/events.mjs';
import { harnessSqlitePath } from '../../src/kernel/migrate-weft-ids.mjs';
import { createPluginHost, mapPluginResult } from '../../src/kernel/plugins.mjs';
import { AUTO_CONTINUE_PREFIX } from '../../src/kernel/continuation-text.mjs';
import { formatSubagentReport } from '../../src/kernel/subagent-report.mjs';
import { CHILD_HIDDEN_TOOLS } from '../../src/kernel/subagents.mjs';
import { ask_user_question } from '../../plugins/ask/index.mjs';
import { compileSchema, validateResponse } from '../../src/v2/validate.ts';
import { toolCallView } from '../../src/v2/views/tools.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'ask-plugin-token';
const ONE = {
  question: '用哪种包管理器？',
  header: '包管理器',
  multiSelect: false,
  options: [
    { label: 'npm', description: 'Node 自带' },
    { label: 'pnpm', description: '节省磁盘' },
  ],
};
const TWO = {
  question: '还要补充什么？',
  header: '补充',
  multiSelect: false,
  options: [
    { label: '没有', description: '就这些' },
    { label: '有', description: '另说' },
  ],
};

function option(label) {
  return { label, description: `${label} 说明` };
}

function question(extra = {}) {
  return {
    question: '选一个',
    header: '标题',
    multiSelect: false,
    options: [option('甲'), option('乙')],
    ...extra,
  };
}

function userEntry(id, text) {
  return { id, kind: 'pi.user', model: [{ role: 'user', content: text }] };
}

function askEntries(extra = []) {
  return [
    userEntry(1, 'hi'),
    {
      id: 2,
      kind: 'pi.assistant',
      model: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'ask-1', name: 'ask_user_question', arguments: { questions: [ONE] } }],
      }],
    },
    {
      id: 3,
      kind: 'pi.tool-result',
      model: [{
        toolCallId: 'ask-1',
        toolName: 'ask_user_question',
        isError: false,
        content: [{ type: 'text', text: ASK_WAITING_TEXT }],
        details: { questions: [ONE] },
      }],
    },
    ...extra,
  ];
}

function viewOf(entries) {
  const message = messagesFromEntries(entries).messages.find((row) => row.tool?.name === 'ask_user_question');
  assert.ok(message, 'missing ask tool message');
  return toolCallView(message.tool, [message.tool], { lang: 'zh' });
}

test('plugin bridge passes details and terminate and keeps old results', async () => {
  const plain = mapPluginResult({ output: 'pong', status: 'completed' });
  assert.deepEqual(plain.output, [{ type: 'text', text: 'pong' }]);
  assert.equal(plain.isError, false);
  assert.equal(Object.hasOwn(plain, 'details'), false);
  assert.equal(Object.hasOwn(plain, 'control'), false);
  assert.deepEqual(mapPluginResult('echo'), {
    output: [{ type: 'text', text: 'echo' }],
    isError: false,
  });

  const passed = mapPluginResult({
    output: 'wait',
    status: 'completed',
    details: { questions: [{ question: 'q' }] },
    terminate: true,
  });
  assert.equal(passed.isError, false);
  assert.deepEqual(passed.details, { questions: [{ question: 'q' }] });
  assert.deepEqual(passed.control, { terminate: true });

  const errored = mapPluginResult({
    output: 'no',
    status: 'error',
    details: { a: 1 },
    terminate: true,
  });
  assert.equal(errored.isError, true);
  assert.equal(errored.control, undefined);
  assert.deepEqual(errored.details, { a: 1 });

  const huge = mapPluginResult({
    output: 'x',
    details: { blob: 'a'.repeat(70_000) },
    terminate: true,
  });
  assert.equal(huge.isError, true);
  assert.match(huge.output[0].text, /64KB/);
  assert.equal(huge.control, undefined);

  const bad = mapPluginResult({ output: 'x', details: { cycle: null }, terminate: true });
  bad.details = null;
  const circular = {};
  circular.self = circular;
  const rejected = mapPluginResult({ output: 'x', details: circular, terminate: true });
  assert.equal(rejected.isError, true);
  assert.match(rejected.output[0].text, /JSON/);

  const registry = createRegistry();
  const host = createPluginHost({
    registry,
    store: { async getConversation() { return null; } },
    byHarness: new Map(),
    extensions: {
      async pluginTools() {
        return [{
          name: 'demo_tool',
          description: 'demo',
          handler: async () => ({
            output: 'ok',
            status: 'completed',
            details: { n: 1 },
            terminate: true,
          }),
        }];
      },
    },
  });
  await host.refresh();
  const found = registry.snapshot().tools().find((item) => item.tool.name === 'demo_tool');
  const result = await found.tool.execute({}, { conversationId: 1 }, {});
  assert.deepEqual(result.details, { n: 1 });
  assert.deepEqual(result.control, { terminate: true });
  assert.equal(result.isError, false);
});

test('ask_user_question checks question count, option count, and header length', async () => {
  const ok = validateAskArgs({ questions: [question(), { ...question(), header: '一二三四五六七八九十十二', multiSelect: true, options: [option('甲'), option('乙'), option('丙'), option('丁')] }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.questions.length, 2);
  assert.equal([...ok.questions[1].header].length, 12);

  assert.match(validateAskArgs({ questions: [] }).error, /1 to 4/);
  assert.match(validateAskArgs({ questions: [question(), question(), question(), question(), question()] }).error, /1 to 4/);
  assert.match(validateAskArgs({ questions: [question({ options: [option('甲')] })] }).error, /2 to 4/);
  assert.match(validateAskArgs({ questions: [question({ options: [option('甲'), option('乙'), option('丙'), option('丁'), option('戊')] })] }).error, /2 to 4/);
  assert.match(validateAskArgs({ questions: [question({ header: '一二三四五六七八九十十二三' })] }).error, /12/);
  assert.match(validateAskArgs({ questions: [question({ options: [option('其他'), option('乙')] })] }).error, /Other/);
  assert.match(validateAskArgs({ questions: [question({ options: [option('Other'), option('乙')] })] }).error, /Other/);

  const good = await ask_user_question({ questions: [ONE, TWO] });
  assert.equal(good.status, 'completed');
  assert.equal(good.terminate, true);
  assert.equal(good.output, ASK_WAITING_TEXT);
  assert.equal(good.details.questions.length, 2);
  const bridged = mapPluginResult(good);
  assert.deepEqual(bridged.control, { terminate: true });
  assert.equal(bridged.isError, false);

  const badCall = await ask_user_question({ questions: [question({ header: 'this header is too long' })] });
  assert.equal(badCall.status, 'error');
  assert.equal(badCall.terminate, undefined);
  assert.match(badCall.output, /12/);

  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'plugins/ask/plugin.json'), 'utf8'));
  const description = manifest.tools[0].description;
  assert.ok(description.length <= 500, String(description.length));
  assert.match(description, /do not add an Other/i);
  assert.match(description, /end this turn/i);
  assert.match(description, /不要在同一批里调用其他工具/);
  assert.match(description, /same batch/);
});

test('child agents do not keep ask_user_question', () => {
  assert.equal(CHILD_HIDDEN_TOOLS.has('ask_user_question'), true);
  assert.equal(CHILD_HIDDEN_TOOLS.has('echo'), false);
  assert.equal(CHILD_HIDDEN_TOOLS.has('read'), false);
});

test('answer text names each question, and the view backfills or skips', () => {
  const picked = formatAskContent([ONE, TWO], {
    answers: [
      { questionIndex: 0, selected: ['pnpm'] },
      { questionIndex: 1, selected: [], other: '先别改锁文件' },
    ],
    skipped: false,
  });
  assert.match(picked, /1\. 用哪种包管理器？/);
  assert.match(picked, /回答：pnpm/);
  assert.match(picked, /2\. 还要补充什么？/);
  assert.match(picked, /其他：先别改锁文件/);

  const skipped = formatAskContent([ONE], { answers: [], skipped: true });
  assert.match(skipped, /用户跳过/);
  assert.match(skipped, /用哪种包管理器？/);

  const pending = viewOf(askEntries());
  assert.equal(pending.kind, 'ask');
  assert.equal(pending.ask.answer, null);
  assert.equal(pending.ask.questions[0].header, '包管理器');
  assert.equal(pending.heading.title, '包管理器');

  const answered = viewOf(askEntries([{
    id: 4,
    kind: ASK_ANSWER_KIND,
    data: {
      toolCallId: 'ask-1',
      answers: [{ questionIndex: 0, selected: ['pnpm'] }],
      skipped: false,
    },
    model: [{ role: 'user', content: picked }],
  }]));
  assert.equal(answered.ask.answer.skipped, false);
  assert.deepEqual(answered.ask.answer.answers[0].selected, ['pnpm']);

  const ignored = viewOf(askEntries([userEntry(4, '先别问了，直接用 npm')]));
  assert.deepEqual(ignored.ask.answer, { answers: [], skipped: true });

  const reported = viewOf(askEntries([
    userEntry(4, formatSubagentReport({ name: 'scout', kind: 'answered', body: 'done the scan' })),
  ]));
  assert.equal(reported.ask.answer, null);
  const continued = viewOf(askEntries([userEntry(4, `${AUTO_CONTINUE_PREFIX} more`)]));
  assert.equal(continued.ask.answer, null);

  const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
  const validateToolCall = compileSchema(structuredClone(spec.components.schemas.ToolCall));
  for (const view of [pending, answered, ignored]) {
    assert.equal(validateToolCall(view), true, JSON.stringify(validateToolCall.errors));
  }
});

test('submitting an answer records weft.ask-answer, fills the view, and rejects a repeat', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ask-'));
  const scriptPath = path.join(dataDir, 'ask.json');
  const recordPath = path.join(dataDir, 'requests.jsonl');
  await writeFile(scriptPath, JSON.stringify({
    turns: [
      {
        text: '先问一下。',
        tool: 'ask_user_question',
        id: 'ask-1',
        args: { questions: [ONE] },
      },
      { text: 'ASK_CONTINUE_OK' },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_FAUX_RECORD: recordPath,
      WEFT_RETRY_MAX: '2',
    },
  });
  try {
    const discovery = await readDiscovery(dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'ask' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'ask' }, TOKEN);
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: '请提问' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));

    let asked = null;
    for (let i = 0; i < 80; i += 1) {
      const got = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}`, undefined, TOKEN);
      asked = got.body;
      const tool = (asked.messages || []).find((row) => row.tool?.name === 'ask_user_question');
      if ((asked.status === 'done' || asked.status === 'failed') && tool) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(asked.status, 'done', JSON.stringify(asked));
    const texts = (asked.messages || []).filter((row) => row.role === 'assistant').map((row) => row.text || '');
    assert.equal(texts.includes('ASK_CONTINUE_OK'), false, JSON.stringify(texts));
    const tool = asked.messages.find((row) => row.tool?.name === 'ask_user_question');
    assert.match(tool.tool.output || '', /已向用户提问，等待回答，不要继续/);
    assert.equal(tool.tool.ask.answer, null);
    const before = (await readFile(recordPath, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(before.length, 1, before.join('\n'));

    const missing = await postV2(srv.base, `/api/v2/conversations/${conv.body.id}/messages`, discovery.token, {
      answer: { toolCallId: 'missing', answers: [] },
    });
    assert.equal(missing.status, 400, missing.text);
    assert.equal(missing.body.code, 'E_BAD_REQUEST');

    const posted = await postV2(srv.base, `/api/v2/conversations/${conv.body.id}/messages`, discovery.token, {
      answer: {
        toolCallId: 'ask-1',
        answers: [{ questionIndex: 0, selected: ['pnpm'] }],
      },
    });
    assert.equal(posted.status, 202, posted.text);

    let continued = null;
    for (let i = 0; i < 80; i += 1) {
      const got = await request(srv.base, 'GET', `/api/conversations/${conv.body.id}`, undefined, TOKEN);
      continued = got.body;
      const assistant = (continued.messages || []).some((row) => row.role === 'assistant' && String(row.text || '').includes('ASK_CONTINUE_OK'));
      if (continued.status === 'done' && assistant) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const continuedText = (continued.messages || []).filter((row) => row.role === 'assistant').map((row) => row.text || '');
    assert.equal(continuedText.includes('ASK_CONTINUE_OK'), true, JSON.stringify(continuedText));
    const after = (await readFile(recordPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(after.length, 2, JSON.stringify(after));
    assert.match(after[1].users.join('\n'), /用哪种包管理器？/);
    assert.match(after[1].users.join('\n'), /回答：pnpm/);

    const snap = await getV2(srv.base, `/api/v2/conversations/${conv.body.id}`, discovery.token);
    assert.equal(snap.status, 200, snap.text);
    const checked = validateResponse(`/api/v2/conversations/${conv.body.id}`, 'GET', 200, snap.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    const call = snap.body.tools.find((item) => item.id === 'ask-1');
    assert.ok(call, JSON.stringify(snap.body.tools.map((item) => item.id)));
    assert.equal(call.kind, 'ask');
    assert.equal(call.ask.answer.skipped, false);
    assert.deepEqual(call.ask.answer.answers[0].selected, ['pnpm']);

    const kinds = entryKinds(dataDir);
    assert.equal(kinds.includes(ASK_ANSWER_KIND), true, JSON.stringify(kinds));

    const again = await postV2(srv.base, `/api/v2/conversations/${conv.body.id}/messages`, discovery.token, {
      answer: {
        toolCallId: 'ask-1',
        answers: [{ questionIndex: 0, selected: ['npm'] }],
      },
    });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.code, 'E_ASK_ANSWERED');
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a subscribed conversation topic receives ask questions without a page refresh', { timeout: 40_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-ask-live-'));
  const scriptPath = path.join(dataDir, 'ask.json');
  await writeFile(scriptPath, JSON.stringify({
    turns: [
      {
        text: '先问一下。',
        tool: 'ask_user_question',
        id: 'ask-1',
        args: { questions: [ONE] },
      },
      { text: 'ASK_CONTINUE_OK' },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: scriptPath, WEFT_RETRY_MAX: '2' },
  });
  let session = null;
  try {
    const discovery = await readDiscovery(dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'ask-live' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'ask-live' }, TOKEN);
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    session = await openTopic(srv.port, discovery.token, `conversation:${conv.body.id}`);
    await waitTopic(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: '请提问' }, TOKEN);
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const events = await waitTopic(session, (list) => list.some((ev) => askQuestionsOf(ev)), 20000);
    const hit = [...events].reverse().find((ev) => askQuestionsOf(ev));
    assert.ok(hit, 'topic never upserted the question');
    assert.equal(hit.event, 'upsert');
    assert.equal(hit.data.entity, 'tool');
    assert.equal(hit.data.value.kind, 'ask');
    assert.equal(hit.data.value.ask.questions[0].question, ONE.question);
    assert.equal(hit.data.value.ask.answer, null);
  } finally {
    session?.close();
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

function askQuestionsOf(ev) {
  return ev?.event === 'upsert'
    && ev.data?.entity === 'tool'
    && ev.data?.value?.ask?.questions?.[0]?.question === ONE.question;
}

function parseCompleteSse(buf) {
  const parts = String(buf).split('\n\n');
  const rest = parts.pop() || '';
  const events = [];
  for (const part of parts) {
    if (!part.trim() || part.trim() === ':') continue;
    events.push(...parseSSE(`${part}\n\n`));
  }
  return { events, rest };
}

function openTopic(port, token, topics) {
  const query = new URLSearchParams({ topics });
  return new Promise((resolve, reject) => {
    let buf = '';
    const events = [];
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: `/api/v2/events?${query.toString()}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`events ${res.statusCode}`));
        res.resume();
        return;
      }
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parsed = parseCompleteSse(buf);
        buf = parsed.rest;
        events.push(...parsed.events);
      });
      resolve({
        events,
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitTopic(session, ready, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ready(session.events)) return session.events;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`topic did not match: ${JSON.stringify(session.events.map((ev) => ev.event))}`);
}

function entryKinds(dataDir) {
  const db = new DatabaseSync(harnessSqlitePath(dataDir), { readOnly: true, timeout: 5000 });
  try {
    return db.prepare("SELECT json_extract(record, '$.kind') AS kind FROM entries").all().map((row) => row.kind);
  } finally {
    db.close();
  }
}

async function postV2(base, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

test('buildAskSubmission rejects a second answer for the same tool call', () => {
  const first = buildAskSubmission(askEntries(), {
    toolCallId: 'ask-1',
    answers: [{ questionIndex: 0, selected: ['pnpm'] }],
  });
  assert.equal(first.ok, true);
  assert.equal(first.entry.kind, ASK_ANSWER_KIND);
  assert.match(first.content, /回答：pnpm/);
  const stored = askEntries([{ id: 4, ...first.entry, model: [{ role: 'user', content: first.content }] }]);
  assert.equal(askByToolCall(stored).get('ask-1').answer.answers[0].selected[0], 'pnpm');
  const again = buildAskSubmission(stored, {
    toolCallId: 'ask-1',
    answers: [{ questionIndex: 0, selected: ['npm'] }],
  });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(again.code, 'E_ASK_ANSWERED');
  const unknown = buildAskSubmission(askEntries(), { toolCallId: 'nope', answers: [] });
  assert.equal(unknown.status, 400);
  const skipped = buildAskSubmission(askEntries([userEntry(4, '先用 npm')]), {
    toolCallId: 'ask-1',
    answers: [{ questionIndex: 0, selected: ['pnpm'] }],
  });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.status, 409);
  assert.equal(skipped.code, 'E_ASK_ANSWERED');
  const afterReport = buildAskSubmission(askEntries([
    userEntry(4, formatSubagentReport({ name: 'scout', kind: 'answered', body: 'done the scan' })),
  ]), {
    toolCallId: 'ask-1',
    answers: [{ questionIndex: 0, selected: ['pnpm'] }],
  });
  assert.equal(afterReport.ok, true);
});
