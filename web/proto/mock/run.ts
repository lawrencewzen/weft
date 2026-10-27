import type { MockHub } from './hub';
import {
  nextId,
  publishConversationView,
  publishItem,
  publishRemove,
  publishSummary,
  publishTextDelta,
  publishTool,
  recomputeContext,
  touch,
} from './db';
import { conversationGroupId } from './views';
import type {
  Bilingual,
  MockConv,
  MockDb,
  MockGroup,
  MockTool,
  RunHandle,
  ThreadItem,
} from './types';

const THINK_MS = 520;
const TOOL_MS = 420;
const CHUNK_MS = 46;

const THINKING: Bilingual = { zh: '思考中', en: 'Thinking' };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

type PlannedTool = {
  kind: 'read' | 'grep' | 'bash' | 'edit';
  path?: string;
  query?: string;
  command?: string;
  diff?: { added: number; removed: number };
};

type Plan = {
  tools: PlannedTool[];
  reply: string;
};

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function planFor(text: string): Plan {
  const body = clip(text, 60);
  if (/(测试|test|跑|run|命令|bash|npm|构建|build)/i.test(text)) {
    return {
      tools: [
        { kind: 'bash', command: 'npm test' },
        { kind: 'read', path: 'tests/unit/v2-run.test.mjs' },
      ],
      reply: [
        '先跑一遍现有测试，再补上你提到的这一条。',
        '',
        '```bash',
        '$ npm test',
        '# tests 412',
        '# pass 412',
        '```',
        '',
        `结论：\`${body}\` 相关的用例都在，新增的那条挂在 \`tests/unit/v2-run.test.mjs\` 里。`,
      ].join('\n'),
    };
  }
  if (/(改|修|编辑|加|写|实现|edit|fix|write|add|重构)/i.test(text)) {
    return {
      tools: [
        { kind: 'read', path: 'web/src/data/store.ts' },
        { kind: 'edit', path: 'web/src/data/store.ts', diff: { added: 12, removed: 4 } },
        { kind: 'bash', command: 'npm run typecheck:web' },
      ],
      reply: [
        '### 改好了',
        '',
        `按你说的「${body}」改的，只动了一处：`,
        '',
        '- `items(cid)` 改成先过滤再取，去掉了重复的 `notify()`',
        '- 顺手补了注释，说明 `text.delta` 偏移对不上时的处理',
        '',
        '| 检查项 | 结果 |',
        '| --- | --- |',
        '| `typecheck:web` | 通过 |',
        '| `test:web` | 通过 |',
        '',
        '右栏能看到 `web/src/data/store.ts` 的 diff。',
      ].join('\n'),
    };
  }
  if (/(读|看|找|搜|read|look|find|search|文件)/i.test(text)) {
    return {
      tools: [
        { kind: 'read', path: 'web/src/data/store.ts' },
        { kind: 'grep', query: 'applySnapshot' },
        { kind: 'read', path: 'web/src/data/stream.ts' },
      ],
      reply: [
        '看完了，三处关键点：',
        '',
        '1. `applySnapshot` 先按主题清空，再按 `entities` 顺序写入',
        '2. `text.delta` 只在偏移等于当前长度时追加，对不上就等下一次 `upsert`',
        '3. 工具组按相邻的连续调用合并，`toolIds` 由服务端算',
        '',
        '```ts',
        'const next = conv.itemIds.map((id) => store.item(id)).filter(Boolean);',
        '```',
        '',
        `你问的「${body}」在 \`web/src/data/store.ts\` 里能对上。`,
      ].join('\n'),
    };
  }
  return {
    tools: [
      { kind: 'read', path: 'docs/ARCHITECTURE_V2.md' },
      { kind: 'bash', command: 'git status --short' },
    ],
    reply: [
      `我理解你的意思是「${body}」。`,
      '',
      '先做了两件事：',
      '',
      '- 读了 `docs/ARCHITECTURE_V2.md`，确认服务端只做视图，不存对话状态',
      '- 跑了一次 `git status --short`，工作区是干净的',
      '',
      '接下来可以继续拆成具体改动，你说方向就行。',
    ].join('\n'),
  };
}

function linesFor(path: string): number {
  let hash = 0;
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) % 97;
  return 48 + hash;
}

function filePreview(path: string, total: number): string {
  const name = path.split('/').pop() || path;
  return [
    `// ${path}`,
    `export function ${name.replace(/\.[a-z]+$/, '').replace(/[^A-Za-z0-9]/g, '') || 'main'}() {`,
    '  const rows = load();',
    '  return rows.filter(Boolean);',
    '}',
    `// ${total} lines in total`,
  ].join('\n');
}

function buildTool(db: MockDb, plan: PlannedTool): MockTool {
  const id = nextId(db, 'tool');
  if (plan.kind === 'read') {
    const path = plan.path || 'README.md';
    const total = linesFor(path);
    return {
      id,
      kind: 'read',
      status: 'running',
      path,
      title: { zh: path, en: path },
      fromIntent: false,
      hint: { zh: '', en: '' },
      hintFailed: false,
      failure: 'none',
      diff: null,
      preview: '',
      truncated: total > 20,
      totalLines: total,
      output: filePreview(path, total),
    };
  }
  if (plan.kind === 'grep') {
    const query = plan.query || 'applySnapshot';
    return {
      id,
      kind: 'grep',
      status: 'running',
      title: { zh: query, en: query },
      fromIntent: false,
      hint: { zh: '', en: '' },
      hintFailed: false,
      failure: 'none',
      diff: null,
      preview: '',
      truncated: false,
      totalLines: 3,
      output: [
        `web/src/data/store.ts:241:    ${query}(event) {`,
        `web/src/data/store.test.ts:18:    store.${query}(snapshot)`,
        `web/src/data/store.test.ts:44:    store.${query}(empty)`,
      ].join('\n'),
    };
  }
  if (plan.kind === 'edit') {
    const path = plan.path || 'web/src/data/store.ts';
    const diff = plan.diff || { added: 8, removed: 2 };
    return {
      id,
      kind: 'edit',
      status: 'running',
      path,
      title: { zh: path, en: path },
      fromIntent: false,
      hint: { zh: '', en: '' },
      hintFailed: false,
      failure: 'none',
      diff,
      preview: '',
      truncated: false,
      totalLines: 9,
      output: `@@ -238,6 +238,9 @@\n   items(cid) {\n-    const topic = conversationTopic(cid);\n+    const topic = conversationTopic(cid);\n+    const out: ThreadItem[] = [];`,
    };
  }
  const command = plan.command || 'npm test';
  return {
    id,
    kind: 'bash',
    status: 'running',
    title: { zh: command, en: command },
    fromIntent: false,
    hint: { zh: '', en: '' },
    hintFailed: false,
    failure: 'none',
    diff: null,
    exitCode: 0,
    preview: '',
    truncated: true,
    totalLines: 18,
    output: [
      `$ ${command}`,
      '',
      '> weft@0.1.0',
      '',
      '✓ check passed',
      '✓ 412 tests passed',
    ].join('\n'),
  };
}

function finishTool(tool: MockTool): void {
  tool.status = 'done';
  if (tool.kind === 'read') {
    tool.preview = filePreview(tool.path || 'README.md', tool.totalLines).split('\n').slice(0, 6).join('\n');
    tool.hint = { zh: `${tool.totalLines} 行`, en: `${tool.totalLines} lines` };
    return;
  }
  if (tool.kind === 'grep') {
    tool.preview = tool.output;
    tool.hint = { zh: '3 处匹配', en: '3 matches' };
    return;
  }
  if (tool.kind === 'bash') {
    tool.preview = tool.output.split('\n').slice(0, 5).join('\n');
    tool.hint = { zh: `退出码 0 · ${tool.totalLines} 行`, en: `exit 0 · ${tool.totalLines} lines` };
    return;
  }
  tool.preview = (tool.output || '').split('\n').slice(0, 4).join('\n');
}

function runningLine(tool: MockTool): Bilingual {
  const target = tool.path || (tool.kind === 'bash' ? tool.title.zh : tool.title.zh);
  const action = {
    read: { zh: '正在读取', en: 'Reading' },
    grep: { zh: '正在搜索', en: 'Searching' },
    bash: { zh: '正在运行', en: 'Running' },
    edit: { zh: '正在编辑', en: 'Editing' },
    write: { zh: '正在写入', en: 'Writing' },
    ls: { zh: '正在列出', en: 'Listing' },
    other: { zh: '正在调用', en: 'Calling' },
  }[tool.kind];
  return {
    zh: `${action.zh} \`${target}\`…`,
    en: `${action.en} \`${target}\`…`,
  };
}

function counts(conv: MockConv, group: MockGroup): { clause: Bilingual; failed: number } {
  const tools = group.toolIds
    .map((id) => conv.tools[id])
    .filter((tool): tool is MockTool => Boolean(tool));
  const failed = tools.filter((tool) => tool.failure === 'real').length;
  const done = tools.filter((tool) => tool.failure !== 'real');
  const partsZh: string[] = [];
  const partsEn: string[] = [];
  const tally = (kind: string) => done.filter((tool) => tool.kind === kind).length;
  const add = (count: number, zh: [string, string], en: [string, string]) => {
    if (!count) return;
    partsZh.push(zh[count === 1 ? 0 : 1].replace('{n}', String(count)));
    partsEn.push(en[count === 1 ? 0 : 1].replace('{n}', String(count)));
  };
  add(tally('read'), ['读了 {n} 个文件', '读了 {n} 个文件'], ['read {n} file', 'read {n} files']);
  add(tally('grep'), ['搜索了 {n} 处', '搜索了 {n} 处'], ['searched {n} place', 'searched {n} places']);
  add(tally('edit') + tally('write'), ['编辑了 {n} 个文件', '编辑了 {n} 个文件'], ['edited {n} file', 'edited {n} files']);
  add(tally('bash'), ['执行了 {n} 条命令', '执行了 {n} 条命令'], ['ran {n} command', 'ran {n} commands']);
  add(tally('ls'), ['列出 {n} 个目录', '列出 {n} 个目录'], ['listed {n} directory', 'listed {n} directories']);
  add(tally('other'), ['调用了 {n} 次工具', '调用了 {n} 次工具'], ['called a tool {n} time', 'called a tool {n} times']);
  return {
    clause: {
      zh: partsZh.join(' · ') || '完成',
      en: partsEn.join(' · ') || 'Done',
    },
    failed,
  };
}

function refreshGroup(conv: MockConv, hub: MockHub, group: MockGroup, running: boolean): void {
  const tools = group.toolIds
    .map((id) => conv.tools[id])
    .filter((tool): tool is MockTool => Boolean(tool));
  const live = tools.find((tool) => tool.status === 'running');
  if (live) {
    group.running = true;
    group.summary = runningLine(live);
  } else {
    group.running = running;
    const { clause, failed } = counts(conv, group);
    group.summary = clause;
    group.failed = failed;
  }
  group.live = running && conv.view.run.status === 'running'
    && conv.items[conv.items.length - 1] === group;
  publishItem(conv, hub, group);
}

function setPending(conv: MockConv, hub: MockHub, pending: Bilingual | null): void {
  conv.pending = pending;
  publishConversationView(conv, hub);
}

function drainSteers(db: MockDb, conv: MockConv, hub: MockHub, run: RunHandle): string[] {
  const taken = run.steers.splice(0, run.steers.length);
  for (const steer of taken) {
    const id = nextId(db, 'u');
    const item: ThreadItem = { kind: 'user', id, text: steer.text, pathRefs: [] };
    conv.items.push(item);
    conv.view.itemIds.push(id);
    const send = conv.view.sends?.find((row) => row.requestId === steer.requestId);
    if (send) send.entryId = id;
    publishItem(conv, hub, item);
    publishConversationView(conv, hub);
  }
  return taken.map((steer) => steer.text);
}

async function runTool(
  db: MockDb,
  conv: MockConv,
  hub: MockHub,
  run: RunHandle,
  group: MockGroup,
  plan: PlannedTool,
): Promise<void> {
  if (run.cancelled) return;
  const tool = buildTool(db, plan);
  conv.tools[tool.id] = tool;
  group.toolIds.push(tool.id);
  const first = !conv.items.includes(group);
  if (first) {
    group.summary = runningLine(tool);
    group.running = true;
    group.live = true;
    conv.items.push(group);
    conv.view.itemIds.push(group.id);
    publishItem(conv, hub, group);
    publishConversationView(conv, hub);
  }
  publishTool(conv, hub, tool, conversationGroupId(conv, tool.id));
  setPending(conv, hub, runningLine(tool));
  await sleep(TOOL_MS);
  if (run.cancelled) return;
  finishTool(tool);
  publishTool(conv, hub, tool, conversationGroupId(conv, tool.id));
  refreshGroup(conv, hub, group, true);
  setPending(conv, hub, THINKING);
}

function refsIn(text: string): { text: string; path: string }[] {
  const found = text.match(/(?:web|src|docs|scripts|tests|contract|design)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|mjs|js|md|json|css)/g) || [];
  const seen = new Set<string>();
  const out: { text: string; path: string }[] = [];
  for (const raw of found) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ text: raw, path: raw });
  }
  return out;
}

function chunks(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length) {
    const size = Math.min(rest.length, 26 + (out.length % 3) * 9);
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return out;
}

async function streamAssistant(
  db: MockDb,
  conv: MockConv,
  hub: MockHub,
  run: RunHandle,
  text: string,
): Promise<boolean> {
  const liveId = `live:${nextId(db, 'a')}`;
  const live: ThreadItem = {
    kind: 'assistant',
    id: liveId,
    text: '',
    pathRefs: [],
    model: conv.view.model?.modelId || 'grok-4.6',
    streaming: true,
    truncated: false,
  };
  conv.items.push(live);
  conv.view.itemIds.push(liveId);
  publishItem(conv, hub, live);
  publishConversationView(conv, hub);
  await sleep(120);
  for (const chunk of chunks(text)) {
    if (run.cancelled) return false;
    const offset = live.text.length;
    live.text += chunk;
    publishTextDelta(conv, hub, liveId, offset, chunk);
    await sleep(CHUNK_MS);
  }
  if (run.cancelled) return false;
  await sleep(140);
  if (run.cancelled) return false;
  conv.items = conv.items.filter((item) => item.id !== liveId);
  conv.view.itemIds = conv.view.itemIds.filter((id) => id !== liveId);
  publishRemove(conv, hub, 'item', liveId);
  const final: ThreadItem = {
    kind: 'assistant',
    id: nextId(db, 'a'),
    text,
    pathRefs: refsIn(text),
    model: conv.view.model?.modelId || 'grok-4.6',
    streaming: false,
    truncated: false,
  };
  conv.items.push(final);
  conv.view.itemIds.push(final.id);
  publishItem(conv, hub, final);
  publishConversationView(conv, hub);
  return true;
}

function finishRun(db: MockDb, conv: MockConv, hub: MockHub): void {
  const run = conv.run;
  if (!run) return;
  conv.run = null;
  conv.view.status = 'idle';
  conv.view.run = {
    status: 'idle',
    startedAt: null,
    pendingText: null,
    canSend: true,
    canStop: false,
    lockedReason: null,
    error: null,
  };
  conv.pending = null;
  touch(conv);
  recomputeContext(db, conv, conv.view.context.used + 1_800);
  publishConversationView(conv, hub);
  publishSummary(db, hub, conv.view.id);
}

async function execute(db: MockDb, conv: MockConv, hub: MockHub, run: RunHandle, text: string): Promise<void> {
  await sleep(THINK_MS);
  if (run.cancelled) return;
  const plan = planFor(text);
  const newGroup = (): MockGroup => ({
    kind: 'tool_group',
    id: nextId(db, 'g'),
    toolIds: [],
    summary: { zh: '', en: '' },
    failed: 0,
    running: true,
    live: true,
  });
  let group = newGroup();
  const interjections: string[] = [];
  for (const step of plan.tools) {
    if (run.cancelled) return;
    await runTool(db, conv, hub, run, group, step);
    if (run.cancelled) return;
    const drained = drainSteers(db, conv, hub, run);
    interjections.push(...drained);
    if (drained.length) {
      // The steer landed after this batch: later calls belong to a fresh group below it.
      group = newGroup();
      await runTool(db, conv, hub, run, group, { kind: 'read', path: 'README.md' });
      if (run.cancelled) return;
    }
  }
  if (run.cancelled) return;
  group.live = false;
  group.running = false;
  refreshGroup(conv, hub, group, false);
  const ack = interjections.length
    ? `收到插话：${interjections.map((item) => `「${clip(item, 36)}」`).join('、')}。我把当前这一步做完后一起看了。\n\n`
    : '';
  const ok = await streamAssistant(db, conv, hub, run, `${ack}${plan.reply}`);
  if (!ok || run.cancelled) return;
  finishRun(db, conv, hub);
}

function trimSends(conv: MockConv): void {
  const sends = conv.view.sends;
  if (!sends) return;
  while (sends.length > 20) sends.shift();
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 28 ? `${oneLine.slice(0, 27)}…` : oneLine || '新对话';
}

export function startRun(db: MockDb, conv: MockConv, hub: MockHub, text: string): string {
  const run: RunHandle = { id: nextId(db, 'run'), cancelled: false, steers: [] };
  conv.run = run;
  conv.view.status = 'running';
  conv.view.run = {
    status: 'running',
    startedAt: Date.now(),
    pendingText: null,
    canSend: true,
    canStop: true,
    lockedReason: null,
    error: null,
  };
  conv.pending = THINKING;
  touch(conv);
  publishConversationView(conv, hub);
  publishSummary(db, hub, conv.view.id);
  void execute(db, conv, hub, run, text);
  return run.id;
}

export type SendResult =
  | { ok: true; runId: string }
  | { ok: false; status: number; error: string };

export function sendMessage(
  db: MockDb,
  conv: MockConv,
  hub: MockHub,
  text: string,
  requestId: string,
): SendResult {
  const known = conv.view.sends?.find((row) => row.requestId === requestId);
  if (known) {
    return { ok: true, runId: conv.requestRuns.get(requestId) || '' };
  }
  const sends = conv.view.sends ?? (conv.view.sends = []);
  if (conv.run && conv.view.run.status === 'running') {
    sends.push({ requestId, entryId: null, dropped: false });
    trimSends(conv);
    conv.run.steers.push({ requestId, text });
    conv.requestRuns.set(requestId, conv.run.id);
    touch(conv);
    publishConversationView(conv, hub);
    publishSummary(db, hub, conv.view.id);
    return { ok: true, runId: conv.run.id };
  }
  const id = nextId(db, 'u');
  const item: ThreadItem = { kind: 'user', id, text, pathRefs: [] };
  conv.items.push(item);
  conv.view.itemIds.push(id);
  sends.push({ requestId, entryId: id, dropped: false });
  trimSends(conv);
  if (conv.items.filter((row) => row.kind === 'user').length === 1 && conv.view.title === '新对话') {
    conv.view.title = titleFrom(text);
  }
  touch(conv);
  publishItem(conv, hub, item);
  publishConversationView(conv, hub);
  const runId = startRun(db, conv, hub, text);
  conv.requestRuns.set(requestId, runId);
  return { ok: true, runId };
}

/** Stop whatever is running; the async engine notices `cancelled` after its next sleep. */
export function stopConversation(db: MockDb, conv: MockConv, hub: MockHub): void {
  const run = conv.run;
  if (!run) return;
  run.cancelled = true;
  for (const steer of run.steers) {
    const send = conv.view.sends?.find((row) => row.requestId === steer.requestId);
    if (send) send.dropped = true;
  }
  run.steers = [];
  const live = conv.items.find(
    (item): item is Extract<ThreadItem, { kind: 'assistant' }> => item.kind === 'assistant' && item.id.startsWith('live:'),
  );
  if (live) {
    conv.items = conv.items.filter((item) => item.id !== live.id);
    conv.view.itemIds = conv.view.itemIds.filter((id) => id !== live.id);
    publishRemove(conv, hub, 'item', live.id);
    if (live.text.trim()) {
      const final: ThreadItem = {
        kind: 'assistant',
        id: nextId(db, 'a'),
        text: live.text,
        pathRefs: refsIn(live.text),
        model: live.model || conv.view.model?.modelId || 'grok-4.6',
        streaming: false,
        truncated: false,
      };
      conv.items.push(final);
      conv.view.itemIds.push(final.id);
      publishItem(conv, hub, final);
    }
  }
  for (const item of conv.items) {
    if (item.kind !== 'tool_group') continue;
    let changed = false;
    for (const toolId of item.toolIds) {
      const tool = conv.tools[toolId];
      if (tool && tool.status === 'running') {
        tool.status = 'interrupted';
        changed = true;
        publishTool(conv, hub, tool, item.id);
      }
    }
    item.live = false;
    item.running = false;
    if (changed) refreshGroup(conv, hub, item, false);
    else publishItem(conv, hub, item);
  }
  conv.run = null;
  conv.view.status = 'idle';
  conv.view.run = {
    status: 'stopped',
    startedAt: null,
    pendingText: null,
    canSend: true,
    canStop: false,
    lockedReason: null,
    error: null,
  };
  conv.pending = null;
  touch(conv);
  publishConversationView(conv, hub);
  publishSummary(db, hub, conv.view.id);
}

export function continueConversation(db: MockDb, conv: MockConv, hub: MockHub): string {
  if (conv.run) return conv.run.id;
  return startRun(db, conv, hub, '继续');
}
