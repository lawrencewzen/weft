import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffChangeRows, pickTurnAnchor, turnChangesItemId } from '../../src/kernel/turn-changes.mjs';
import { compileSchema, validateResponse } from '../../src/v2/validate.ts';
import { buildThread } from '../../src/v2/views/thread.ts';
import { conversationSnapshot } from '../../src/v2/views/conversation.ts';
import { agentShellKind } from '../../src/platform/win/shell.mjs';
import { ROOT } from './_root.mjs';
import { readDiscovery, request, startServer, stopServer } from './_server.mjs';

const execFileP = promisify(execFile);
const TOKEN = 'turn-changes-token';
const spec = JSON.parse(await readFile(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateThreadItem = compileSchema(structuredClone(spec.components.schemas.ThreadItem));

function change(pathName, added, removed, extra = {}) {
  return {
    path: pathName,
    added,
    removed,
    error: null,
    by: null,
    ...extra,
  };
}

test('diffChangeRows keeps only this turn and its line counts', () => {
  const before = [change('a.txt', 10, 2, { status: 'modified', oldPath: null })];
  const after = [
    change('a.txt', 12, 2, { status: 'modified', oldPath: null }),
    change('b.txt', 1, 0, { status: 'added', oldPath: null }),
  ];
  const diff = diffChangeRows(before, after);
  assert.deepEqual(diff.map((row) => [row.path, row.added, row.removed, row.status]), [
    ['a.txt', 2, 0, 'modified'],
    ['b.txt', 1, 0, 'added'],
  ]);

  const same = diffChangeRows(after, after);
  assert.deepEqual(same, []);

  const reverted = diffChangeRows(after, []);
  assert.equal(reverted.find((row) => row.path === 'b.txt').status, 'deleted');
  assert.equal(reverted.find((row) => row.path === 'b.txt').removed, 1);
});

test('pickTurnAnchor prefers the run answer, then the last assistant after the user entry', () => {
  const messages = [
    { id: '1', role: 'user', text: 'go' },
    { id: '2', role: 'assistant', text: 'earlier' },
    { id: '4', role: 'assistant', text: 'later' },
  ];
  assert.equal(pickTurnAnchor(messages, '1', '4'), '4');
  assert.equal(pickTurnAnchor(messages, '1', '9'), '4');
  assert.equal(pickTurnAnchor(messages, '2', ''), '4');
  assert.equal(turnChangesItemId('4'), 'tc-4');
});

test('a thread without per-turn records has no card and still validates', async () => {
  const thread = await buildThread([
    { id: '1', role: 'user', text: 'hi' },
    { id: '2', role: 'assistant', text: 'hello' },
  ]);
  assert.equal(thread.items.some((item) => item.kind === 'turn_changes'), false);
  for (const item of thread.items) {
    assert.equal(validateThreadItem(item), true, JSON.stringify(validateThreadItem.errors));
  }
  const snap = await conversationSnapshot({
    presented: {
      id: 'old',
      workspaceId: 'w',
      title: 'old',
      updatedAt: 1,
      status: 'done',
      messages: [
        { id: '1', role: 'user', text: 'hi' },
        { id: '2', role: 'assistant', text: 'hello' },
      ],
    },
  });
  assert.equal(snap.items.some((item) => item.kind === 'turn_changes'), false);
  assert.deepEqual(snap.conversation.itemIds, ['1', '2']);
});

test('buildThread inserts a stable card after the anchored assistant', async () => {
  const thread = await buildThread([
    { id: '1', role: 'user', text: 'go' },
    { id: '3', role: 'assistant', text: 'done' },
    { id: '5', role: 'user', text: 'next' },
    { id: '6', role: 'assistant', text: 'quiet' },
  ], {
    turnChanges: [{
      id: 'tc-3',
      anchorId: '3',
      changes: [change('a.txt', 2, 0), change('b.txt', 1, 0)],
    }],
  });
  assert.deepEqual(thread.items.map((item) => item.kind), [
    'user', 'assistant', 'turn_changes', 'user', 'assistant',
  ]);
  const card = thread.items[2];
  assert.equal(card.id, 'tc-3');
  assert.deepEqual(card.changes.map((row) => row.path), ['a.txt', 'b.txt']);
  assert.equal(validateThreadItem(card), true, JSON.stringify(validateThreadItem.errors));
});

function v2Headers(token) {
  return { authorization: `Bearer ${token}` };
}

async function getV2(base, apiPath, token) {
  const res = await fetch(base + apiPath, { headers: v2Headers(token) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

async function git(repo, args) {
  await execFileP('git', args, { cwd: repo });
}

async function initRepo(repo) {
  await git(repo, ['init']);
  await git(repo, ['config', 'user.email', 't114@example.com']);
  await git(repo, ['config', 'user.name', 't114']);
  await writeFile(path.join(repo, 'README.md'), 'base\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'init']);
}

const BASH = 'node -e "require(\'fs\').writeFileSync(\'c.txt\',\'c1\\nc2\\nc3\\n\')"';

function scriptTurns() {
  return {
    turns: [
      {
        tools: [
          { tool: 'write', args: { path: 'a.txt', content: 'a1\na2\n' } },
          { tool: 'write', args: { path: 'b.txt', content: 'b1\n' } },
        ],
      },
      { text: 'wrote two' },
      { text: 'nothing' },
      { tool: agentShellKind(), args: { command: BASH } },
      { text: 'bash wrote' },
      { tool: 'delegate', args: { task: 'Write child.txt with CHILD_FILE', title: '写文件' } },
      { text: 'child wrote' },
      { when: 'Write child.txt', tool: 'write', args: { path: 'child.txt', content: 'CHILD_FILE\n' } },
      { when: 'Write child.txt', text: 'wrote child' },
    ],
  };
}

async function waitFinished(base, id, timeoutMs = 40_000) {
  const started = Date.now();
  let body;
  while (Date.now() - started < timeoutMs) {
    const got = await request(base, 'GET', `/api/conversations/${id}`, undefined, TOKEN);
    body = got.body;
    if (body?.status === 'done' || body?.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`conversation ${id} did not finish: ${JSON.stringify(body)}`);
}

async function send(base, id, text) {
  const posted = await request(base, 'POST', `/api/conversations/${id}/messages`, { text }, TOKEN);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const done = await waitFinished(base, id);
  assert.equal(done.status, 'done', JSON.stringify(done?.llmError || done));
  return done;
}

// The answer is committed before the per-turn card. Poll the snapshot until
// the card (or the no-change reply) is actually visible.
async function waitSnapshot(base, token, id, ready) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 40_000) {
    last = await getV2(base, `/api/v2/conversations/${id}`, token);
    if (last.status === 200 && ready(last.body?.items || [])) return last;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const items = last?.body?.items || [];
  throw new Error(`snapshot not ready: ${JSON.stringify(items.map((item) => [item.kind, item.id, item.text || '']))}`);
}

function assistantFollowedBy(items, text, kind) {
  const index = items.findIndex((item) => item.kind === 'assistant' && String(item.text || '').includes(text));
  if (index < 0) return false;
  return (items[index + 1]?.kind || '') === kind;
}

function cardAfter(items, text) {
  const index = items.findIndex((item) => item.kind === 'assistant' && String(item.text || '').includes(text));
  assert.ok(index >= 0, `missing assistant ${text}: ${JSON.stringify(items.map((item) => [item.kind, item.text || item.id]))}`);
  return { index, assistant: items[index], next: items[index + 1] };
}

function byPath(changes) {
  return new Map((changes || []).map((row) => [row.path, row]));
}

test('three faux turns record per-turn file cards, including bash and a subagent, and survive restart', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-turn-changes-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify(scriptTurns()));
  const env = { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2' };
  let srv = await startServer({ dataDir, token: TOKEN, env });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'turns' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    await initRepo(ws.body.path);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'turns' }, TOKEN);
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    const id = conv.body.id;

    const fresh = await getV2(srv.base, `/api/v2/conversations/${id}`, discovery.token);
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal((fresh.body.items || []).some((item) => item.kind === 'turn_changes'), false);

    await send(srv.base, id, 'turn two files');
    await waitSnapshot(srv.base, discovery.token, id, (items) => assistantFollowedBy(items, 'wrote two', 'turn_changes'));
    await send(srv.base, id, 'turn none');
    await waitSnapshot(srv.base, discovery.token, id, (items) => assistantFollowedBy(items, 'nothing', 'user') || assistantFollowedBy(items, 'nothing', ''));
    await send(srv.base, id, 'turn bash');
    await waitSnapshot(srv.base, discovery.token, id, (items) => assistantFollowedBy(items, 'bash wrote', 'turn_changes'));
    await send(srv.base, id, 'turn subagent');
    const got = await waitSnapshot(
      srv.base,
      discovery.token,
      id,
      (items) => assistantFollowedBy(items, 'child wrote', 'turn_changes'),
    );
    assert.equal(got.status, 200, got.text);
    const checked = validateResponse(`/api/v2/conversations/${id}`, 'GET', 200, got.body);
    assert.equal(checked.ok, true, JSON.stringify(checked.errors));
    const items = got.body.items;
    const two = cardAfter(items, 'wrote two');
    assert.equal(two.next?.kind, 'turn_changes', JSON.stringify(items.map((item) => item.kind)));
    const twoFiles = byPath(two.next.changes);
    assert.equal(twoFiles.size, 2, JSON.stringify(two.next.changes));
    assert.equal(twoFiles.get('a.txt').added, 2);
    assert.equal(twoFiles.get('a.txt').removed, 0);
    assert.deepEqual(twoFiles.get('a.txt').by, { kind: 'main' });
    assert.equal(twoFiles.get('b.txt').added, 1);
    assert.equal(twoFiles.get('b.txt').removed, 0);
    assert.equal(got.body.conversation.itemIds[got.body.conversation.itemIds.indexOf(two.assistant.id) + 1], two.next.id);

    const none = cardAfter(items, 'nothing');
    assert.notEqual(none.next?.kind, 'turn_changes');

    const bash = cardAfter(items, 'bash wrote');
    assert.equal(bash.next?.kind, 'turn_changes', JSON.stringify(items.map((item) => [item.kind, item.text || ''])));
    const bashFiles = byPath(bash.next.changes);
    assert.equal(bashFiles.size, 1, JSON.stringify(bash.next.changes));
    assert.equal(bashFiles.get('c.txt').added, 3);
    assert.equal(bashFiles.get('c.txt').removed, 0);
    assert.equal(bashFiles.get('c.txt').by, null);

    const child = cardAfter(items, 'child wrote');
    assert.equal(child.next?.kind, 'turn_changes');
    const childFiles = byPath(child.next.changes);
    assert.equal(childFiles.get('child.txt').added, 1);
    assert.equal(childFiles.get('child.txt').removed, 0);
    assert.equal(childFiles.get('child.txt').by?.kind, 'subagent');
    assert.match(String(childFiles.get('child.txt').by.agentId), /:sub:/);

    assert.equal(items.filter((item) => item.kind === 'turn_changes').length, 3);
    const cardIds = items.filter((item) => item.kind === 'turn_changes').map((item) => item.id);
    assert.deepEqual(cardIds, [`tc-${two.assistant.id}`, `tc-${bash.assistant.id}`, `tc-${child.assistant.id}`]);

    const listed = await request(srv.base, 'GET', `/api/conversations/${id}/changes`, undefined, TOKEN);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const cumulative = new Set((listed.body || []).map((row) => String(row.path).replaceAll('\\', '/')));
    for (const filePath of ['a.txt', 'b.txt', 'c.txt', 'child.txt']) {
      assert.equal(cumulative.has(filePath), true, JSON.stringify([...cumulative]));
    }
    assert.equal(await readFile(path.join(ws.body.path, 'c.txt'), 'utf8'), 'c1\nc2\nc3\n');
    assert.equal(await readFile(path.join(ws.body.path, 'child.txt'), 'utf8'), 'CHILD_FILE\n');

    await stopServer(srv);
    srv = await startServer({ dataDir, token: TOKEN, env });
    const againDiscovery = await readDiscovery(srv.dataDir);
    const again = await getV2(srv.base, `/api/v2/conversations/${id}`, againDiscovery.token);
    assert.equal(again.status, 200, again.text);
    const againChecked = validateResponse(`/api/v2/conversations/${id}`, 'GET', 200, again.body);
    assert.equal(againChecked.ok, true, JSON.stringify(againChecked.errors));
    const againCards = again.body.items.filter((item) => item.kind === 'turn_changes');
    assert.deepEqual(againCards.map((item) => item.id), cardIds);
    assert.deepEqual(againCards[0].changes.map((row) => [row.path, row.added, row.removed]), [
      ['a.txt', 2, 0],
      ['b.txt', 1, 0],
    ]);
    assert.equal(againCards[1].changes[0].path, 'c.txt');
    assert.equal(againCards[2].changes[0].path, 'child.txt');
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('one file edited several times is one row; an edit that returns to the turn start is no card', { timeout: 120_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'weft-turn-changes-multi-'));
  const script = path.join(dataDir, 'script.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { tool: 'write', args: { path: 'm.txt', content: 'm1\n' } },
      { text: 'created m' },
      { tool: 'write', args: { path: 'm.txt', content: 'm1\nm2\n' } },
      { tool: 'write', args: { path: 'm.txt', content: 'm1\nm2\nm3\n' } },
      { text: 'extended m twice' },
      { tool: 'write', args: { path: 'm.txt', content: 'changed\n' } },
      { tool: 'write', args: { path: 'm.txt', content: 'm1\nm2\nm3\n' } },
      { text: 'put m back' },
    ],
  }));
  const env = { WEFT_LLM: 'faux', WEFT_FAUX_SCRIPT: script, WEFT_RETRY_MAX: '2' };
  const srv = await startServer({ dataDir, token: TOKEN, env });
  try {
    const discovery = await readDiscovery(srv.dataDir);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'multi' }, TOKEN);
    assert.equal(ws.status, 201, JSON.stringify(ws.body));
    await initRepo(ws.body.path);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'multi' }, TOKEN);
    const id = conv.body.id;
    await send(srv.base, id, 'create');
    await waitSnapshot(srv.base, discovery.token, id, (items) => assistantFollowedBy(items, 'created m', 'turn_changes'));
    await send(srv.base, id, 'extend');
    await waitSnapshot(srv.base, discovery.token, id, (items) => assistantFollowedBy(items, 'extended m twice', 'turn_changes'));
    await send(srv.base, id, 'revert');
    // Give the settle step time to run, then require that no card was added.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const got = await waitSnapshot(srv.base, discovery.token, id, (items) => items.some((item) => String(item.text || '').includes('put m back')));
    const items = got.body.items;
    const first = cardAfter(items, 'created m');
    assert.deepEqual(first.next.changes.map((row) => [row.path, row.added, row.removed]), [['m.txt', 1, 0]]);
    const second = cardAfter(items, 'extended m twice');
    assert.deepEqual(second.next.changes.map((row) => [row.path, row.added, row.removed]), [['m.txt', 2, 0]]);
    const third = cardAfter(items, 'put m back');
    assert.notEqual(third.next?.kind, 'turn_changes', JSON.stringify(third.next));
    assert.equal(items.filter((item) => item.kind === 'turn_changes').length, 2);
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});
