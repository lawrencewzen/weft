import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_DB_FILE, createSqliteStore } from '../../src/store/sqlite.mjs';

test('workspaces stored before the kind column migrate to project', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-db-kind-'));
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, APP_DB_FILE));
    db.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run('w-old', 'legacy', dir);
    db.close();

    const store = createSqliteStore(dir);
    try {
      const list = await store.listWorkspaces();
      assert.equal(list.length, 1);
      assert.equal(list[0].id, 'w-old');
      assert.equal(list[0].kind, 'project');
      const chat = await store.createWorkspace({ name: '咨询', path: path.join(dir, 'chat'), kind: 'chat' });
      assert.equal(chat.kind, 'chat');
      const loaded = await store.getWorkspace(chat.id);
      assert.equal(loaded.kind, 'chat');
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
