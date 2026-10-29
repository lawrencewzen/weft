import type {
  Bilingual,
  Change,
  ConversationView,
  MockConv,
  MockDb,
  MockGroup,
  MockItem,
  MockTool,
  Provider,
  ResolvedModel,
  RunState,
  Subagent,
  MockSubThread,
  Workspace,
} from './types';
import { MOCK_CATALOG_MODELS } from './piCatalog';
import { seedWebsiteRepo, seedWeftRepo, mockDiff } from './repo';
import { seedGitConnections, seedGitProjects, seedPlugins, seedSkills } from './extensions';
import { seedSubThreads, seedSubagentReports } from './subagents';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const IDLE_RUN: RunState = {
  status: 'idle',
  startedAt: null,
  pendingText: null,
  canSend: true,
  canStop: false,
  lockedReason: null,
  error: null,
};

const DEFAULT_WINDOW = 200_000;

function context(used: number, window = DEFAULT_WINDOW): ConversationView['context'] {
  const percent = Math.min(100, Math.round((used / window) * 100));
  const level = percent >= 95 ? 'full' : percent >= 80 ? 'warn' : 'ok';
  return { used, window, percent, level };
}

function conversation(input: {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: number;
  used: number;
  items: MockItem[];
  tools?: Record<string, MockTool>;
  model?: ConversationView['model'];
  changes?: Change[];
  diffs?: Record<string, MockConv['diffs'][string]>;
  subagents?: Subagent[];
  status?: ConversationView['status'];
  archived?: boolean;
}): MockConv {
  const tools = input.tools || {};
  return {
    view: {
      id: input.id,
      workspaceId: input.workspaceId,
      title: input.title,
      updatedAt: input.updatedAt,
      status: input.status ?? 'idle',
      model: input.model === undefined
        ? { sourceId: 'deepseek', modelId: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' }
        : input.model,
      run: { ...IDLE_RUN },
      context: context(input.used),
      itemIds: input.items.map((item) => item.id),
      sends: [],
    },
    pending: null,
    items: input.items,
    tools,
    changes: input.changes || [],
    diffs: input.diffs || {},
    subagents: input.subagents || [],
    archived: input.archived ?? false,
    run: null,
    requestRuns: new Map(),
  };
}

function user(
  id: string,
  text: string,
  pathRefs: { text: string; path: string; line?: number }[] = [],
): MockItem {
  return { kind: 'user', id, text, pathRefs };
}

function assistant(
  id: string,
  text: string,
  model = 'deepseek-flash',
  pathRefs: { text: string; path: string; line?: number }[] = [],
): MockItem {
  return { kind: 'assistant', id, text, pathRefs, model, streaming: false, truncated: false };
}

function group(
  id: string,
  toolIds: string[],
  summary: Bilingual,
  failed = 0,
  live = false,
): MockGroup {
  return { kind: 'tool_group', id, toolIds, summary, failed, running: false, live };
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

function dispatchTool(id: string, title: string): MockTool {
  return tool({
    id,
    kind: 'other',
    title: hint(title, title),
    hint: hint('已派出', 'spawned'),
    preview: title,
    totalLines: 1,
    output: title,
  });
}

function dispatchToolsOf(threads: Map<string, MockSubThread>, cid: string): Record<string, MockTool> {
  const out: Record<string, MockTool> = {};
  for (const thread of threads.values()) {
    if (thread.view.parentConversationId !== cid) continue;
    const id = thread.view.toolCallId;
    if (!id || out[id]) continue;
    out[id] = dispatchTool(id, thread.view.title || thread.view.name);
  }
  return out;
}

const STORE_READ: MockTool = tool({
  id: 'rich-t1',
  kind: 'read',
  title: hint('web/src/data/store.ts', 'web/src/data/store.ts'),
  path: 'web/src/data/store.ts',
  hint: hint('132 行', '132 lines'),
  preview: [
    'export function createEntityStore(): EntityStore {',
    '  const entities = new Map<string, StoredEntity>();',
    '  const byEntityId = new Map<string, StoredEntity>();',
    '  const missing = new Set<string>();',
    '  const listeners = new Set<Listener>();',
    '  let version = 0;',
  ].join('\n'),
  truncated: true,
  totalLines: 132,
  output: Array.from({ length: 132 }, (_, i) => `export function storeLine${i + 1}() {}`).join('\n'),
});

const STORE_GREP: MockTool = tool({
  id: 'rich-t2',
  kind: 'grep',
  title: hint('applySnapshot', 'applySnapshot'),
  hint: hint('3 处匹配', '3 matches'),
  preview: [
    'web/src/data/store.ts:241:  applySnapshot(event) {',
    'web/src/data/store.test.ts:18:    store.applySnapshot(snapshot)',
    'web/src/data/store.test.ts:44:    store.applySnapshot(empty)',
  ].join('\n'),
  totalLines: 3,
  output: [
    'web/src/data/store.ts:241:  applySnapshot(event) {',
    'web/src/data/store.test.ts:18:    store.applySnapshot(snapshot)',
    'web/src/data/store.test.ts:44:    store.applySnapshot(empty)',
  ].join('\n'),
});

const STORE_MISSING: MockTool = tool({
  id: 'rich-t3',
  kind: 'read',
  title: hint('web/src/data/missing.ts', 'web/src/data/missing.ts'),
  path: 'web/src/data/missing.ts',
  status: 'failed',
  failure: 'real',
  hint: hint('不存在', 'not found'),
  hintFailed: true,
  preview: "ENOENT: no such file or directory, open 'web/src/data/missing.ts'",
  totalLines: 1,
  output: "ENOENT: no such file or directory, open 'web/src/data/missing.ts'",
});

const TEST_RUN: MockTool = tool({
  id: 'rich-t4',
  kind: 'bash',
  title: hint('npm run test:web', 'npm run test:web'),
  hint: hint('退出码 0 · 24 行', 'exit 0 · 24 lines'),
  exitCode: 0,
  preview: [
    '$ npm run test:web',
    '',
    ' RUN  v5.0.2 /work/weft/web',
    '',
    ' ✓ src/data/store.test.ts (12 tests) 38ms',
  ].join('\n'),
  truncated: true,
  totalLines: 24,
  output: [
    '$ npm run test:web',
    '',
    ' RUN  v5.0.2 /work/weft/web',
    '',
    ' ✓ src/data/store.test.ts (12 tests) 38ms',
    ' ✓ src/data/nav.test.ts (2 tests) 9ms',
    ' ✓ src/data/pendingSend.test.ts (9 tests) 14ms',
    ' ✓ src/data/composerModel.test.ts (11 tests) 7ms',
    ' ✓ src/data/stream.test.ts (6 tests) 5ms',
    '',
    ' Test Files  5 passed (5)',
    '      Tests  40 passed (40)',
    '   Start at  10:24:16',
    '   Duration  1.42s',
    '',
    '> weft@0.1.0 test:web',
    '> vitest run --config web/vitest.config.ts',
    '',
    '✓ done',
  ].join('\n'),
});

const STORE_EDIT: MockTool = tool({
  id: 'rich-t5',
  kind: 'edit',
  title: hint('web/src/data/store.ts', 'web/src/data/store.ts'),
  path: 'web/src/data/store.ts',
  diff: { added: 8, removed: 3 },
  preview: [
    '@@ -241,6 +241,9 @@',
    '   applySnapshot(event) {',
    '-    const out = [];',
    '+    const topic = conversationTopic(cid);',
  ].join('\n'),
  totalLines: 9,
});

const EDIT_TEST_RUN: MockTool = tool({
  ...TEST_RUN,
  id: 'rich-t6',
  hint: hint('退出码 0 · 24 行', 'exit 0 · 24 lines'),
});

const RICH_ASSISTANT_ONE = [
  '### 加载顺序',
  '',
  '`items(cid)` 在 `web/src/data/store.ts` 里按 `conversation.itemIds` 的顺序取，不会重排：',
  '',
  '1. 快照到达时 `applySnapshot` 先清空主题，再按 `entities` 顺序写入',
  '2. `text.delta` 只追加到已有 item，偏移对不上时丢掉本地内容，等下一次 `upsert`',
  '3. `tool_group` 的 `toolIds` 由服务端算好，客户端不重建',
  '',
  '```ts',
  'const out: ThreadItem[] = [];',
  'for (const id of conv.itemIds) {',
  "  const rec = get(topic, 'item', id);",
  '  if (rec) out.push(rec.value as unknown as ThreadItem);',
  '}',
  '```',
  '',
  '所以补测试时只要保证 `itemIds` 和 `entities` 一致就行。',
].join('\n');

const RICH_ASSISTANT_TWO = [
  '## 改动',
  '',
  '消息区和输入框共用一个宽度，**两侧各留 48px**。主要改动在 `web/src/data/store.ts:238`，测试补在 `web/src/data/store.test.ts`。',
  '',
  '1. 上限 = 屏幕宽 − 800，收起侧栏不会变宽',
  '2. 下限 560px，侧栏拖得再宽也不低于它',
  '   - 极窄时两侧至少留 16px',
  '   - Windows 传统滚动条用 `scrollbar-gutter` 对齐',
  '3. 空态和有对话时同宽',
  '',
  '| 检查项 | 结果 | 用时 |',
  '| --- | --- | --- |',
  '| npm run check | 通过 | 3.1s |',
  '| npm test | 通过 | 41.8s |',
  '| e2e（Playwright） | 通过 | 1m 52s |',
  '',
  '> 已知小问题：中间栏窄于 592px 时，Windows 下可能多出约 2px 横向滚动。',
  '',
  '### 接下来',
  '',
  '- [x] 合并加载顺序用例',
  '- [x] CI 三项全绿',
  '- [ ] 更新本地服务（会先备份 data 目录）',
  '',
  '本地复跑：',
  '',
  '```bash',
  'npm run check && npm test',
  '```',
].join('\n');

function richConversation(now: number, threads: Map<string, MockSubThread>): MockConv {
  const spawnTools = dispatchToolsOf(threads, 'c-rich');
  const spawnIds = Object.keys(spawnTools);
  const tools: Record<string, MockTool> = {
    [STORE_READ.id]: STORE_READ,
    [STORE_GREP.id]: STORE_GREP,
    [STORE_MISSING.id]: STORE_MISSING,
    [TEST_RUN.id]: TEST_RUN,
    [STORE_EDIT.id]: STORE_EDIT,
    [EDIT_TEST_RUN.id]: EDIT_TEST_RUN,
    ...spawnTools,
  };
  const rich = conversation({
    id: 'c-rich',
    workspaceId: 'ws-weft',
    title: '重构会话列表的加载逻辑',
    updatedAt: now - 4 * MINUTE,
    used: 48_200,
    tools,
    items: [
      user(
        'rich-u1',
        '看一下 `web/src/data/store.ts` 里 items 的加载顺序，顺便把相关单测补上。',
        [{ text: 'web/src/data/store.ts', path: 'web/src/data/store.ts' }],
      ),
      group(
        'rich-g1',
        [STORE_READ.id, STORE_GREP.id, STORE_MISSING.id, TEST_RUN.id],
        {
          zh: '读了 2 个文件 · 搜索了 3 处 · 执行了 1 条命令',
          en: 'read 2 files · searched 3 places · ran 1 command',
        },
        1,
      ),
      assistant(
        'rich-a1',
        RICH_ASSISTANT_ONE,
        'deepseek-flash',
        [{ text: 'web/src/data/store.ts', path: 'web/src/data/store.ts', line: 238 }],
      ),
      group(
        'rich-g2',
        [STORE_EDIT.id, EDIT_TEST_RUN.id],
        { zh: '编辑了 1 个文件 · 执行了 1 条命令', en: 'edited 1 file · ran 1 command' },
      ),
      assistant(
        'rich-a2',
        RICH_ASSISTANT_TWO,
        'deepseek-flash',
        [
          { text: 'web/src/data/store.ts:238', path: 'web/src/data/store.ts', line: 238 },
          { text: 'web/src/data/store.ts', path: 'web/src/data/store.ts' },
          { text: 'web/src/data/store.test.ts', path: 'web/src/data/store.test.ts' },
        ],
      ),
      assistant('rich-a3', '测试全绿。要不要我把这批改动整理成一条提交信息？'),
      ...(spawnIds.length ? [group(
        'rich-g-sa',
        spawnIds,
        { zh: `调用了 ${spawnIds.length} 次工具`, en: `called a tool ${spawnIds.length} times` },
      )] : []),
      ...seedSubagentReports(),
    ],
    changes: [
      { path: 'web/src/data/store.ts', added: 8, removed: 3, error: null, by: { kind: 'main' } },
      { path: 'web/src/data/store.test.ts', added: 12, removed: 0, error: null, by: { kind: 'subagent', agentId: 'c-rich:sub:sa-2', name: 'sub-delta-test' } },
      { path: 'web/src/data/diffView.ts', added: 16, removed: 4, error: null, by: { kind: 'main' } },
      { path: 'web/src/components/ChangesPane.tsx', added: 24, removed: 6, error: null, by: { kind: 'subagent', agentId: 'c-rich:sub:sa-1', name: 'sub-load-order' } },
      { path: 'web/src/components/Thread.tsx', added: 6, removed: 2, error: null, by: { kind: 'main' } },
      { path: 'web/src/styles/app.css', added: 4, removed: 1, error: null, by: { kind: 'main' } },
      { path: 'web/src/data/pendingSend.ts', added: 2, removed: 1, error: null, by: { kind: 'main' } },
      { path: '/Users/lawrence/.config/weft/notes.md', added: 1, removed: 1, error: null, by: { kind: 'main' } },
    ],
    diffs: {
      'web/src/data/store.ts': mockDiff('web/src/data/store.ts', [
        {
          oldStart: 238,
          newStart: 238,
          lines: [
            { op: 'ctx', text: '  function items(cid: string): ThreadItem[] {' },
            { op: 'ctx', text: '    const conv = get(conversationTopic(cid), "conversation", cid);' },
            { op: 'del', text: '    const ids = conv?.value?.itemIds || [];' },
            { op: 'del', text: '    return ids.map((id) => get(topic, "item", id));' },
            { op: 'add', text: '    const out: ThreadItem[] = [];' },
            { op: 'add', text: '    for (const id of conv?.value?.itemIds || []) {' },
            { op: 'add', text: '      const rec = get(topic, "item", id);' },
            { op: 'add', text: '      if (rec) out.push(rec.value as unknown as ThreadItem);' },
            { op: 'add', text: '    }' },
            { op: 'add', text: '    return out;' },
            { op: 'ctx', text: '  }' },
            { op: 'ctx', text: '' },
            { op: 'ctx', text: '  function notify(): void {' },
          ],
        },
        {
          oldStart: 296,
          newStart: 302,
          lines: [
            { op: 'ctx', text: '  function put(rec: StoredEntity): void {' },
            { op: 'del', text: '    const key = `${rec.topic}:${rec.entity}:${rec.id}`;' },
            { op: 'add', text: '    const key = `${rec.topic}\\t${rec.entity}\\t${rec.id}`;' },
            { op: 'ctx', text: '    entities.set(key, rec);' },
            { op: 'add', text: '    if (rec.entity === "item") staleItems.delete(rec.id);' },
            { op: 'ctx', text: '  }' },
          ],
        },
      ]),
      'web/src/data/store.test.ts': mockDiff('web/src/data/store.test.ts', [
        {
          oldStart: 40,
          newStart: 40,
          lines: [
            { op: 'ctx', text: "describe('text.delta', () => {" },
            { op: 'ctx', text: "  it('appends on a matching offset', () => {" },
            { op: 'add', text: '    const store = createEntityStore();' },
            { op: 'add', text: "    applySnapshot(store, snapshot(['a']));" },
            { op: 'add', text: "    textDelta(store, { topic: 'conversation:c1', itemId: 'a', offset: 0, append: 'hi' });" },
            { op: 'add', text: "    expect(store.items('c1')[0]?.text).toBe('hi');" },
            { op: 'add', text: '  });' },
            { op: 'add', text: '' },
            { op: 'add', text: "  it('marks stale when the offset does not match', () => {" },
            { op: 'add', text: '    const store = createEntityStore();' },
            { op: 'add', text: "    applySnapshot(store, snapshot(['a']));" },
            { op: 'add', text: "    textDelta(store, { topic: 'conversation:c1', itemId: 'a', offset: 9, append: 'x' });" },
            { op: 'add', text: "    expect(store.needsFullValue('a')).toBe(true);" },
            { op: 'add', text: '  });' },
            { op: 'ctx', text: '});' },
          ],
        },
      ]),
      'web/src/data/diffView.ts': mockDiff('web/src/data/diffView.ts', [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { op: 'ctx', text: 'export function numberDiffLines(hunk) {' },
            { op: 'del', text: '  let oldLine = hunk.oldStart;' },
            { op: 'add', text: '  let oldLine = Number(hunk.oldStart) || 1;' },
            { op: 'add', text: '  let newLine = Number(hunk.newStart) || 1;' },
            { op: 'ctx', text: '  return hunk.lines.map((line) => {' },
            { op: 'add', text: '    if (!line) return { op: "ctx", text: "", oldLine: null, newLine: null };' },
            { op: 'add', text: '    // keep numbering consecutive across ops' },
          ],
        },
      ]),
      'web/src/components/ChangesPane.tsx': mockDiff('web/src/components/ChangesPane.tsx', [
        {
          oldStart: 3,
          newStart: 3,
          lines: [
            { op: 'ctx', text: '  const { visibleChanges, totals, openPaths, toggleChange, diffs } = useRightPane();' },
            { op: 'del', text: '  if (!visibleChanges.length) return <div className="pane-empty">{t(lang, "no_changes_yet")}</div>;' },
            { op: 'add', text: '  if (!visibleChanges.length) {' },
            { op: 'add', text: '    return <div className="pane-empty">{t(lang, "no_changes_yet")}</div>;' },
            { op: 'add', text: '  }' },
            { op: 'ctx', text: '  return (' },
            { op: 'del', text: '    <div className="changes-pane">' },
            { op: 'add', text: '    <div className="changes-pane" data-testid="next-changes-pane">' },
            { op: 'add', text: '      {/* by: 子 · sub-load-order */}' },
          ],
        },
      ]),
      'web/src/components/Thread.tsx': mockDiff('web/src/components/Thread.tsx', [
        {
          oldStart: 240,
          newStart: 240,
          lines: [
            { op: 'ctx', text: '        {!empty && changes.length ? (' },
            { op: 'del', text: '          <ChangeSummary changes={changes} lang={lang} />' },
            { op: 'del', text: '        ) : null}' },
            { op: 'add', text: '          <ChangeSummary changes={changes} lang={lang} />' },
            { op: 'add', text: '        ) : null}' },
            { op: 'add', text: '        {/* redesigned summary */}' },
            { op: 'add', text: '        {/* 10-28 */}' },
            { op: 'add', text: '        {/* scrollable */}' },
            { op: 'add', text: '        {/* tag */}' },
          ],
        },
      ]),
      'web/src/styles/app.css': mockDiff('web/src/styles/app.css', [
        {
          oldStart: 840,
          newStart: 840,
          lines: [
            { op: 'del', text: '.change-summary { padding: 10px; }' },
            { op: 'add', text: '.change-summary { border-radius: 12px; }' },
            { op: 'add', text: '.change-summary-head { height: 40px; }' },
            { op: 'add', text: '.change-summary-row { height: 30px; }' },
            { op: 'add', text: '.change-summary-more { height: 32px; }' },
          ],
        },
      ]),
      'web/src/data/pendingSend.ts': mockDiff('web/src/data/pendingSend.ts', [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { op: 'del', text: 'export const PENDING_TIMEOUT = 1000;' },
            { op: 'add', text: 'export const PENDING_TIMEOUT = 2000;' },
            { op: 'add', text: '// updated timeout' },
          ],
        },
      ]),
      '/Users/lawrence/.config/weft/notes.md': mockDiff('/Users/lawrence/.config/weft/notes.md', [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { op: 'del', text: '# old user notes' },
            { op: 'add', text: '# updated user notes' },
          ],
        },
      ]),
    },
    subagents: [...threads.values()]
      .filter((thread) => thread.view.parentConversationId === 'c-rich')
      .map((thread) => thread.view),
    status: 'running',
  });
  rich.view.run = {
    status: 'running',
    startedAt: now - 42_000,
    pendingText: '正在编辑 public/app.css',
    canSend: true,
    canStop: true,
    lockedReason: null,
    error: null,
  };
  rich.pending = { zh: '正在编辑 public/app.css', en: 'Editing public/app.css' };
  rich.run = {
    id: 'run-seed-rich',
    cancelled: false,
    steers: [],
    followUps: [{ requestId: 'seed-queue-1', text: '顺便把深色模式也检查一下' }],
  };
  rich.view.sends = [{
    requestId: 'seed-queue-1',
    entryId: null,
    dropped: false,
    mode: 'queue',
    text: '顺便把深色模式也检查一下',
  }];
  return rich;
}

function testsConversation(now: number): MockConv {
  const grep = tool({
    id: 'tests-t1',
    kind: 'grep',
    title: hint('heartbeat', 'heartbeat'),
    hint: hint('2 处匹配', '2 matches'),
    preview: 'web/src/data/stream.ts:74:    es.addEventListener(\'heartbeat\'\nweb/src/data/stream.test.ts:61:  it(\'ignores heartbeat data\')',
    totalLines: 2,
  });
  return conversation({
    id: 'c-tests',
    workspaceId: 'ws-weft',
    title: 'heartbeat 要不要单测',
    updatedAt: now - 52 * MINUTE,
    used: 12_800,
    status: 'waiting',
    tools: { [grep.id]: grep },
    items: [
      user('tests-u1', '事件流里的 heartbeat 需要单独写用例吗？'),
      group('tests-g1', [grep.id], { zh: '搜索了 2 处', en: 'searched 2 places' }),
      assistant(
        'tests-a1',
        [
          '需要。`heartbeat` 不带 id、不进环形缓冲，最容易在续传时写错：',
          '',
          '- 断言收到心跳后 `status` 仍是 `connected`',
          '- 断言心跳不会推进 `lastEventId`',
          '',
          '现有的 `web/src/data/stream.test.ts` 已经有 6 个用例，补一条就够。',
        ].join('\n'),
        'deepseek-flash',
        [{ text: 'web/src/data/stream.test.ts', path: 'web/src/data/stream.test.ts' }],
      ),
    ],
  });
}

function docsConversation(now: number, threads: Map<string, MockSubThread>): MockConv {
  const spawnTools = dispatchToolsOf(threads, 'c-docs');
  const spawnIds = Object.keys(spawnTools);
  return conversation({
    id: 'c-docs',
    workspaceId: 'ws-weft',
    title: '把架构文档的图补上',
    updatedAt: now - 3 * HOUR,
    used: 172_000,
    model: { sourceId: 'deepseek', modelId: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    tools: spawnTools,
    subagents: [...threads.values()]
      .filter((thread) => thread.view.parentConversationId === 'c-docs')
      .map((thread) => thread.view),
    items: [
      user('docs-u1', 'docs/ARCHITECTURE_V2.md 里还缺一张主题和事件的关系图。'),
      ...(spawnIds.length ? [group(
        'docs-g-sa',
        spawnIds,
        { zh: '调用了 1 次工具', en: 'called a tool 1 time' },
      )] : []),
      assistant(
        'docs-a1',
        [
          '可以补成三段：',
          '',
          '1. 主题：`workspaces`、`providers`、`extensions`、`conversation:<id>`',
          '2. 事件：`snapshot` → `upsert` / `remove` / `text.delta`',
          '3. 客户端：`createEntityStore()` 只做覆盖，不重排',
          '',
          '要我用 mermaid 画成代码块吗？',
        ].join('\n'),
        'deepseek-v4-pro',
      ),
    ],
  });
}

function scriptsConversation(now: number): MockConv {
  const bash = tool({
    id: 'scripts-t1',
    kind: 'bash',
    title: hint('node --version', 'node --version'),
    hint: hint('退出码 0 · 1 行', 'exit 0 · 1 line'),
    exitCode: 0,
    preview: 'v22.19.0',
    totalLines: 1,
    output: 'v22.19.0',
  });
  return conversation({
    id: 'c-scripts',
    workspaceId: 'ws-weft',
    title: '整理 Windows 下的启动脚本',
    updatedAt: now - 6 * HOUR,
    used: 9_100,
    status: 'failed',
    tools: { [bash.id]: bash },
    items: [
      user('scripts-u1', '内网那台 Windows 机器装的是 Node 22，启动脚本要检查一下。'),
      group('scripts-g1', [bash.id], { zh: '执行了 1 条命令', en: 'ran 1 command' }),
      assistant(
        'scripts-a1',
        [
          '`scripts/dev.sh` 在 Windows 上要用 Git Bash 跑，建议加一份 `scripts/dev.ps1`：',
          '',
          '```powershell',
          '$env:WEFT_LLM = "faux"',
          'npm run dev:web',
          '```',
          '',
          'Node 22 满足 `engines >= 22.19`。',
        ].join('\n'),
      ),
    ],
  });
}

function gitConversation(now: number): MockConv {
  return conversation({
    id: 'c-git',
    workspaceId: 'ws-weft',
    title: '分支和提交信息约定',
    updatedAt: now - 2 * DAY,
    used: 3_200,
    items: [
      user('git-u1', '这个仓库的提交信息用什么格式？'),
      assistant(
        'git-a1',
        '中文标题写清结果，正文说明改了什么、为什么。分支上用 `t<编号>-<短名>`，只有编排者往 `main` 合并。',
      ),
    ],
  });
}

function siteOne(now: number): MockConv {
  return conversation({
    id: 'c-site-1',
    workspaceId: 'ws-website',
    title: '落地页首屏文案',
    updatedAt: now - 20 * MINUTE,
    used: 22_600,
    status: 'running',
    model: { sourceId: 'deepseek', modelId: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    items: [
      user('site-u1', '首屏那句 slogan 再收一点，别太像广告。'),
      assistant(
        'site-a1',
        [
          '试三个方向：',
          '',
          '| 方向 | 文案 |',
          '| --- | --- |',
          '| 克制 | 把需求交给一个会拆活的 Agent |',
          '| 具体 | 一个对话，从需求到提交 |',
          '| 直白 | 你的本地编码工作台 |',
          '',
          '我倾向「具体」那条，和实际界面能对上。',
        ].join('\n'),
        'deepseek-v4-pro',
      ),
    ],
  });
}

function siteTwo(now: number): MockConv {
  return conversation({
    id: 'c-site-2',
    workspaceId: 'ws-website',
    title: '截图换成 4K 导出',
    updatedAt: now - 4 * DAY,
    used: 4_800,
    items: [
      user('site-u2', '效果图统一导 4K，别再用 2x 截图。'),
      assistant('site-a2', '已经在 `design/` 里按 3840 宽导出，`mockup-v2-white.png` 换成了 4K 版本。'),
    ],
  });
}

function archivedOne(now: number): MockConv {
  return conversation({
    id: 'c-arch-1',
    workspaceId: 'ws-weft',
    title: '重构旧版本迁移脚本',
    updatedAt: now - 14 * DAY,
    used: 18_400,
    items: [
      user('arch1-u1', '把 v1 的迁移逻辑写个文档归档。'),
      assistant('arch1-a1', '已将 v1 迁移脚本文档归档到 docs/archive/migration-v1.md。'),
    ],
    archived: true,
  });
}

function archivedTwo(now: number): MockConv {
  return conversation({
    id: 'c-arch-2',
    workspaceId: 'ws-website',
    title: '初版官网设计草稿',
    updatedAt: now - 30 * DAY,
    used: 12_100,
    items: [
      user('arch2-u1', '最初的 landing page 草稿留一份备份。'),
      assistant('arch2-a1', '已在 design/v1/ 留存归档。'),
    ],
    archived: true,
  });
}

function seedProviders(now: number): Provider[] {
  return [
    {
      id: 'deepseek',
      kind: 'builtin',
      brand: 'DeepSeek',
      name: 'DeepSeek',
      auth: { type: 'api_key', keyTail: '75e2' },
      status: { state: 'ok', testedAt: now - 180_000 },
      models: (MOCK_CATALOG_MODELS.deepseek || []).map((m) => ({ ...m, enabled: true })),
    },
    {
      id: 'anthropic',
      kind: 'builtin',
      brand: 'Anthropic',
      name: 'Anthropic',
      auth: { type: 'oauth', account: 'Claude Max · lawrence@…' },
      status: { state: 'untested' },
      models: (MOCK_CATALOG_MODELS.anthropic || []).map((m, idx) => ({
        ...m,
        enabled: idx === 1 || idx === 4,
      })),
    },
    {
      id: 'custom-9f01',
      kind: 'custom',
      brand: null,
      name: '内网网关',
      baseUrl: 'http://10.8.0.12:8000/v1',
      api: 'openai-completions',
      auth: { type: 'api_key', keyTail: '9f01' },
      status: {
        state: 'error',
        testedAt: now - 10_000,
        error: '401 Unauthorized · Invalid API key',
      },
      models: [
        {
          id: 'qwen3-coder-480b',
          name: 'qwen3-coder-480b',
          brand: 'Qwen',
          enabled: true,
          contextWindow: 262144,
          maxTokens: 65536,
          images: false,
          reasoning: false,
          overridden: {},
        },
        {
          id: 'glm-5.2-fp8',
          name: 'glm-5.2-fp8',
          brand: 'ZAI',
          enabled: true,
          contextWindow: null,
          maxTokens: null,
          images: false,
          reasoning: true,
          overridden: {},
        },
        {
          id: 'bge-m3',
          name: 'bge-m3',
          brand: null,
          enabled: false,
          contextWindow: 8192,
          maxTokens: null,
          images: false,
          reasoning: false,
          overridden: {},
        },
      ],
    },
  ];
}

const DEFAULT_MODEL: ResolvedModel = { providerId: 'deepseek', modelId: 'deepseek-flash' };

function workspace(
  input: Pick<Workspace, 'id' | 'name' | 'path' | 'git'> & Partial<Workspace>,
): Workspace {
  return {
    source: 'local',
    gitUrl: null,
    branch: null,
    conversationCount: 0,
    runningCount: 0,
    ...input,
  };
}

export function createSeed(now: number): MockDb {
  const subagents = seedSubThreads(now);
  const conversations = [
    richConversation(now, subagents),
    testsConversation(now),
    docsConversation(now, subagents),
    scriptsConversation(now),
    gitConversation(now),
    siteOne(now),
    siteTwo(now),
    archivedOne(now),
    archivedTwo(now),
  ];
  const workspaces: Workspace[] = [
    workspace({
      id: 'ws-weft',
      name: 'weft',
      path: 'D:\\work\\weft',
      git: {
        branch: 'main',
        detached: false,
        changedFiles: 3,
        insertions: 42,
        deletions: 7,
        ahead: 2,
        behind: 0,
      },
    }),
    workspace({
      id: 'ws-website',
      name: 'website',
      path: 'D:\\work\\website',
      git: {
        branch: 'feat/landing-page',
        detached: false,
        changedFiles: 1,
        insertions: 18,
        deletions: 4,
        ahead: 0,
        behind: 1,
      },
    }),
  ];
  for (const ws of workspaces) {
    const rows = conversations.filter((conv) => conv.view.workspaceId === ws.id && !conv.archived);
    ws.conversationCount = rows.length;
    ws.runningCount = rows.filter((conv) => conv.view.status === 'running').length;
  }
  return {
    workspaces,
    conversations: new Map(conversations.map((conv) => [conv.view.id, conv])),
    providers: seedProviders(now),
    defaultModel: { ...DEFAULT_MODEL },
    loginSessions: new Map(),
    repos: new Map([
      ['ws-weft', seedWeftRepo()],
      ['ws-website', seedWebsiteRepo()],
    ]),
    plugins: seedPlugins(),
    skills: seedSkills(),
    gitConnections: seedGitConnections(now),
    gitProjects: seedGitProjects(now),
    subagents,
    seq: 0,
    messageImages: new Map(),
    messagePastes: new Map(),
    workspaceUploads: new Map(),
  };
}
