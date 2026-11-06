// A data directory written by Pi Durable 1.4.0 must open on 1.5.0: history, the
// child agent, and a new message. The sqlite files in tests/fixtures are that
// directory; this test copies them so the fixture itself stays on schema 1.4.
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { ROOT } from './_root.mjs';

const FIXTURE = path.join(ROOT, 'tests/fixtures/pi-durable-1.4.0');

function rewritePaths(file, from, to) {
  const db = new DatabaseSync(file);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  db.exec('BEGIN');
  try {
    for (const { name } of tables) {
      const quoted = `"${String(name).replaceAll('"', '""')}"`;
      const cols = db.prepare(`PRAGMA table_info(${quoted})`).all().map((col) => col.name);
      const rows = db.prepare(`SELECT rowid AS __rowid, * FROM ${quoted}`).all();
      for (const row of rows) {
        const sets = [];
        const params = [];
        for (const col of cols) {
          const value = row[col];
          if (typeof value !== 'string' || !value.includes(from)) continue;
          sets.push(`"${String(col).replaceAll('"', '""')}" = ?`);
          params.push(value.replaceAll(from, to));
        }
        if (!sets.length) continue;
        params.push(row.__rowid);
        db.prepare(`UPDATE ${quoted} SET ${sets.join(', ')} WHERE rowid = ?`).run(...params);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

async function waitDone(kernel, store, id) {
  let body = null;
  for (let i = 0; i < 100; i += 1) {
    const live = await store.getConversation(id);
    body = await kernel.present(live, { includeMessages: true });
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}

test('a 1.4.0 sqlite directory opens, keeps tool and subagent history, and accepts another message', { timeout: 60000 }, async () => {
  const manifest = JSON.parse(await readFile(path.join(FIXTURE, 'manifest.json'), 'utf8'));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-pi14-upgrade-'));
  const storePath = path.join(dataDir, 'weft.sqlite');
  const harnessPath = path.join(dataDir, 'harness', 'session.sqlite');
  let kernel = null;
  let store = null;
  try {
    await mkdir(path.join(dataDir, 'harness'), { recursive: true });
    await mkdir(path.join(dataDir, 'ws'), { recursive: true });
    await cp(path.join(FIXTURE, 'weft.sqlite'), storePath);
    await cp(path.join(FIXTURE, 'harness', 'session.sqlite'), harnessPath);
    rewritePaths(storePath, manifest.dataDir, dataDir);
    rewritePaths(harnessPath, manifest.dataDir, dataDir);

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
        WEFT_FAUX_TEXT: 'STILL_WORKS',
        WEFT_RETRY_MAX: '1',
        WEFT_RETRY_BASE_MS: '20',
      },
    });

    const conv = await store.getConversation(manifest.conversationId);
    assert.ok(conv, 'conversation row missing after upgrade');
    const opened = await kernel.present(conv, { includeMessages: true });
    assert.equal(opened.status, 'done', JSON.stringify(opened.llmError || opened.status));
    assert.deepEqual(
      (opened.messages || []).map((message) => ({
        role: message.role,
        text: message.text || '',
        tool: message.tool?.name || '',
        stopReason: message.stopReason || '',
      })),
      manifest.messages,
    );

    const agents = await kernel.listSubagents(conv);
    const child = agents.find((agent) => agent.id === manifest.childId);
    assert.ok(child, JSON.stringify(agents));
    assert.equal(child.name, manifest.subagent.name);
    assert.equal(child.mode, manifest.subagent.mode);
    assert.equal(child.status, manifest.subagent.status);
    assert.equal(child.lastText, manifest.subagent.lastText);
    const childBody = await kernel.childMessages(conv.id, child.id);
    assert.equal(childBody.status, 200);
    assert.deepEqual(
      (childBody.body.messages || []).map((message) => ({
        role: message.role,
        text: message.text || '',
      })),
      manifest.childMessages,
    );

    const posted = await kernel.postMessage(conv, 'continue after upgrade');
    assert.equal(posted.status, 202, JSON.stringify(posted.body));
    const done = await waitDone(kernel, store, conv.id);
    assert.equal(done.status, 'done', JSON.stringify(done.llmError || done.status));
    const last = [...(done.messages || [])].reverse().find((message) => message.role === 'assistant');
    assert.equal(last?.text, 'STILL_WORKS');
    assert.equal(done.messages[0].text, manifest.messages[0].text);
    assert.equal(done.messages.some((message) => message.text === 'PI14_TOOL_OK'), true);
    assert.equal(done.messages.some((message) => message.role === 'tool' && message.tool?.name === 'delegate' && message.text === 'CHILD_OK'), true);
  } finally {
    if (kernel) await kernel.close();
    if (store) store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
