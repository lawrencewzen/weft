import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseSSE } from '../../src/core/sse.mjs';
import { compileSchema } from '../../src/v2/validate.ts';
import { PROTOCOL_VERSION } from '../../src/v2/version.ts';
import { createEventHub } from '../../src/v2/stream/hub.ts';
import {
  attachExtensionsTopic,
  EXTENSIONS_TOPIC,
} from '../../src/v2/stream/extensions-topic.ts';
import { phrase } from '../../src/v2/phrases/index.ts';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const TOKEN = 'v2-ext-topic-token';

function rewriteRefs(node) {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefs(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/schemas/')) {
    node.$ref = `#/$defs/${node.$ref.slice('#/components/schemas/'.length)}`;
  }
  for (const value of Object.values(node)) rewriteRefs(value);
}

function compileNamed(name) {
  const schemas = structuredClone(spec.components.schemas);
  const schema = schemas[name];
  assert.ok(schema, `missing schema ${name}`);
  rewriteRefs(schema);
  rewriteRefs(schemas);
  return compileSchema({ ...schema, $defs: schemas });
}

function assertSchema(name, data) {
  const validate = compileNamed(name);
  assert.equal(validate(data), true, `${name}: ${JSON.stringify(validate.errors)}`);
}

function assertEntityValue(entity, value) {
  if (entity === 'plugin') assertSchema('Plugin', value);
  else if (entity === 'skill') assertSchema('Skill', value);
  else if (entity === 'git_connection') assertSchema('GitConnection', value);
}

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function sendV2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? v2Headers(token) : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
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

function openEvents({ port, token, topics, lang }) {
  const query = new URLSearchParams({ topics });
  if (lang) query.set('lang', lang);
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
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parsed = parseCompleteSse(buf);
        buf = parsed.rest;
        events.push(...parsed.events);
      });
      resolve({
        req,
        res,
        events,
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', (err) => {
      const code = err && typeof err === 'object' ? err.code : '';
      if (code === 'ECONNRESET' || code === 'ABORT_ERR') return;
      reject(err);
    });
    req.end();
  });
}

async function waitEvents(session, ready, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.res.statusCode && session.res.statusCode !== 200) {
      throw new Error(`events status ${session.res.statusCode}`);
    }
    if (ready(session.events)) return session.events;
    await sleep(20);
  }
  throw new Error(`events did not match: ${JSON.stringify(session.events.map((ev) => ({ event: ev.event, id: ev.id, data: ev.data })))}`);
}

async function writePlugin(dir, id, toolName) {
  const folder = path.join(dir, id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'plugin.json'), `${JSON.stringify({
    id,
    name: id,
    description: `${id} tool`,
    version: '0.1.0',
    source: 'local',
    main: 'index.mjs',
    tools: [{ name: toolName, description: `Run ${toolName}`, parameters: { type: 'object', properties: {} } }],
  }, null, 2)}\n`);
  await writeFile(path.join(folder, 'index.mjs'), `export async function ${toolName}() {\n  return { output: '${toolName}', status: 'completed' };\n}\n`);
  return folder;
}

test('in-process extensions topic snapshots, upserts, and removes with zh/en plugin errors', async () => {
  const hub = createEventHub({ heartbeatMs: 60_000, protocolVersion: PROTOCOL_VERSION });
  const snap = {
    plugins: [{
      id: 'broken',
      name: 'Broken',
      description: '',
      version: '0.0.0',
      source: 'imported',
      enabled: true,
      loaded: false,
      error: 'tool broken_tool is not exported',
      errorCode: 'err_plugin_not_loadable',
      tools: [{ name: 'broken_tool', description: '' }],
    }],
    skills: [{
      id: 'commit-message',
      name: 'Commit messages',
      description: 'why',
      version: '1.0.0',
      source: 'bundled',
      enabled: true,
      deletable: false,
    }],
    connections: [{
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: '内网',
      kind: 'gitlab-self',
      baseUrl: 'http://127.0.0.1:9',
      token: '••••9k3q',
      hasToken: true,
      allowHttp: true,
      caFile: '',
      lastTest: { ok: false, username: '', error: 'auth_failed', at: '2026-01-01T00:00:00.000Z' },
    }],
  };
  const topic = attachExtensionsTopic(hub, {
    load: async () => structuredClone(snap),
    coalesceMs: 0,
    log() {},
  });
  try {
    const zhFrames = [];
    const zh = hub.connect({
      topics: [EXTENSIONS_TOPIC],
      lang: 'zh',
      send: (frame) => zhFrames.push(frame),
    });
    await zh.ready;
    assert.equal(topic.subscriberActive(), true);
    assert.equal(zhFrames[0].event, 'snapshot');
    assertSchema('SnapshotEvent', zhFrames[0].data);
    const pluginEnt = zhFrames[0].data.entities.find((item) => item.entity === 'plugin');
    assert.equal(pluginEnt.id, 'broken');
    assertEntityValue('plugin', pluginEnt.value);
    assert.equal(pluginEnt.value.error, phrase('zh', 'err_plugin_tool_missing', { name: 'broken_tool' }));
    const connEnt = zhFrames[0].data.entities.find((item) => item.entity === 'git_connection');
    assertEntityValue('git_connection', connEnt.value);
    assert.equal(connEnt.value.lastTest.errorText, phrase('zh', 'git_test_auth'));
    zh.close();

    const enFrames = [];
    const en = hub.connect({
      topics: [EXTENSIONS_TOPIC],
      lang: 'en',
      send: (frame) => enFrames.push(frame),
    });
    await en.ready;
    const enPlugin = enFrames[0].data.entities.find((item) => item.entity === 'plugin');
    assert.equal(enPlugin.value.error, phrase('en', 'err_plugin_tool_missing', { name: 'broken_tool' }));

    snap.plugins.push({
      id: 'echo',
      name: 'Echo',
      description: 'd',
      version: '0.1.0',
      source: 'bundled',
      enabled: true,
      loaded: true,
      error: null,
      errorCode: null,
      tools: [{ name: 'echo', description: 'Return text' }],
    });
    topic.notify();
    const started = Date.now();
    while (Date.now() - started < 2000) {
      if (enFrames.some((frame) => frame.event === 'upsert' && frame.data.entity === 'plugin' && frame.data.id === 'echo')) break;
      await sleep(20);
    }
    const created = enFrames.find((frame) => frame.event === 'upsert' && frame.data.entity === 'plugin' && frame.data.id === 'echo');
    assert.ok(created, JSON.stringify(enFrames.map((frame) => ({ event: frame.event, data: frame.data }))));
    assertEntityValue('plugin', created.data.value);
    assert.equal(created.data.value.error, null);

    snap.connections = [];
    topic.notify();
    const rmAt = Date.now();
    while (Date.now() - rmAt < 2000) {
      if (enFrames.some((frame) => frame.event === 'remove' && frame.data.entity === 'git_connection')) break;
      await sleep(20);
    }
    assert.equal(enFrames.some((frame) => (
      frame.event === 'remove'
      && frame.data.entity === 'git_connection'
      && frame.data.id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    )), true);
    en.close();
    assert.equal(topic.subscriberActive(), false);
  } finally {
    topic.dispose();
    hub.dispose();
  }
});

test('subscribe extensions: v2 and legacy mutations upsert and remove', { timeout: 60_000 }, async () => {
  const src = await mkdtemp(path.join(tmpdir(), 'weft-v2-ext-topic-'));
  const folder = await writePlugin(src, 'word-count', 'word_count');
  const srv = await startServer({ token: TOKEN, env: { WEFT_LLM: 'faux' } });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const session = await openEvents({
      port: srv.port,
      token: discovery.token,
      topics: EXTENSIONS_TOPIC,
      lang: 'zh',
    });
    await waitEvents(session, (list) => list.some((ev) => ev.event === 'snapshot'));
    const snap = session.events.find((ev) => ev.event === 'snapshot');
    assertSchema('SnapshotEvent', snap.data);
    const echo = snap.data.entities.find((item) => item.entity === 'plugin' && item.id === 'echo');
    assert.ok(echo);
    assertEntityValue('plugin', echo.value);
    const builtin = snap.data.entities.find((item) => item.entity === 'skill' && item.id === 'commit-message');
    assert.ok(builtin);
    assertEntityValue('skill', builtin.value);

    const imported = await sendV2(srv.base, 'POST', '/api/v2/plugins', discovery.token, { path: folder });
    assert.equal(imported.status, 201, imported.text);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'plugin' && ev.data.id === 'word-count'
    )));
    const pluginUpsert = session.events.find((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'plugin' && ev.data.id === 'word-count'
    ));
    assertEntityValue('plugin', pluginUpsert.data.value);
    assert.equal(pluginUpsert.data.value.enabled, true);

    const off = await request(srv.base, 'PUT', '/api/plugins/word-count', { enabled: false }, TOKEN);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert'
      && ev.data.entity === 'plugin'
      && ev.data.id === 'word-count'
      && ev.data.value?.enabled === false
    )));

    const skill = await sendV2(srv.base, 'POST', '/api/v2/skills', discovery.token, {
      name: '发布检查',
      description: '发版前',
      body: '先看测试再发版。',
    });
    assert.equal(skill.status, 201, skill.text);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'skill' && ev.data.id === skill.body.id
    )));
    const skillUpsert = session.events.find((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'skill' && ev.data.id === skill.body.id
    ));
    assertEntityValue('skill', skillUpsert.data.value);

    const removedSkill = await sendV2(srv.base, 'DELETE', `/api/v2/skills/${skill.body.id}`, discovery.token, {});
    assert.equal(removedSkill.status, 200, removedSkill.text);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'remove' && ev.data.entity === 'skill' && ev.data.id === skill.body.id
    )));

    const conn = await request(srv.base, 'POST', '/api/git/connections', {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: 'http://127.0.0.1:9',
      token: 'glpat-topic-secret-9k3q',
      allowHttp: true,
    }, TOKEN);
    assert.equal(conn.status, 201, JSON.stringify(conn.body));
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'git_connection' && ev.data.id === conn.body.id
    )));
    const connUpsert = session.events.find((ev) => (
      ev.event === 'upsert' && ev.data.entity === 'git_connection' && ev.data.id === conn.body.id
    ));
    assertEntityValue('git_connection', connUpsert.data.value);
    assert.equal(JSON.stringify(connUpsert.data.value).includes('glpat-topic-secret-9k3q'), false);
    assert.equal(connUpsert.data.value.token, '••••9k3q');

    const gone = await sendV2(srv.base, 'DELETE', `/api/v2/git/connections/${conn.body.id}`, discovery.token, {});
    assert.equal(gone.status, 200, gone.text);
    await waitEvents(session, (list) => list.some((ev) => (
      ev.event === 'remove' && ev.data.entity === 'git_connection' && ev.data.id === conn.body.id
    )));
    session.close();
  } finally {
    await stopServer(srv);
  }
});
