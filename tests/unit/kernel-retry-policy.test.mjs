// T109: model-call retry defaults. Backoff is Pi Durable's; this file does not sleep the 5 minute schedule.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableAssistantError, retryDelayMs } from '@earendil-works/pi-ai/utils/retry';
import { DEFAULT_RETRY_POLICY } from '@earendil-works/pi-durable';
import { parseSSE } from '../../src/core/sse.mjs';
import { kernelSettings } from '../../src/kernel/conversations.mjs';
import {
  createMapContext,
  createViewProjector,
  projectViewUpdate,
  statusFromSubmission,
} from '../../src/kernel/events.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const TOKEN = 'unit-kernel-retry-token';
const call = (base, method, apiPath, body) => request(base, method, apiPath, body, TOKEN);

function mergedRetry(env) {
  return { ...DEFAULT_RETRY_POLICY, ...kernelSettings(env).retry };
}

/** Delays Pi Durable sleeps after failed attempts 1..maxRetries. The last attempt does not sleep. */
function backoffDelays(policy) {
  const delays = [];
  for (let attempt = 1; attempt <= policy.maxRetries; attempt += 1) {
    delays.push(retryDelayMs(policy, attempt));
  }
  return delays;
}

test('default retry waits about five minutes; env overrides keep the same meaning', () => {
  const settings = kernelSettings({});
  assert.equal(settings.retry.enabled, true);
  assert.equal(settings.retry.baseDelayMs, 2000);
  assert.equal(settings.retry.maxRetries, 9);
  assert.equal(Object.hasOwn(settings.retry, 'maxAgentDelayMs'), false);
  assert.equal(settings.stream.timeoutMs, 120_000);

  const policy = mergedRetry({});
  assert.equal(policy.maxAgentDelayMs, DEFAULT_RETRY_POLICY.maxAgentDelayMs);
  assert.equal(policy.maxAgentDelayMs, 60_000);
  const delays = backoffDelays(policy);
  assert.deepEqual(delays, [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
  assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 302_000);
  // The 6th retry would be 64000 without the cap. maxAgentDelayMs limits that sleep.
  assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 6), 60_000);
  assert.equal(retryDelayMs(policy, 6), 60_000);

  const overridden = kernelSettings({ WEFT_RETRY_MAX: '4', WEFT_RETRY_BASE_MS: '50' });
  assert.equal(overridden.retry.maxRetries, 3);
  assert.equal(overridden.retry.baseDelayMs, 50);
  assert.deepEqual(backoffDelays(mergedRetry({ WEFT_RETRY_MAX: '4', WEFT_RETRY_BASE_MS: '50' })), [50, 100, 200]);
  assert.equal(kernelSettings({ WEFT_RETRY_MAX: '1' }).retry.maxRetries, 0);
  assert.equal(kernelSettings({ WEFT_RETRY_MAX: '0', WEFT_RETRY_BASE_MS: 'nope' }).retry.maxRetries, 9);
  assert.equal(kernelSettings({ WEFT_RETRY_MAX: '0', WEFT_RETRY_BASE_MS: 'nope' }).retry.baseDelayMs, 2000);
  assert.equal(kernelSettings({ WEFT_STREAM_TIMEOUT_MS: '150' }).stream.timeoutMs, 150);
  assert.equal(kernelSettings({ WEFT_STREAM_TIMEOUT_MS: '0' }).stream.timeoutMs, 120_000);
});

test('official classifier does not retry 400 or 401; quota text beats 429', () => {
  const samples = [
    ['400 Bad Request', false],
    ['400 invalid_request_error', false],
    ['HTTP 400', false],
    ['401 Unauthorized', false],
    ['401 Incorrect API key', false],
    ['403 Forbidden', false],
    ['404 Not Found', false],
    ['429 Too Many Requests', true],
    ['429 insufficient_quota', false],
    ['500 Internal Server Error', true],
    ['503 Service Unavailable', true],
    ['terminated', true],
    ['fetch failed', true],
    ['socket hang up', true],
    ['network error', true],
    ['Request timed out after 150ms', true],
    ['ECONNRESET', false],
    ['ETIMEDOUT', false],
    ['billing', false],
    ['quota exceeded', false],
  ];
  for (const [errorMessage, retryable] of samples) {
    assert.equal(
      isRetryableAssistantError({ stopReason: 'error', errorMessage }),
      retryable,
      errorMessage,
    );
  }
});

test('each generation retry emits one retry event; the cap still applies to the displayed delay', () => {
  const retry = kernelSettings({ WEFT_RETRY_BASE_MS: '2000', WEFT_RETRY_MAX: '4' }).retry;
  const ctx = createMapContext({ retry });
  const projector = createViewProjector();
  const user = {
    id: 1,
    kind: 'pi.user',
    model: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  };
  const view = (attempt, error) => ({
    entries: [user],
    docs: {
      'pi.live': {
        run: { taskId: 4, inputs: [9], turns: 0 },
        generation: { attempt, retry: { at: attempt, error } },
      },
    },
  });
  assert.deepEqual(projectViewUpdate(projector, { entries: [user], docs: {} }, ctx).events, []);
  const first = projectViewUpdate(projector, view(1, 'terminated'), ctx);
  const again = projectViewUpdate(projector, view(1, 'terminated'), ctx);
  projectViewUpdate(projector, {
    entries: [user],
    docs: {
      'pi.live': {
        run: { taskId: 4, inputs: [9], turns: 0 },
        generation: { attempt: 2 },
      },
    },
  }, ctx);
  const second = projectViewUpdate(projector, view(2, 'fetch failed'), ctx);
  const third = projectViewUpdate(projector, view(3, '503 Service Unavailable'), ctx);
  assert.deepEqual(again.events, []);
  assert.deepEqual(
    [first, second, third].map((update) => update.events.filter((ev) => ev.event === 'retry').map((ev) => ev.data)),
    [
      [{ attempt: 1, delayMs: 2000, reason: 'terminated' }],
      [{ attempt: 2, delayMs: 4000, reason: 'fetch failed' }],
      [{ attempt: 3, delayMs: 8000, reason: '503 Service Unavailable' }],
    ],
  );

  const capped = createMapContext({
    retry: kernelSettings({ WEFT_RETRY_BASE_MS: '50000', WEFT_RETRY_MAX: '3' }).retry,
  });
  const capProjector = createViewProjector();
  projectViewUpdate(capProjector, { entries: [user], docs: {} }, capped);
  const shown = projectViewUpdate(capProjector, view(2, 'terminated'), capped);
  assert.equal(shown.events.find((ev) => ev.event === 'retry').data.delayMs, 60_000);
});

function parseChunk(part) {
  return parseSSE(`${part}\n\n`).filter((ev) => ev.event);
}

async function watchSse(base, cid, timeout = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const res = await fetch(`${base}/api/conversations/${cid}/events`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
    signal: ctrl.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  let opened;
  const open = new Promise((resolve) => { opened = resolve; });
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          if (!part.trim() || part.trim() === ':') continue;
          events.push(...parseChunk(part));
        }
        if (events.length) opened();
      }
    } catch (err) {
      if (err?.name !== 'AbortError') throw err;
    } finally {
      opened();
    }
  })();
  return {
    events,
    opened: open,
    async stop() {
      clearTimeout(timer);
      ctrl.abort();
      try { await reader.cancel(); } catch { /* already closed */ }
      await pump;
    },
  };
}

async function openConversation(base, title) {
  const ws = await call(base, 'POST', '/api/workspaces', { name: 'retry-ws' });
  assert.equal(ws.status, 201, JSON.stringify(ws.body));
  const conv = await call(base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title });
  assert.equal(conv.status, 201, JSON.stringify(conv.body));
  return conv.body;
}

async function waitStatus(base, id, accept, timeoutMs = 20_000) {
  const started = Date.now();
  let body = null;
  while (Date.now() - started < timeoutMs) {
    const got = await call(base, 'GET', `/api/conversations/${id}`);
    body = got.body;
    if (accept(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return body;
}

async function writeScript(turns) {
  const dir = await mkdtemp(path.join(tmpdir(), 'piw-retry-script-'));
  const script = path.join(dir, 'script.json');
  await writeFile(script, JSON.stringify({ turns }));
  return { dir, script };
}

test('several retryable failures then recover in the same turn, one answer', { timeout: 20_000 }, async () => {
  const { dir, script } = await writeScript([
    { error: 'terminated' },
    { error: 'fetch failed' },
    { error: '503 Service Unavailable' },
    { text: 'recovered-once' },
  ]);
  const baseDelayMs = 30;
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_RETRY_BASE_MS: String(baseDelayMs),
      WEFT_RETRY_MAX: '4',
    },
  });
  try {
    const conv = await openConversation(srv.base, 'recover');
    const watch = await watchSse(srv.base, conv.id);
    await watch.opened;
    const sent = await call(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'please-recover' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const body = await waitStatus(srv.base, conv.id, (row) => row.status === 'done' || row.status === 'failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await watch.stop();
    assert.equal(body.status, 'done', `${srv.logs()}\n${JSON.stringify(body)}`);
    const users = body.messages.filter((message) => message.role === 'user');
    const assistants = body.messages.filter((message) => message.role === 'assistant');
    assert.deepEqual(users.map((message) => message.text), ['please-recover']);
    assert.deepEqual(assistants.map((message) => message.text), ['recovered-once']);
    const policy = mergedRetry({ WEFT_RETRY_BASE_MS: String(baseDelayMs), WEFT_RETRY_MAX: '4' });
    const retries = watch.events.filter((ev) => ev.event === 'retry');
    assert.deepEqual(retries.map((ev) => ({
      attempt: ev.data.attempt,
      delayMs: ev.data.delayMs,
      reason: ev.data.reason,
    })), [1, 2, 3].map((attempt, index) => ({
      attempt,
      delayMs: retryDelayMs(policy, attempt),
      reason: ['terminated', 'fetch failed', '503 Service Unavailable'][index],
    })));
    assert.deepEqual([1, 2, 3].map((attempt) => retryDelayMs(policy, attempt)), [30, 60, 120]);
  } finally {
    await stopServer(srv);
    await rm(dir, { recursive: true, force: true });
  }
});

test('exhausted retries fail the run as model_error; v2 canContinue is true', { timeout: 20_000 }, async () => {
  // Kernel status stays code/reason/detail. canContinue is a v2 view field.
  const failed = statusFromSubmission({
    status: 'unanswered',
    reason: 'model_error',
    detail: '503 Service Unavailable',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.llmError.code, 'E_LLM');
  assert.equal(Object.hasOwn(failed, 'canContinue'), false);
  assert.equal(Object.hasOwn(failed.llmError, 'retry'), false);

  const { dir, script } = await writeScript([
    { error: '503 Service Unavailable' },
    { error: '503 Service Unavailable' },
    { error: '503 Service Unavailable' },
    { text: 'should-not-answer' },
  ]);
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_RETRY_BASE_MS: '20',
      WEFT_RETRY_MAX: '3',
    },
  });
  try {
    const conv = await openConversation(srv.base, 'exhaust');
    const watch = await watchSse(srv.base, conv.id);
    await watch.opened;
    const sent = await call(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: 'please-fail' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const body = await waitStatus(srv.base, conv.id, (row) => row.status === 'done' || row.status === 'failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await watch.stop();
    assert.equal(body.status, 'failed', `${srv.logs()}\n${JSON.stringify(body)}`);
    assert.equal(body.llmError.code, 'E_LLM');
    assert.equal(body.llmError.reason, 'model_error');
    assert.match(body.llmError.detail, /503 Service Unavailable/);
    assert.equal(body.llmError.message, undefined);
    assert.equal(body.llmError.retry, undefined);
    assert.equal(Object.hasOwn(body, 'canContinue'), false);
    assert.equal(JSON.stringify(body).includes('canContinue'), false);
    assert.equal(body.messages.some((message) => message.text === 'should-not-answer'), false);
    assert.deepEqual(body.messages.filter((message) => message.role === 'user').map((message) => message.text), ['please-fail']);
    const policy = mergedRetry({ WEFT_RETRY_BASE_MS: '20', WEFT_RETRY_MAX: '3' });
    const retries = watch.events.filter((ev) => ev.event === 'retry');
    assert.deepEqual(retries.map((ev) => ev.data.attempt), [1, 2]);
    assert.deepEqual(retries.map((ev) => ev.data.delayMs), [1, 2].map((attempt) => retryDelayMs(policy, attempt)));

    const discovery = await readDiscovery(srv.dataDir);
    const res = await fetch(`${srv.base}/api/v2/conversations/${conv.id}`, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    const snap = await res.json();
    assert.equal(res.status, 200, JSON.stringify(snap));
    const run = snap.conversation.run;
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'E_LLM');
    assert.equal(run.error.message, '模型请求失败：503 Service Unavailable');
    assert.equal(run.error.canContinue, true);
    assert.equal(run.error.retry, undefined);
    assert.equal(Object.hasOwn(run, 'canContinue'), false);
    assert.equal(snap.conversation.status, 'failed');
  } finally {
    await stopServer(srv);
    await rm(dir, { recursive: true, force: true });
  }
});

test('400 and 401 fail on the first attempt and are not backed off', { timeout: 20_000 }, async () => {
  const cases = [
    { text: 'please-400', error: '400 Bad Request', success: 'should-not-answer-400' },
    { text: 'please-401', error: '401 Unauthorized', success: 'should-not-answer-401' },
  ];
  const { dir, script } = await writeScript(cases.flatMap((item) => ([
    { when: item.text, error: item.error },
    { when: item.text, text: item.success },
  ])));
  const baseDelayMs = 8000;
  const srv = await startServer({
    token: TOKEN,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_RETRY_BASE_MS: String(baseDelayMs),
      WEFT_RETRY_MAX: '6',
    },
  });
  try {
    for (const item of cases) {
      const conv = await openConversation(srv.base, item.text);
      const watch = await watchSse(srv.base, conv.id);
      await watch.opened;
      const started = Date.now();
      const sent = await call(srv.base, 'POST', `/api/conversations/${conv.id}/messages`, { text: item.text });
      assert.equal(sent.status, 202, JSON.stringify(sent.body));
      const body = await waitStatus(srv.base, conv.id, (row) => row.status === 'done' || row.status === 'failed');
      const elapsed = Date.now() - started;
      await watch.stop();
      assert.equal(body.status, 'failed', `${item.error}\n${srv.logs()}\n${JSON.stringify(body)}`);
      assert.equal(body.llmError.code, 'E_LLM');
      assert.match(body.llmError.detail, new RegExp(item.error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(body.llmError.message, undefined);
      assert.equal(body.messages.some((message) => message.text === item.success), false);
      assert.deepEqual(watch.events.filter((ev) => ev.event === 'retry'), []);
      assert.equal(elapsed < baseDelayMs, true, `${item.error} took ${elapsed}ms`);
    }
  } finally {
    await stopServer(srv);
    await rm(dir, { recursive: true, force: true });
  }
});
