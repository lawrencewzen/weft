import type { Diff, FileContent, FileNode, FileTree, SaveResult } from './types';

/** A file in the in-memory mock repository. Only text files exist here. */
export type MockFile = { path: string; text: string };

export type MockRepo = {
  files: Map<string, MockFile>;
  /** Paths whose disk content changes shortly after the first read (409 demo). */
  touchOnOpen: Set<string>;
  touched: Set<string>;
};

/** How long after the first read a `touchOnOpen` file is changed by "someone else". */
export const EXTERNAL_TOUCH_MS = 1200;

export function createRepo(files: MockFile[], opts: { touchOnOpen?: string[] } = {}): MockRepo {
  return {
    files: new Map(files.map((file) => [file.path, { ...file }])),
    touchOnOpen: new Set(opts.touchOnOpen || []),
    touched: new Set(),
  };
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, '0');
}

/** 16-char content hash, the same shape as the real `contentVersion()`. */
export function versionOf(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b) >>> 0;
  }
  return `${hex8(h1)}${hex8(h2)}`;
}

export function posixPath(value: string): string {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function fileContent(file: MockFile): FileContent {
  return {
    path: file.path,
    size: byteLength(file.text),
    binary: false,
    tooLarge: false,
    text: file.text,
    version: versionOf(file.text),
  };
}

export function emptyRepo(): MockRepo {
  return createRepo([]);
}

/** Flattened tree: every ancestor directory comes before its children. */
export function repoTree(repo: MockRepo): FileTree {
  const entries = new Map<string, FileNode>();
  for (const file of repo.files.values()) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!entries.has(dir)) entries.set(dir, { path: dir, type: 'dir' });
    }
    entries.set(file.path, { path: file.path, type: 'file' });
  }
  const list = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { entries: list, truncated: false };
}

export function readRepoFile(repo: MockRepo, rawPath: string): FileContent | null {
  const file = repo.files.get(posixPath(rawPath));
  return file ? fileContent(file) : null;
}

/** Longest common subsequence length; enough for the mock's line counters. */
function lcsLength(a: string[], b: string[]): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols).fill(0);
  let cur = new Array<number>(cols).fill(0);
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], cur[j - 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[cols - 1];
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs = lcsLength(a, b);
  return { added: b.length - lcs, removed: a.length - lcs };
}

type DiffOp = { op: 'ctx' | 'add' | 'del'; text: string };

/** Minimal line LCS, then hunks with `context` unchanged lines around each change. */
function opsBetween(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: Uint32Array[] = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: 'ctx', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ op: 'del', text: a[i] });
      i += 1;
    } else {
      ops.push({ op: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ op: 'del', text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    ops.push({ op: 'add', text: b[j] });
    j += 1;
  }
  return ops;
}

/** Structured diff between two texts (used after a save in the file tab). */
export function textDiff(path: string, before: string, after: string, context = 3): Diff {
  const ops = opsBetween(before, after);
  const hunks: Diff['hunks'] = [];
  const changed = ops
    .map((op, index) => (op.op === 'ctx' ? -1 : index))
    .filter((index) => index >= 0);
  let start = -1;
  let end = -1;
  const pushHunk = (from: number, to: number) => {
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < from; k += 1) {
      if (ops[k].op !== 'add') oldLine += 1;
      if (ops[k].op !== 'del') newLine += 1;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    let oldLines = 0;
    let newLines = 0;
    const lines = ops.slice(from, to).map((op) => {
      if (op.op === 'ctx') {
        const row = { op: op.op, text: op.text, oldLine, newLine };
        oldLine += 1;
        newLine += 1;
        oldLines += 1;
        newLines += 1;
        return row;
      }
      if (op.op === 'del') {
        const row = { op: op.op, text: op.text, oldLine, newLine: null };
        oldLine += 1;
        oldLines += 1;
        return row;
      }
      const row = { op: op.op, text: op.text, oldLine: null, newLine };
      newLine += 1;
      newLines += 1;
      return row;
    });
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  };
  for (const pos of changed) {
    if (start < 0) {
      start = Math.max(0, pos - context);
      end = Math.min(ops.length, pos + 1 + context);
      continue;
    }
    if (pos <= end + context) {
      end = Math.min(ops.length, pos + 1 + context);
      continue;
    }
    pushHunk(start, end);
    start = Math.max(0, pos - context);
    end = Math.min(ops.length, pos + 1 + context);
  }
  if (start >= 0) pushHunk(start, end);
  const stats = diffStats(before, after);
  return {
    path,
    added: stats.added,
    removed: stats.removed,
    hunks,
    tooLarge: false,
  };
}

export type SaveAttempt =
  | { ok: true; result: SaveResult }
  | { ok: false; conflict: FileContent };

export function saveRepoFile(
  repo: MockRepo,
  rawPath: string,
  text: string,
  baseVersion?: string | null,
): SaveAttempt {
  const path = posixPath(rawPath);
  const before = repo.files.get(path)?.text ?? '';
  const current = fileContent({ path, text: before });
  if (baseVersion != null && baseVersion !== current.version) {
    return { ok: false, conflict: current };
  }
  repo.files.set(path, { path, text });
  repo.touched.delete(path);
  const stats = diffStats(before, text);
  return {
    ok: true,
    result: { path, version: versionOf(text), added: stats.added, removed: stats.removed },
  };
}

/** Simulate another editor writing the file (drives the save-conflict demo). */
export function touchRepoFile(repo: MockRepo, path: string): boolean {
  const file = repo.files.get(posixPath(path));
  if (!file) return false;
  repo.touched.add(file.path);
  file.text = `${file.text.trimEnd()}\n\n<!-- 这一行是「外部修改」：另有编辑器在原型里改了这个文件 -->\n`;
  return true;
}

/** A standalone structured diff used by the mock run when it "edits" a file. */
export function mockDiff(
  path: string,
  hunks: Array<{
    oldStart: number;
    newStart: number;
    lines: Array<{ op: 'ctx' | 'add' | 'del'; text: string }>;
  }>,
): Diff {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.op === 'add') added += 1;
      if (line.op === 'del') removed += 1;
    }
  }
  return {
    path,
    added,
    removed,
    tooLarge: false,
    hunks: hunks.map((hunk) => {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const lines = hunk.lines.map((line) => {
        if (line.op === 'ctx') {
          const row = { op: line.op, text: line.text, oldLine, newLine };
          oldLine += 1;
          newLine += 1;
          return row;
        }
        if (line.op === 'del') {
          const row = { op: line.op, text: line.text, oldLine, newLine: null };
          oldLine += 1;
          return row;
        }
        const row = { op: line.op, text: line.text, oldLine: null, newLine };
        newLine += 1;
        return row;
      });
      return {
        oldStart: hunk.oldStart,
        oldLines: lines.filter((line) => line.op !== 'add').length,
        newStart: hunk.newStart,
        newLines: lines.filter((line) => line.op !== 'del').length,
        lines,
      };
    }),
  };
}

function repeated(count: number, map: (i: number) => string): string {
  return Array.from({ length: count }, (_, i) => map(i + 1)).join('\n');
}

function storeSource(): string {
  const head = [
    "import type { components } from '../../../src/v2/contract.gen';",
    '',
    'type StoredEntity = { topic: string; entity: string; id: string; value: Record<string, unknown> };',
    'type Listener = () => void;',
    '',
    'export function conversationTopic(cid: string): string {',
    '  return `conversation:${cid}`;',
    '}',
    '',
    'export function subagentTopic(cid: string, agentId: string): string {',
    '  return `subagent:${cid}:${agentId}`;',
    '}',
    '',
    'export type EntityStore = {',
    '  applySnapshot(event: components["schemas"]["SnapshotEvent"]): void;',
    '  items(cid: string): components["schemas"]["ThreadItem"][];',
    '  changes(cid: string): components["schemas"]["Change"][];',
    '  subscribe(listener: Listener): () => void;',
    '  getVersion(): number;',
    '};',
    '',
    'export function createEntityStore(): EntityStore {',
    '  const entities = new Map<string, StoredEntity>();',
    '  const missing = new Set<string>();',
    '  const listeners = new Set<Listener>();',
    '  let version = 0;',
    '',
    '  function notify(): void {',
    '    version += 1;',
    '    for (const listener of listeners) listener();',
    '  }',
    '',
    '  function put(rec: StoredEntity): void {',
    '    const key = `${rec.topic}\\t${rec.entity}\\t${rec.id}`;',
    '    entities.set(key, rec);',
    '    notify();',
    '  }',
    '',
    '  function get(topic: string, entity: string, id: string): StoredEntity | undefined {',
    '    return entities.get(`${topic}\\t${entity}\\t${id}`);',
    '  }',
  ];
  const filler = repeated(196, (i) => [
    `  // ---- 段落 ${i}：占位实现，方便原型里定位到具体行号 ----`,
    `  function section${i}(topic: string): number {`,
    '    let seen = 0;',
    '    for (const rec of entities.values()) {',
    '      if (rec.topic === topic) seen += 1;',
    '    }',
    '    return seen;',
    '  }',
  ].join('\n'));
  const tail = [
    '',
    '  function items(cid: string): components["schemas"]["ThreadItem"][] {',
    '    const conv = get(conversationTopic(cid), "conversation", cid);',
    '    const value = conv?.value as { itemIds?: string[] } | undefined;',
    '    if (!value || !Array.isArray(value.itemIds)) return [];',
    '    const out: components["schemas"]["ThreadItem"][] = [];',
    '    for (const id of value.itemIds) {',
    '      const rec = get(conversationTopic(cid), "item", id);',
    '      if (rec) out.push(rec.value as unknown as components["schemas"]["ThreadItem"]);',
    '    }',
    '    return out;',
    '  }',
    '',
    '  return {',
    '    applySnapshot(event) {',
    '      for (const topic of event.topics || []) {',
    '        for (const rec of [...entities.values()]) {',
    '          if (rec.topic !== topic) continue;',
    '          entities.delete(`${rec.topic}\\t${rec.entity}\\t${rec.id}`);',
    '        }',
    '        missing.delete(topic);',
    '      }',
    '      for (const ref of event.entities || []) {',
    '        put({ topic: ref.topic, entity: ref.entity, id: ref.id, value: ref.value });',
    '      }',
    '      notify();',
    '    },',
    '    items,',
    '    changes(cid) {',
    '      const out: components["schemas"]["Change"][] = [];',
    '      for (const rec of entities.values()) {',
    '        if (rec.topic !== conversationTopic(cid) || rec.entity !== "change") continue;',
    '        out.push(rec.value as unknown as components["schemas"]["Change"]);',
    '      }',
    '      return out.sort((a, b) => a.path.localeCompare(b.path));',
    '    },',
    '    subscribe(listener) {',
    '      listeners.add(listener);',
    '      return () => { listeners.delete(listener); };',
    '    },',
    '    getVersion() {',
    '      return version;',
    '    },',
    '  };',
    '}',
  ];
  return [...head, filler, ...tail].join('\n');
}

function storeTestSource(): string {
  const head = [
    "import { describe, expect, it } from 'vitest';",
    "import { applySnapshot, createEntityStore, textDelta } from './store';",
    '',
    'function snapshot(ids: string[]) {',
    '  return {',
    "    protocolVersion: '2.0.0',",
    "    topics: ['conversation:c1'],",
    '    entities: ids.map((id) => ({',
    "      topic: 'conversation:c1',",
    "      entity: 'item',",
    '      id,',
    "      value: { kind: 'assistant', id, text: '', pathRefs: [], streaming: false, truncated: false },",
    '    })),',
    '  };',
    '}',
    '',
  ];
  const body: string[] = [];
  for (let i = 1; i <= 30; i += 1) {
    body.push(
      `describe('load order ${i}', () => {`,
      `  it('keeps itemIds order ${i}', () => {`,
      '    const store = createEntityStore();',
      "    applySnapshot(store, snapshot(['a', 'b', 'c']));",
      "    expect(store.items('c1').map((item) => item.id)).toEqual(['a', 'b', 'c']);",
      '  });',
      '',
      `  it('appends deltas only on a matching offset ${i}', () => {`,
      '    const store = createEntityStore();',
      "    applySnapshot(store, snapshot(['a']));",
      "    textDelta(store, { topic: 'conversation:c1', itemId: 'a', offset: 0, append: 'hi' });",
      "    expect(store.items('c1')[0]?.text).toBe('hi');",
      '  });',
      '});',
      '',
    );
  }
  return [...head, ...body].join('\n');
}

export function seedWeftRepo(): MockRepo {
  return createRepo([
    {
      path: 'README.md',
      text: [
        '# weft',
        '',
        '网页版个人 Agent：对话运行时是 Pi Durable Harness。',
        '',
        '## 常用命令',
        '',
        '```bash',
        'npm ci',
        'npm run check',
        'npm test',
        'npm run build:proto',
        '```',
        '',
        '## 原型',
        '',
        '`design/prototype/index.html` 是单文件可交互原型，双击就能用。',
      ].join('\n'),
    },
    {
      path: 'package.json',
      text: [
        '{',
        '  "name": "weft",',
        '  "version": "0.1.0",',
        '  "type": "module",',
        '  "scripts": {',
        '    "start": "node server.mjs",',
        '    "test": "node --test tests/unit/*.test.mjs"',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      path: '.gitignore',
      text: ['node_modules/', 'public-next/', 'design/prototype/index.html', '.env', ''].join('\n'),
    },
    {
      path: 'docs/ARCHITECTURE.md',
      text: [
        '# 架构',
        '',
        '应用库只留最近一次提交的 id，对话状态全在 Harness 里。',
        '',
        '- 对话、任务、检查点、断点续跑：Pi Durable Harness',
        '- 模型调用：@earendil-works/pi-ai',
        '- 订阅推送：`/api/v2/events`',
        '',
      ].join('\n'),
    },
    {
      path: 'docs/ARCHITECTURE_V2.md',
      text: [
        '# v2 目标架构',
        '',
        '## 主题与事件',
        '',
        '| 主题 | 实体 |',
        '| --- | --- |',
        '| `workspaces` | `workspace`、`conversation_summary` |',
        '| `providers` | `provider`、`defaults` |',
        '| `extensions` | `plugin`、`skill`、`git_connection` |',
        '| `conversation:<id>` | `conversation`、`item`、`tool`、`subagent`、`change` |',
        '| `subagent:<cid>:<aid>` | `subagent`、`item`、`tool` |',
        '',
        '事件顺序：`snapshot` → `upsert` / `remove` / `text.delta`，另有 `heartbeat`。',
        '',
        '## 客户端',
        '',
        '`createEntityStore()` 只做覆盖，不重排；`items(cid)` 按 `conversation.itemIds` 取。',
        '',
      ].join('\n'),
    },
    {
      path: 'docs/PLAN.md',
      text: [
        '# 计划',
        '',
        '1. v2 契约与推送（已完成）',
        '2. 新版网页端（迁移中）',
        '3. 可交互原型（T50）',
        '',
      ].join('\n'),
    },
    {
      path: 'src/kernel/index.mjs',
      text: [
        '/** Pi Durable Harness 的薄封装：对话、任务、检查点都在内核里。 */',
        "import { Harness } from '@earendil-works/pi-durable';",
        '',
        'export function createKernel(opts) {',
        '  return new Harness(opts);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/kernel/subagents.mjs',
      text: [
        'export function childStatus(agent) {',
        '  const raw = String(agent?.status || "");',
        '  if (raw === "done") return "done";',
        '  if (raw === "stopped") return "stopped";',
        '  if (raw === "paused") return "waiting";',
        '  return "running";',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/v2/http/extensions.ts',
      text: [
        'export async function handleExtensionsApi(ctx) {',
        '  const { pathname, method, sendV2 } = ctx;',
        '  if (pathname === "/api/v2/plugins" && method === "GET") {',
        '    sendV2(ctx.res, pathname, method, 200, { plugins: [] });',
        '    return true;',
        '  }',
        '  return false;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/v2/views/files.ts',
      text: [
        'export function fileNodeView(entry) {',
        '  return { path: posixPath(entry.path), type: entry.type === "dir" ? "dir" : "file" };',
        '}',
        '',
        'export function contentVersion(buf) {',
        '  return createHash("sha256").update(buf).digest("hex").slice(0, 16);',
        '}',
        '',
      ].join('\n'),
    },
    { path: 'web/src/data/store.ts', text: storeSource() },
    {
      path: 'web/src/data/diffView.ts',
      text: [
        'export function numberDiffLines(hunk) {',
        '  let oldLine = hunk.oldStart;',
        '  let newLine = hunk.newStart;',
        '  return hunk.lines.map((line) => {',
        '    if (line.op === "ctx") {',
        '      const row = { op: "ctx", text: line.text, oldLine, newLine };',
        '      oldLine += 1;',
        '      newLine += 1;',
        '      return row;',
        '    }',
        '    if (line.op === "del") {',
        '      const row = { op: "del", text: line.text, oldLine, newLine: null };',
        '      oldLine += 1;',
        '      return row;',
        '    }',
        '    const row = { op: "add", text: line.text, oldLine: null, newLine };',
        '    newLine += 1;',
        '    return row;',
        '  });',
        '}',
        '',
      ].join('\n'),
    },
    { path: 'web/src/data/store.test.ts', text: storeTestSource() },
    {
      path: 'web/src/components/ChangesPane.tsx',
      text: [
        'export function ChangesPane({ lang }) {',
        '  const { visibleChanges, totals, openPaths, toggleChange, diffs } = useRightPane();',
        '  if (!visibleChanges.length) return <div className="pane-empty">{t(lang, "no_changes_yet")}</div>;',
        '  return (',
        '    <div className="changes-pane">',
        '      <div className="changes-head">',
        '        <b>{t(lang, "changes_file_count", { n: visibleChanges.length })}</b>',
        '      </div>',
        '    </div>',
        '  );',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'web/src/styles/app.css',
      text: [
        ':root {',
        '  --panel: #ffffff;',
        '  --text: #1f2328;',
        '  --muted: #6b7280;',
        '}',
        '',
        '.next-shell {',
        '  display: grid;',
        '  grid-template-columns: var(--left-w) 1fr var(--right-w);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'tests/unit/v2-files.test.mjs',
      text: [
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "import { contentVersion, saveWorkspaceFile } from '../../src/v2/views/files.ts';",
        '',
        "test('contentVersion is 16 hex chars', () => {",
        "  assert.match(contentVersion('hello'), /^[a-f0-9]{16}$/);",
        '});',
        '',
        "test('save with a stale baseVersion reports a conflict', async () => {",
        '  const result = await saveWorkspaceFile({ root: "/tmp/weft", path: "README.md", text: "x" });',
        '  assert.equal(result.path, "README.md");',
        '});',
        '',
      ].join('\n'),
    },
    {
      path: 'contract/openapi.json',
      text: [
        '{',
        '  "openapi": "3.1.0",',
        '  "info": { "title": "weft v2", "version": "0.1.0" },',
        '  "paths": {',
        '    "/api/v2/events": { "get": { "summary": "SSE" } }',
        '  }',
        '}',
      ].join('\n'),
    },
    {
      path: 'scripts/dev.sh',
      text: [
        '#!/bin/sh',
        'set -eu',
        'WEFT_LLM="${WEFT_LLM:-faux}" npm run dev:web &',
        'node server.mjs',
        '',
      ].join('\n'),
    },
    {
      path: 'demo/conflict.md',
      text: [
        '# 保存冲突演示',
        '',
        '这个文件在原型里会在第一次打开约 1 秒后被「另一个编辑器」改掉：',
        '',
        '1. 在右栏「文件」里点开 `demo/conflict.md`',
        '2. 等 1 秒，点「编辑」，随便加一行',
        '3. 点「保存」→ 出现 409 冲突条，可选择「覆盖」或「重新加载」',
        '',
        '原型把外部修改模拟成在文件末尾追加一行注释。',
      ].join('\n'),
    },
  ], { touchOnOpen: ['demo/conflict.md'] });
}

export function seedWebsiteRepo(): MockRepo {
  return createRepo([
    {
      path: 'README.md',
      text: ['# website', '', '落地页，静态导出到 `public/`。', ''].join('\n'),
    },
    {
      path: 'index.html',
      text: ['<!doctype html>', '<html lang="zh">', '  <head><title>weft</title></head>', '  <body></body>', '</html>', ''].join('\n'),
    },
    {
      path: 'src/main.ts',
      text: ['export function mount(): void {', '  document.body.dataset.ready = "1";', '}', ''].join('\n'),
    },
    {
      path: 'docs/copy.md',
      text: ['# 文案', '', '一个对话，从需求到提交。', ''].join('\n'),
    },
    {
      path: 'styles/site.css',
      text: [':root {', '  --ink: #111827;', '}', ''].join('\n'),
    },
  ]);
}
