import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResponse } from '../../src/v2/validate.ts';
import { readDiscovery, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const FOCUS = 'packages/server 的配置';
const NOTE = `迁移进度。重点：${FOCUS}。下一步跑验证。`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function v2(base, method, apiPath, token, body) {
  const res = await fetch(base + apiPath, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, text };
}

function handoffNotes(snapshot) {
  return (snapshot?.items || []).filter((item) => item?.kind === 'system_note' && item.noteKind === 'handoff');
}

test('POST /handoff writes a divider, keeps the focus, and survives a restart', { timeout: 120_000 }, async () => {
  const dataDir = await makeTempDir('weft-handoff-');
  const script = path.join(dataDir, 'handoff.json');
  const record = path.join(dataDir, 'requests.jsonl');
  await writeFile(script, JSON.stringify({
    turns: [
      {
        text: '先列出模块',
        delayMs: 2000,
        usage: { total_tokens: 90000, prompt_tokens: 88000, completion_tokens: 2000 },
      },
      {
        tool: 'handoff',
        args: { text: NOTE },
        delayMs: 3000,
        usage: { total_tokens: 91000, prompt_tokens: 89000, completion_tokens: 2000 },
      },
      // The script floor stays at the pre-reset assistant count, so the new
      // context (zero assistants, floor 1) selects the second matching turn.
      { when: '迁移进度', text: '占位' },
      {
        when: '迁移进度',
        text: '继续验证配置',
        usage: { total_tokens: 1800, prompt_tokens: 1200, completion_tokens: 600 },
      },
    ],
  }));
  const env = {
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: script,
    WEFT_FAUX_RECORD: record,
    WEFT_RETRY_MAX: '1',
    WEFT_RETRY_BASE_MS: '20',
  };
  let srv = await startServer({ dataDir, env });
  try {
    const discovery = await readDiscovery(dataDir);
    const token = discovery.token;
    const missing = await v2(srv.base, 'POST', '/api/v2/conversations/missing/handoff', token, {
      requestId: 'missing-1',
    });
    assert.equal(missing.status, 404, missing.text);
    assert.equal(missing.body.code, 'E_NOT_FOUND');

    const created = await v2(srv.base, 'POST', '/api/v2/conversations', token, { title: 'handoff' });
    assert.equal(created.status, 201, created.text);
    const cid = created.body.id;
    assert.equal(typeof cid, 'string');
    const handoffPath = `/api/v2/conversations/${cid}/handoff`;

    const noId = await v2(srv.base, 'POST', handoffPath, token, {});
    assert.equal(noId.status, 400, noId.text);
    assert.equal(noId.body.code, 'E_BAD_REQUEST');
    const badInstructions = await v2(srv.base, 'POST', handoffPath, token, {
      requestId: 'bad-instructions',
      instructions: 12,
    });
    assert.equal(badInstructions.status, 400, badInstructions.text);
    const tooLong = await v2(srv.base, 'POST', handoffPath, token, {
      requestId: 'too-long',
      instructions: 'x'.repeat(4001),
    });
    assert.equal(tooLong.status, 400, tooLong.text);

    const sent = await v2(srv.base, 'POST', `/api/v2/conversations/${cid}/messages`, token, {
      text: '开始迁移仓库',
      requestId: 'msg-1',
    });
    assert.equal(sent.status, 202, sent.text);

    let busySnap = null;
    for (let i = 0; i < 40; i += 1) {
      const snap = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, token);
      assert.equal(snap.status, 200, snap.text);
      if (snap.body.conversation.run.status === 'running') {
        busySnap = snap.body;
        break;
      }
      await sleep(50);
    }
    assert.ok(busySnap, 'first turn did not start');
    const busy = await v2(srv.base, 'POST', handoffPath, token, { requestId: 'while-busy' });
    assert.equal(busy.status, 409, busy.text);
    assert.equal(busy.body.code, 'E_BUSY');
    assert.equal(validateResponse(handoffPath, 'POST', 409, busy.body).ok, true, JSON.stringify(validateResponse(handoffPath, 'POST', 409, busy.body).errors));

    let idle = null;
    for (let i = 0; i < 80; i += 1) {
      const snap = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, token);
      if (snap.body.conversation.run.status === 'idle') {
        idle = snap.body;
        break;
      }
      await sleep(50);
    }
    assert.ok(idle, 'first turn did not finish');
    assert.equal(idle.conversation.context.used, 90000);

    const accepted = await v2(srv.base, 'POST', handoffPath, token, {
      requestId: 'hand-1',
      instructions: FOCUS,
    });
    assert.equal(accepted.status, 202, accepted.text);
    assert.deepEqual(accepted.body, { ok: true });
    assert.equal(validateResponse(handoffPath, 'POST', 202, accepted.body).ok, true);

    let handing = null;
    for (let i = 0; i < 40; i += 1) {
      const snap = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, token);
      if (snap.body.conversation.run.handoff?.state === 'running') {
        handing = snap.body;
        break;
      }
      if (handoffNotes(snap.body).length) break;
      await sleep(50);
    }
    assert.ok(handing, 'handoff run was not visible');
    assert.equal(handing.conversation.run.status, 'running');
    assert.match(handing.conversation.run.pendingText, /交接/);

    const replay = await v2(srv.base, 'POST', handoffPath, token, {
      requestId: 'hand-1',
      instructions: 'should not start again',
    });
    assert.equal(replay.status, 202, replay.text);
    const second = await v2(srv.base, 'POST', handoffPath, token, { requestId: 'hand-2' });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.body.code, 'E_BUSY');

    let done = null;
    for (let i = 0; i < 80; i += 1) {
      const snap = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, token);
      const notes = handoffNotes(snap.body);
      const continued = (snap.body.items || []).some((item) => (
        item.kind === 'assistant' && item.text === '继续验证配置'
      ));
      if (snap.body.conversation.run.status === 'idle' && notes.length === 1 && continued) {
        done = snap.body;
        break;
      }
      await sleep(100);
    }
    assert.ok(done, srv.logs());
    const note = handoffNotes(done)[0];
    assert.equal(note.detail, NOTE);
    assert.equal(note.text, '新上下文');
    assert.equal(done.tools.some((tool) => tool.kind === 'handoff'), true);
    assert.equal(done.items.some((item) => (
      item.kind === 'user' && String(item.text || '').includes('开启新上下文')
    )), false);
    const noteAt = done.items.findIndex((item) => item.id === note.id);
    const replyAt = done.items.findIndex((item) => item.kind === 'assistant' && item.text === '继续验证配置');
    assert.equal(replyAt > noteAt, true);
    assert.equal(done.conversation.context.used, 1800);
    assert.equal(done.conversation.run.handoff, null);
    const recorded = await readFile(record, 'utf8');
    assert.match(recorded, new RegExp(FOCUS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const english = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}?lang=en`, token);
    assert.equal(english.status, 200, english.text);
    assert.equal(handoffNotes(english.body)[0].text, 'New context');
    assert.equal(handoffNotes(english.body)[0].detail, NOTE);

    const noteId = note.id;
    await stopServer(srv);
    srv = await startServer({ dataDir, env });
    const againToken = (await readDiscovery(dataDir)).token;
    const reopened = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, againToken);
    assert.equal(reopened.status, 200, reopened.text);
    const reopenedNotes = handoffNotes(reopened.body);
    assert.equal(reopenedNotes.length, 1);
    assert.equal(reopenedNotes[0].id, noteId);
    assert.equal(reopenedNotes[0].detail, NOTE);
    assert.equal(reopened.body.conversation.context.used, 1800);
    const replayAfterRestart = await v2(srv.base, 'POST', handoffPath, againToken, { requestId: 'hand-1' });
    assert.equal(replayAfterRestart.status, 202, replayAfterRestart.text);
    await sleep(400);
    const still = await v2(srv.base, 'GET', `/api/v2/conversations/${cid}`, againToken);
    assert.equal(handoffNotes(still.body).length, 1);
    assert.equal(handoffNotes(still.body)[0].id, noteId);
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
