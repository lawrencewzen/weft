import type { MockHub } from './hub';
import { nextId, publishConversationView, publishItem, publishSummary } from './db';
import { conversationTopic } from './db';
import { itemValue, toolValue } from './views';
import type {
  Bilingual,
  EntityValue,
  MockConv,
  MockDb,
  MockGroup,
  MockItem,
  MockSubThread,
  MockTool,
  RunHandle,
  Subagent,
  ThreadItem,
} from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Key for `db.subagents`: `agentId` is the full Subagent id (`<cid>:sub:<n>`). */
export function subagentKey(cid: string, agentId: string): string {
  return `${cid}:${agentId}`;
}

export function subagentTopicOf(cid: string, agentId: string): string {
  return `subagent:${cid}:${agentId}`;
}

function hint(zh: string, en: string): Bilingual {
  return { zh, en };
}

function tool(input: Partial<MockTool> & Pick<MockTool, 'id' | 'kind' | 'title'>): MockTool {
  return {
    status: 'done',
    fromIntent: false,
    hint: hint('', ''),
    hintFailed: false,
    failure: 'none',
    diff: null,
    preview: '',
    truncated: false,
    totalLines: 0,
    output: '',
    ...input,
  };
}

function assistant(id: string, text: string): MockItem {
  return { kind: 'assistant', id, text, pathRefs: [], model: 'grok-4.6', streaming: false, truncated: false };
}

function user(id: string, text: string): MockItem {
  return { kind: 'user', id, text, pathRefs: [] };
}

function group(id: string, toolIds: string[], summary: Bilingual): MockGroup {
  return { kind: 'tool_group', id, toolIds, summary, failed: 0, running: false, live: false };
}

function agent(input: {
  cid: string;
  agentId: string;
  title: string;
  name: string;
  status: Subagent['status'];
  startedAt: number | null;
  lastActivityAt: number | null;
  endedAt?: number | null;
  currentAction?: string | null;
  progress?: Subagent['progress'];
}): Subagent {
  return {
    id: `${input.cid}:sub:${input.agentId}`,
    parentConversationId: input.cid,
    title: input.title,
    name: input.name,
    mode: 'background',
    status: input.status,
    startedAt: input.startedAt,
    lastActivityAt: input.lastActivityAt,
    endedAt: input.endedAt ?? null,
    currentAction: input.currentAction ?? null,
    progress: input.progress ?? null,
  };
}

export function seedSubThreads(now: number): Map<string, MockSubThread> {
  const cid = 'c-rich';
  const out = new Map<string, MockSubThread>();

  const storeRead = tool({
    id: 'sa1-t1',
    kind: 'read',
    title: hint('web/src/data/store.ts', 'web/src/data/store.ts'),
    path: 'web/src/data/store.ts',
    hint: hint('304 行', '304 lines'),
    preview: [
      'export function createEntityStore(): EntityStore {',
      '  const entities = new Map<string, StoredEntity>();',
      '  const listeners = new Set<Listener>();',
      '  let version = 0;',
    ].join('\n'),
    totalLines: 304,
  });

  const running = agent({
    cid,
    agentId: 'sa-1',
    title: '核对 store.ts 的加载顺序',
    name: 'sub-load-order',
    status: 'running',
    startedAt: now - 2 * MINUTE,
    lastActivityAt: now - 8_000,
    currentAction: '正在读取 `web/src/data/store.ts`',
    progress: { step: 2, total: 4 },
  });
  out.set(subagentKey(cid, running.id), {
    view: running,
    items: [
      user('sa1-u1', '把 `web/src/data/store.ts` 的加载顺序核对一遍，重点看 `text.delta` 的偏移。'),
      group('sa1-g1', [storeRead.id], { zh: '读了 1 个文件', en: 'read 1 file' }),
      assistant('sa1-a1', '已经把 `applySnapshot` 和 `items(cid)` 对上了，接下来看 `text.delta` 的偏移分支。'),
    ],
    tools: { [storeRead.id]: storeRead },
    run: null,
  });

  const stuck = agent({
    cid,
    agentId: 'sa-5',
    title: '核对 Git 工作树状态',
    name: 'sub-git-status',
    status: 'stuck',
    startedAt: now - 4 * MINUTE,
    lastActivityAt: now - 72_000,
  });
  out.set(subagentKey(cid, stuck.id), {
    view: stuck,
    items: [
      user('sa5-u1', '看一下工作树是不是干净的，有没有漏提交。'),
      assistant('sa5-a1', '已经列出 `git status`，接下来对变更文件分类。'),
    ],
    tools: {},
    run: null,
  });

  const done = agent({
    cid,
    agentId: 'sa-2',
    title: '补 text.delta 偏移的用例',
    name: 'sub-delta-test',
    status: 'done',
    startedAt: now - 18 * MINUTE,
    lastActivityAt: now - 12 * MINUTE,
    endedAt: now - 12 * MINUTE,
  });
  out.set(subagentKey(cid, done.id), {
    view: done,
    items: [
      user('sa2-u1', '给 `text.delta` 偏移对不上的分支补一条用例。'),
      assistant(
        'sa2-a1',
        [
          '补好了，在 `web/src/data/store.test.ts` 里加了两条：',
          '',
          '- 偏移等于当前长度时追加',
          '- 偏移对不上时标记 stale，等下一次 `upsert`',
          '',
          '`npm run test:web` 全绿。',
        ].join('\n'),
      ),
    ],
    tools: {},
    run: null,
  });

  const waiting = agent({
    cid,
    agentId: 'sa-3',
    title: '等主 Agent 确认文档口径',
    name: 'sub-docs',
    status: 'waiting',
    startedAt: now - 9 * MINUTE,
    lastActivityAt: now - 3 * MINUTE,
    currentAction: '等主 Agent 给出字段命名再写',
  });
  out.set(subagentKey(cid, waiting.id), {
    view: waiting,
    items: [
      user('sa3-u1', '把主题和事件的关系补进 `docs/ARCHITECTURE_V2.md`，字段名等主 Agent 确认。'),
      assistant('sa3-a1', '我先列了提纲，等你确认 `change` 实体的字段名再落笔。'),
    ],
    tools: {},
    run: null,
  });

  const failing = tool({
    id: 'sa4-t1',
    kind: 'bash',
    title: hint('powershell -File scripts/dev.ps1', 'powershell -File scripts/dev.ps1'),
    hint: hint('退出码 1 · 6 行', 'exit 1 · 6 lines'),
    exitCode: 1,
    status: 'failed',
    failure: 'real',
    hintFailed: true,
    preview: [
      'powershell : 无法将“npm”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。',
      'At line:1 char:1',
      '+ npm run dev:web',
    ].join('\n'),
    totalLines: 6,
    output: [
      'powershell : 无法将“npm”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。',
      'At line:1 char:1',
      '+ npm run dev:web',
      '    + CategoryInfo          : ObjectNotFound: (npm:String) [], CommandNotFoundException',
      '    + FullyQualifiedErrorId : CommandNotFoundException',
    ].join('\n'),
  });

  const failed = agent({
    cid,
    agentId: 'sa-4',
    title: '跑 Windows 上的启动脚本',
    name: 'sub-win-script',
    status: 'failed',
    startedAt: now - 25 * MINUTE,
    lastActivityAt: now - 22 * MINUTE,
    endedAt: now - 22 * MINUTE,
  });
  out.set(subagentKey(cid, failed.id), {
    view: failed,
    items: [
      user('sa4-u1', '在内网那台 Windows 上试一下 `scripts/dev.ps1`。'),
      group('sa4-g1', [failing.id], { zh: '执行了 1 条命令', en: 'ran 1 command' }),
      assistant('sa4-a1', '这台机器上 PowerShell 的 PATH 里没有 npm，先停在这里等你处理。'),
    ],
    tools: { [failing.id]: failing },
    run: null,
  });

  const docsCid = 'c-docs';
  const docsDone: Array<{ agentId: string; title: string; name: string; offset: number }> = [
    { agentId: 'doc-1', title: '梳理目录结构', name: 'sub-tree', offset: 3 * HOUR + 12 * MINUTE },
    { agentId: 'doc-2', title: '检查 workflow 配置', name: 'sub-workflow', offset: 3 * HOUR + 8 * MINUTE },
    { agentId: 'doc-3', title: '汇总改动建议', name: 'sub-summary', offset: 3 * HOUR + 4 * MINUTE },
  ];
  for (const row of docsDone) {
    const item = agent({
      cid: docsCid,
      agentId: row.agentId,
      title: row.title,
      name: row.name,
      status: 'done',
      startedAt: now - row.offset - 8 * MINUTE,
      lastActivityAt: now - row.offset,
      endedAt: now - row.offset,
    });
    out.set(subagentKey(docsCid, item.id), {
      view: item,
      items: [
        user(`${row.agentId}-u1`, `请处理：${row.title}`),
        assistant(`${row.agentId}-a1`, `${row.title}已经做完。`),
      ],
      tools: {},
      run: null,
    });
  }

  return out;
}

export function seedSubagentReports(): MockItem[] {
  return [
    {
      kind: 'subagent_report',
      id: 'rich-r1',
      subagentId: 'c-rich:sub:sa-2',
      name: 'sub-delta-test',
      reportKind: 'answered',
      body: [
        '补好了 `text.delta` 偏移的两条用例，`npm run test:web` 全绿。',
        '',
        '- 偏移等于当前长度：追加',
        '- 偏移对不上：标记 stale，等下一次 `upsert`',
      ].join('\n'),
    },
    {
      kind: 'subagent_report',
      id: 'rich-r2',
      subagentId: 'c-rich:sub:sa-4',
      name: 'sub-win-script',
      reportKind: 'failed',
      body: 'PowerShell 里找不到 npm：`CommandNotFoundException`。要在 Windows 上先把 Node 的安装目录加进 PATH。',
    },
  ];
}

export function subagentEntities(thread: MockSubThread): Array<{ entity: string; id: string; value: EntityValue }> {
  const groupIdOf = (toolId: string): string => {
    for (const row of thread.items) {
      if (row.kind === 'tool_group' && row.toolIds.includes(toolId)) return row.id;
    }
    return `group:${toolId}`;
  };
  const out: Array<{ entity: string; id: string; value: EntityValue }> = [
    { entity: 'subagent', id: thread.view.id, value: thread.view as unknown as object },
  ];
  for (const item of thread.items) {
    out.push({ entity: 'item', id: item.id, value: itemValue(item) });
  }
  for (const row of Object.values(thread.tools)) {
    out.push({ entity: 'tool', id: row.id, value: toolValue(row, groupIdOf(row.id)) });
  }
  return out;
}

export function publishSubagentEntity(db: MockDb, hub: MockHub, thread: MockSubThread): void {
  const cid = thread.view.parentConversationId;
  if (!cid) return;
  const value = thread.view as unknown as object;
  hub.publish(conversationTopic(cid), { event: 'upsert', entity: 'subagent', id: thread.view.id, value });
  hub.publish(subagentTopicOf(cid, thread.view.id), {
    event: 'upsert',
    entity: 'subagent',
    id: thread.view.id,
    value,
  });
  publishSummary(db, hub, cid);
}

export function publishSubItem(hub: MockHub, thread: MockSubThread, item: MockItem): void {
  const cid = thread.view.parentConversationId;
  hub.publish(subagentTopicOf(cid, thread.view.id), {
    event: 'upsert',
    entity: 'item',
    id: item.id,
    value: itemValue(item),
  });
}

function publishSubTool(hub: MockHub, thread: MockSubThread, row: MockTool, groupId: string): void {
  const cid = thread.view.parentConversationId;
  hub.publish(subagentTopicOf(cid, thread.view.id), {
    event: 'upsert',
    entity: 'tool',
    id: row.id,
    value: toolValue(row, groupId),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length) {
    const size = Math.min(rest.length, 22 + (out.length % 3) * 8);
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return out;
}

async function streamSubText(
  hub: MockHub,
  thread: MockSubThread,
  run: RunHandle | null,
  text: string,
): Promise<boolean> {
  const cid = thread.view.parentConversationId;
  const liveId = `live:${thread.view.id}:a`;
  const live: Extract<ThreadItem, { kind: 'assistant' }> = {
    kind: 'assistant',
    id: liveId,
    text: '',
    pathRefs: [],
    model: 'grok-4.6',
    streaming: true,
    truncated: false,
  };
  thread.items.push(live);
  publishSubItem(hub, thread, live);
  await sleep(80);
  for (const chunk of chunks(text)) {
    if (run?.cancelled) return false;
    const offset = live.text.length;
    live.text += chunk;
    hub.publish(subagentTopicOf(cid, thread.view.id), {
      event: 'text.delta',
      itemId: liveId,
      offset,
      append: chunk,
    });
    await sleep(26);
  }
  if (run?.cancelled) return false;
  await sleep(60);
  thread.items = thread.items.filter((item) => item.id !== liveId);
  hub.publish(subagentTopicOf(cid, thread.view.id), { event: 'remove', entity: 'item', id: liveId });
  const final = assistant(`${thread.view.id}:a:${thread.items.length + 1}`, text);
  thread.items.push(final);
  publishSubItem(hub, thread, final);
  return true;
}

export type SpawnedSubagent = {
  thread: MockSubThread;
  report: ThreadItem & { kind: 'subagent_report' };
};

export const SPAWN_TITLE: Bilingual = {
  zh: '核对右栏的变更列表',
  en: 'Check the changes list',
};

let ctxReportSeq = 0;

/** Create a running subagent that belongs to `conv` and publish it. */
export function createSubThread(db: MockDb, conv: MockConv, title: string): MockSubThread {
  const seq = (db.seq += 1);
  const view = agent({
    cid: conv.view.id,
    agentId: `run-${seq}`,
    title,
    name: `sub-run-${seq}`,
    status: 'running',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    currentAction: '正在读取 `docs/ARCHITECTURE_V2.md`',
    progress: { step: 1, total: 3 },
  });
  const thread: MockSubThread = { view, items: [], tools: {}, run: null };
  conv.subagents.push(view);
  db.subagents.set(subagentKey(conv.view.id, view.id), thread);
  return thread;
}

/**
 * Drive a spawned subagent: a tool row, a streamed answer, then `done`.
 * Returns the report card to put in the parent conversation.
 */
export async function runSubagent(
  db: MockDb,
  conv: MockConv,
  hub: MockHub,
  thread: MockSubThread,
  run: RunHandle,
  opts: { fail?: boolean } = {},
): Promise<SpawnedSubagent | null> {
  publishSubagentEntity(db, hub, thread);
  publishConversationView(conv, hub);
  await sleep(700);
  if (run.cancelled) return null;

  const read = tool({
    id: `sub-${thread.view.id}-read`,
    kind: 'read',
    title: { zh: 'docs/ARCHITECTURE_V2.md', en: 'docs/ARCHITECTURE_V2.md' },
    path: 'docs/ARCHITECTURE_V2.md',
    status: 'running',
    hint: { zh: '', en: '' },
    preview: '',
    truncated: true,
    totalLines: 96,
    output: '...',
  });
  thread.tools[read.id] = read;
  const groupRow: MockGroup = {
    kind: 'tool_group',
    id: `sub-${thread.view.id}-g`,
    toolIds: [read.id],
    summary: { zh: '正在读取 `docs/ARCHITECTURE_V2.md`…', en: 'Reading `docs/ARCHITECTURE_V2.md`…' },
    failed: 0,
    running: true,
    live: true,
  };
  thread.items.push(groupRow);
  publishSubItem(hub, thread, groupRow);
  publishSubTool(hub, thread, read, groupRow.id);
  publishSubItem(hub, thread, { kind: 'user', id: `${thread.view.id}:u:1`, text: '看一下变更列表是怎么算出来的。', pathRefs: [] });
  await sleep(600);
  if (run.cancelled) return null;
  read.status = 'done';
  read.hint = { zh: '96 行', en: '96 lines' };
  read.preview = [
    '| 主题 | 实体 |',
    '| --- | --- |',
    '| `conversation:<id>` | `change` |',
  ].join('\n');
  publishSubTool(hub, thread, read, groupRow.id);
  groupRow.running = false;
  groupRow.live = false;
  groupRow.summary = { zh: '读了 1 个文件', en: 'read 1 file' };
  publishSubItem(hub, thread, groupRow);
  thread.view.currentAction = '正在整理结论 · 2/3';
  thread.view.progress = { step: 2, total: 3 };
  thread.view.lastActivityAt = Date.now();
  publishSubagentEntity(db, hub, thread);

  const body = opts.fail
    ? '读到了变更列表的实现，但没法确认 `change` 的 `error` 字段在界面上怎么显示，先停在这里。'
    : [
      '看完了，结论：',
      '',
      '- 变更列表在 `conversation:<id>` 主题里，实体是 `change`，id 用相对路径',
      '- 增删行数由服务端算好，客户端不重新 diff',
      '',
      '`web/src/data/store.ts` 的 diff 可以直接在右栏「变更」里看。',
    ].join('\n');
  const streamed = await streamSubText(hub, thread, run, body);
  if (!streamed) return null;

  await sleep(220);
  if (run.cancelled) return null;
  thread.view.status = opts.fail ? 'failed' : 'done';
  thread.view.currentAction = null;
  thread.view.progress = null;
  thread.view.endedAt = Date.now();
  thread.view.lastActivityAt = Date.now();
  publishSubagentEntity(db, hub, thread);

  ctxReportSeq += 1;
  const report: SpawnedSubagent['report'] = {
    kind: 'subagent_report',
    id: `report-${thread.view.id}-${ctxReportSeq}`,
    subagentId: thread.view.id,
    name: thread.view.name,
    reportKind: opts.fail ? 'failed' : 'answered',
    body,
  };
  return { thread, report };
}

/** Append a report card to the parent conversation and publish it. */
export function appendReport(db: MockDb, conv: MockConv, hub: MockHub, report: SpawnedSubagent['report']): void {
  conv.items.push(report);
  conv.view.itemIds.push(report.id);
  publishItem(conv, hub, report);
  publishConversationView(conv, hub);
  publishSummary(db, hub, conv.view.id);
  void db;
}

export function stopSubThread(db: MockDb, hub: MockHub, thread: MockSubThread): void {
  if (thread.run) thread.run.cancelled = true;
  thread.run = null;
  thread.view.status = 'stopped';
  thread.view.currentAction = null;
  thread.view.endedAt = Date.now();
  thread.view.lastActivityAt = Date.now();
  publishSubagentEntity(db, hub, thread);
}

/** Reply inside a subagent thread (used by POST .../subagents/{id}/messages). */
export async function replyInSubThread(
  db: MockDb,
  hub: MockHub,
  thread: MockSubThread,
  text: string,
): Promise<void> {
  const id = `${thread.view.id}:u:${thread.items.length + 1}`;
  const item: Extract<ThreadItem, { kind: 'user' }> = { kind: 'user', id, text, pathRefs: [] };
  thread.items.push(item);
  publishSubItem(hub, thread, item);
  thread.view.currentAction = '正在按你的补充修改';
  thread.view.lastActivityAt = Date.now();
  publishSubagentEntity(db, hub, thread);
  const run: RunHandle = { id: nextId(db, 'subrun'), cancelled: false, steers: [], followUps: [] };
  thread.run = run;
  await sleep(700);
  if (run.cancelled || thread.view.status !== 'running') {
    thread.run = null;
    return;
  }
  const ok = await streamSubText(hub, thread, run, `收到。按「${text.replace(/\s+/g, ' ').slice(0, 40)}」改了，其它结论不变。`);
  thread.run = null;
  if (!ok) return;
  thread.view.status = 'done';
  thread.view.currentAction = null;
  thread.view.endedAt = Date.now();
  thread.view.lastActivityAt = Date.now();
  publishSubagentEntity(db, hub, thread);
}
