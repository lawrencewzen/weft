import type {
  Bilingual,
  Change,
  ConversationView,
  GlabSettings,
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
import { seedWebsiteRepo, seedWeftRepo, mockDiff, createRepo } from './repo';
import { inferCustomProviderBrand, inferModelBrand } from './brand';
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
  lastActivityAt: null,
  stalledSince: null,
  activeTool: null,
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
  thinkingLevel?: ConversationView['thinkingLevel'];
  changes?: Change[];
  diffs?: Record<string, MockConv['diffs'][string]>;
  subagents?: Subagent[];
  status?: ConversationView['status'];
  run?: RunState;
  archived?: boolean;
  error?: MockConv['error'];
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
      thinkingLevel: input.thinkingLevel !== undefined
        ? input.thinkingLevel
        : (input.model === null ? null : (input.model?.modelId === 'claude-fable-5-1' ? 'medium' : 'high')),
      run: input.run ? { ...input.run } : { ...IDLE_RUN },
      context: context(input.used),
      itemIds: input.items.map((item) => item.id),
      sends: [],
    },
    pending: null,
    error: input.error || null,
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
  truncated = false,
): MockItem {
  return { kind: 'assistant', id, text, pathRefs, model, streaming: false, truncated };
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
  const richChanges: Change[] = [
    { path: 'web/src/data/store.ts', added: 8, removed: 3, error: null, by: { kind: 'main' }, status: 'modified' },
    { path: 'web/src/data/store.test.ts', added: 12, removed: 0, error: null, by: { kind: 'subagent', agentId: 'c-rich:sub:sa-2', name: 'sub-delta-test' }, status: 'added' },
    { path: 'web/src/data/diffView.ts', added: 16, removed: 4, error: null, by: { kind: 'main' } },
    { path: 'web/src/components/ChangesPane.tsx', added: 24, removed: 6, error: null, by: { kind: 'subagent', agentId: 'c-rich:sub:sa-1', name: 'sub-load-order' } },
    { path: 'web/src/components/Thread.tsx', added: 6, removed: 2, error: null, by: { kind: 'main' } },
    { path: 'web/src/styles/app.css', added: 0, removed: 0, error: null, by: { kind: 'main' }, status: 'renamed', oldPath: 'web/src/styles/base.css' },
    { path: 'web/src/data/pendingSend.ts', added: 0, removed: 3, error: null, by: null, status: 'deleted' },
    { path: '/Users/lawrence/.config/weft/notes.md', added: 7, removed: 0, error: null, by: { kind: 'main' } },
  ];
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
      assistant(
        'rich-a3',
        [
          '测试全绿。详细说明见 [内核入口](file:///Users/lawrence/Projects/weft/src/kernel/index.mjs#L1-L5)，样式定义参见 [app.css](web/src/styles/app.css)。',
          '要不要我把这批改动整理成一条提交信息？',
        ].join('\n'),
        'deepseek-flash',
        [
          {
            text: 'file:///Users/lawrence/Projects/weft/src/kernel/index.mjs#L1-L5',
            path: 'src/kernel/index.mjs',
            line: 1,
          },
          {
            text: 'web/src/styles/app.css',
            path: 'web/src/styles/app.css',
          },
        ],
      ),
      ...(spawnIds.length ? [group(
        'rich-g-sa',
        spawnIds,
        { zh: `调用了 ${spawnIds.length} 次工具`, en: `called a tool ${spawnIds.length} times` },
      )] : []),
      ...seedSubagentReports(),
      {
        kind: 'turn_changes',
        id: 'rich-tc1',
        changes: richChanges.map((c) => ({ ...c })),
      },
      user('rich-u2', '你好'),
    ],
    changes: richChanges,
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
      'web/src/styles/app.css': mockDiff('web/src/styles/app.css', []),
      'web/src/data/pendingSend.ts': mockDiff('web/src/data/pendingSend.ts', [
        {
          oldStart: 1,
          newStart: 0,
          lines: [
            { op: 'del', text: 'export const PENDING_TIMEOUT = 1000;' },
            { op: 'del', text: 'export const PENDING_MAX = 5000;' },
            { op: 'del', text: '// updated timeout' },
          ],
        },
      ]),
      '/Users/lawrence/.config/weft/notes.md': mockDiff('/Users/lawrence/.config/weft/notes.md', [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { op: 'add', text: '# updated user notes' },
            { op: 'add', text: '- note 1' },
            { op: 'add', text: '- note 2' },
            { op: 'add', text: '- note 3' },
            { op: 'add', text: '- note 4' },
            { op: 'add', text: '- note 5' },
            { op: 'add', text: '- note 6' },
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
    lastActivityAt: now - 8_000,
    stalledSince: null,
    activeTool: null,
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

function failedConversation(now: number): MockConv {
  return conversation({
    id: 'c-failed',
    workspaceId: 'ws-weft',
    title: '模型调用失败',
    updatedAt: now - 10 * MINUTE,
    used: 12_000,
    status: 'failed',
    error: {
      code: 'model_failed',
      message: hint('模型请求失败：503 Service Unavailable', 'Model request failed: 503 Service Unavailable'),
      canContinue: true,
    },
    run: {
      ...IDLE_RUN,
      status: 'failed',
      error: {
        code: 'model_failed',
        message: '模型请求失败：503 Service Unavailable',
        canContinue: true,
      },
    },
    items: [
      user('failed-u1', '帮我分析一下系统性能瓶颈并提出优化建议。'),
    ],
  });
}

function interruptedConversation(now: number): MockConv {
  return conversation({
    id: 'c-interrupted',
    workspaceId: 'ws-weft',
    title: '服务中断',
    updatedAt: now - 12 * MINUTE,
    used: 18_000,
    status: 'failed',
    error: {
      code: 'interrupted',
      message: hint('服务中断，这一轮没有完成。', 'Service interrupted, this turn did not complete.'),
      canContinue: true,
    },
    run: {
      ...IDLE_RUN,
      status: 'failed',
      error: {
        code: 'interrupted',
        message: '服务中断，这一轮没有完成。',
        canContinue: true,
      },
    },
    items: [
      user('interrupted-u1', '请分析当前路由模块的整体架构，并给出详细的重构方案和代码草稿。'),
      assistant(
        'interrupted-a1',
        [
          '### 路由模块现状分析',
          '',
          '目前路由集中在单一入口文件中，包含以下问题：',
          '1. **职责过重**：协议校验、路由分发、错误捕获均在同一函数中。',
          '2. **扩展性差**：新增接口需要改动多处核心映射表。',
          '3. **测试困难**：无法单独针对单个路由分支进行单测。',
          '',
          '### 建议重构方案',
          '- 将每个子路由拆分为独立的 handler。',
          '- 统一错误拦截器处理 4xx 和 5xx。',
          '- 使用中间件链管理鉴权和上下文注入。',
          '',
          '### 代码重构示意',
          '```ts',
          '// router.ts',
          'export interface RouteHandler {',
          '  path: string;',
          '  method: "GET" | "POST" | "PUT" | "DELETE";',
          '  handle(req: Request): Promise<Response>;',
          '}',
          '',
          'export class Router {',
          '  private routes = new Map<string, RouteHandler>();',
          '',
          '  register(route: RouteHandler) {',
          '    this.routes.set(`${route.method}:${route.path}`, route);',
          '  }',
          '',
          '  async dispatch(req: Request): Promise<Response> {',
          '    const key = `${req.method}:${req.url}`;',
          '    const handler = this.routes.get(key);',
          '    if (!handler) {',
          '      return new Response("Not Found", { status: 404 });',
          '    }',
          '    try {',
          '      return await handler.handle(req);',
          '    } catch (err) {',
          '      return this.handleError(err);',
          '    }',
          '  }',
          '',
          '  private handleError(err: unknown): Response {',
          '    console.error("Route error:", err);',
          '    return new Response("Internal Server Error", { status: 500 });',
          '  }',
          '}',
          '```',
          '',
          '### 实施步骤',
          '1. 创建统一错误拦截中间件。',
          '2. 迁移基础会话路由。',
          '3. 迁移配置和凭据接口。',
          '4. 增加集成测试覆盖率。',
        ].join('\n'),
      ),
      user('interrupted-u2', '重构路由模块并添加错误拦截器。'),
    ],
  });
}

function noModelFailedConversation(now: number): MockConv {
  return conversation({
    id: 'c-no-model-failed',
    workspaceId: 'ws-weft',
    title: '未配置模型',
    updatedAt: now - 14 * MINUTE,
    used: 1_000,
    status: 'failed',
    model: null,
    thinkingLevel: null,
    error: {
      code: 'no_model',
      message: hint('未配置可用模型，无法发起调用。', 'No model configured, cannot run.'),
      canContinue: false,
    },
    run: {
      ...IDLE_RUN,
      status: 'failed',
      error: {
        code: 'no_model',
        message: '未配置可用模型，无法发起调用。',
        canContinue: false,
      },
    },
    items: [
      user('nomodel-u1', '帮我检查代码。'),
    ],
  });
}

function truncatedConversation(now: number): MockConv {
  return conversation({
    id: 'c-truncated',
    workspaceId: 'ws-weft',
    title: '输出截断示例',
    updatedAt: now - 16 * MINUTE,
    used: 64_000,
    status: 'idle',
    items: [
      user('truncated-u1', '请列出所有已废弃的旧版本接口和迁移说明。'),
      assistant(
        'truncated-a1',
        [
          '以下是已废弃接口的整理（按模块划分）：',
          '',
          '1. `/api/legacy/export`：原旧版导出功能，改用 `/api/v2/conversations/{id}` 快照',
          '2. `/api/legacy/status`：原轮询状态接口，改用 `/api/v2/events` SSE 流',
          '3. `/api/legacy/tools`：原独立工具列表，合并进对话视图',
          '4. `/api/legacy/config`：配置项迁移至 `/api/v2/providers`',
        ].join('\n'),
        'deepseek-flash',
        [],
        true,
      ),
    ],
  });
}

function compactedConversation(now: number): MockConv {
  return conversation({
    id: 'c-compacted',
    workspaceId: 'ws-weft',
    title: '压缩过的长对话',
    updatedAt: now - 14 * MINUTE,
    used: 36_000,
    items: [
      user('compacted-u1', '把 store 里的订阅逻辑拆成独立模块。'),
      assistant('compacted-a1', '已经拆成 `subscribe.ts`，store 只保留数据读写。'),
      {
        kind: 'system_note',
        id: 'compacted-n1',
        noteKind: 'compaction',
        text: '已压缩较早的上下文',
        i18n: hint('已压缩较早的上下文', 'Earlier context was compacted'),
      },
      user('compacted-u2', '再补一组订阅取消的单测。'),
      assistant('compacted-a2', '补了 3 个用例，覆盖重复取消和取消后不再收到事件。'),
    ],
  });
}

function compactFailedConversation(now: number): MockConv {
  const conv = conversation({
    id: 'c-compact-failed',
    workspaceId: 'ws-weft',
    title: '压缩失败示例',
    updatedAt: now - 15 * MINUTE,
    used: 168_000,
    items: [
      user('cfail-u1', '继续梳理剩下的接口迁移清单。'),
      assistant('cfail-a1', '清单已经整理到第 6 项，剩余部分见下一条。'),
    ],
  });
  conv.compactFails = true;
  conv.compaction = {
    state: 'failed',
    trigger: 'threshold',
    error: hint('压缩失败：模型请求超时', 'Compaction failed: model request timed out'),
  };
  return conv;
}

/** 持续处于重试中：模型请求失败，服务端在等下一次重试。pendingText 是服务端出好的人话。 */
function retryingConversation(now: number): MockConv {
  const conv = conversation({
    id: 'c-retrying',
    workspaceId: 'ws-weft',
    title: '模型连不上，正在重试',
    updatedAt: now - 18 * MINUTE,
    used: 9_000,
    status: 'running',
    items: [
      user('retrying-u1', '把 README 里的安装步骤补全。'),
    ],
  });
  conv.view.run = {
    status: 'running',
    startedAt: now - 90_000,
    pendingText: null,
    canSend: true,
    canStop: true,
    lockedReason: null,
    error: null,
    lastActivityAt: now - 30_000,
    stalledSince: null,
    activeTool: null,
    retry: { attempt: 6, maxAttempts: 10, kind: 'network' },
  };
  conv.pending = {
    zh: '连不上模型服务，正在重试（第 6 次，共 10 次）',
    en: 'Cannot reach the model service, retrying (attempt 6 of 10)',
  };
  conv.run = { id: 'run-seed-retrying', cancelled: false, steers: [], followUps: [] };
  return conv;
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
  const docsEdit = tool({
    id: 'docs-t1',
    kind: 'edit',
    title: hint('docs/ARCHITECTURE_V2.md', 'docs/ARCHITECTURE_V2.md'),
    path: 'docs/ARCHITECTURE_V2.md',
    diff: { added: 18, removed: 0 },
  });
  const docsChanges: Change[] = [
    {
      path: 'docs/ARCHITECTURE_V2.md',
      added: 18,
      removed: 0,
      error: null,
      by: { kind: 'main' },
      status: 'modified',
    },
  ];
  return conversation({
    id: 'c-docs',
    workspaceId: 'ws-weft',
    title: '把架构文档的图补上',
    updatedAt: now - 3 * HOUR,
    used: 172_000,
    model: { sourceId: 'deepseek', modelId: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    tools: {
      ...spawnTools,
      [docsEdit.id]: docsEdit,
    },
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
      user('docs-u2', '画吧，直接加到架构文档末尾。'),
      group(
        'docs-g1',
        [docsEdit.id],
        { zh: '编辑了 1 个文件', en: 'edited 1 file' },
      ),
      assistant(
        'docs-a2',
        '已经把关系图补在 `docs/ARCHITECTURE_V2.md` 末尾。',
        'deepseek-v4-pro',
        [{ text: 'docs/ARCHITECTURE_V2.md', path: 'docs/ARCHITECTURE_V2.md' }],
      ),
      {
        kind: 'turn_changes',
        id: 'docs-tc1',
        changes: docsChanges.map((c) => ({ ...c })),
      },
    ],
    changes: docsChanges,
    diffs: {
      'docs/ARCHITECTURE_V2.md': mockDiff('docs/ARCHITECTURE_V2.md', [
        {
          oldStart: 120,
          newStart: 120,
          lines: [
            { op: 'add', text: '```mermaid' },
            { op: 'add', text: 'flowchart TD' },
            { op: 'add', text: '  subgraph 主题' },
            { op: 'add', text: '    W[workspaces] --> C[conversation:id]' },
            { op: 'add', text: '    P[providers] --> C' },
            { op: 'add', text: '  end' },
            { op: 'add', text: '  subgraph 事件' },
            { op: 'add', text: '    S[snapshot] --> U[upsert]' },
            { op: 'add', text: '    U --> D[text.delta]' },
            { op: 'add', text: '  end' },
            { op: 'add', text: '```' },
          ],
        },
      ]),
    },
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

function siteOne(now: number, threads: Map<string, MockSubThread>): MockConv {
  const spawnTools = dispatchToolsOf(threads, 'c-site-1');
  const spawnIds = Object.keys(spawnTools);
  const conv = conversation({
    id: 'c-site-1',
    workspaceId: 'ws-website',
    title: '落地页首屏文案',
    updatedAt: now - 20 * MINUTE,
    used: 22_600,
    status: 'running',
    model: { sourceId: 'deepseek', modelId: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    tools: spawnTools,
    subagents: [...threads.values()]
      .filter((thread) => thread.view.parentConversationId === 'c-site-1')
      .map((thread) => thread.view),
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
      ...(spawnIds.length ? [group(
        'site-g-sa',
        spawnIds,
        { zh: `调用了 ${spawnIds.length} 次工具`, en: `called a tool ${spawnIds.length} times` },
      )] : []),
    ],
  });
  conv.view.run = {
    status: 'running',
    startedAt: now - 9 * MINUTE,
    pendingText: null,
    canSend: true,
    canStop: true,
    lockedReason: null,
    error: null,
    lastActivityAt: now - 4 * MINUTE,
    stalledSince: now - 4 * MINUTE,
    activeTool: { name: 'bash', startedAt: now - 5 * MINUTE, summary: 'npm run build -- --watch' },
  };
  conv.run = { id: 'run-seed-site-1', cancelled: false, steers: [], followUps: [] };
  return conv;
}

function siteTwo(now: number): MockConv {
  const conv = conversation({
    id: 'c-site-2',
    workspaceId: 'ws-website',
    title: '截图换成 4K 导出',
    updatedAt: now - 5 * MINUTE,
    used: 4_800,
    status: 'running',
    model: { sourceId: 'deepseek', modelId: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    items: [
      user('site-u2', '效果图统一导 4K，别再用 2x 截图。'),
      assistant('site-a2', '已经在 `design/` 里按 3840 宽导出，正在生成 4K 预览图。'),
    ],
  });
  conv.view.run = {
    status: 'running',
    startedAt: now - 10 * MINUTE,
    pendingText: null,
    canSend: true,
    canStop: true,
    lockedReason: null,
    error: null,
    lastActivityAt: now - 5 * MINUTE,
    stalledSince: now - 5 * MINUTE,
    activeTool: { name: 'bash', startedAt: now - 6 * MINUTE, summary: 'npm run export:4k' },
  };
  conv.run = { id: 'run-seed-site-2', cancelled: false, steers: [], followUps: [] };
  return conv;
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
      brand: 'deepseek',
      name: 'DeepSeek',
      auth: { type: 'api_key', keyTail: '75e2' },
      status: { state: 'ok', testedAt: now - 180_000 },
      models: (MOCK_CATALOG_MODELS.deepseek || []).map((m) => ({ ...m, enabled: true })),
    },
    {
      id: 'anthropic',
      kind: 'builtin',
      brand: 'anthropic',
      name: 'Anthropic',
      auth: { type: 'api_key', keyTail: 'k7Qa' },
      status: { state: 'untested' },
      models: (MOCK_CATALOG_MODELS.anthropic || []).map((m, idx) => ({
        ...m,
        enabled: idx === 1 || idx === 4,
      })),
    },
    {
      id: 'custom-deepseek',
      kind: 'custom',
      brand: inferCustomProviderBrand([
        { brand: inferModelBrand('DeepSeek-V3.2') },
        { brand: inferModelBrand('deepseek-chat') },
      ]),
      name: '自建 DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      auth: { type: 'api_key', keyTail: '4d2e' },
      status: { state: 'ok', testedAt: now - 30_000 },
      models: [
        {
          id: 'DeepSeek-V3.2',
          name: 'DeepSeek-V3.2',
          brand: inferModelBrand('DeepSeek-V3.2'),
          enabled: true,
          contextWindow: 131072,
          maxTokens: 8192,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          overridden: {},
        },
        {
          id: 'deepseek-chat',
          name: 'deepseek-chat',
          brand: inferModelBrand('deepseek-chat'),
          enabled: true,
          contextWindow: 65536,
          maxTokens: 8192,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          overridden: {},
        },
      ],
    },
    {
      id: 'custom-glm',
      kind: 'custom',
      brand: inferCustomProviderBrand([
        { brand: inferModelBrand('GLM4.7') },
        { brand: inferModelBrand('glm5') },
        { brand: inferModelBrand('zai-glm-4.6') },
      ]),
      name: '智谱 GLM',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      api: 'openai-completions',
      auth: { type: 'api_key', keyTail: '8a1c' },
      status: { state: 'ok', testedAt: now - 20_000 },
      models: [
        {
          id: 'GLM4.7',
          name: 'GLM4.7',
          brand: inferModelBrand('GLM4.7'),
          enabled: true,
          contextWindow: 128000,
          maxTokens: 4096,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          overridden: {},
        },
        {
          id: 'glm5',
          name: 'glm5',
          brand: inferModelBrand('glm5'),
          enabled: true,
          contextWindow: 128000,
          maxTokens: 4096,
          images: false,
          reasoning: true,
          thinkingLevels: ['off', 'low', 'high', 'max'],
          defaultThinkingLevel: 'high',
          overridden: {},
        },
        {
          id: 'zai-glm-4.6',
          name: 'zai-glm-4.6',
          brand: inferModelBrand('zai-glm-4.6'),
          enabled: false,
          contextWindow: 128000,
          maxTokens: 4096,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          overridden: {},
        },
      ],
    },
    {
      id: 'custom-9f01',
      kind: 'custom',
      brand: inferCustomProviderBrand([
        { brand: inferModelBrand('qwen3-coder-480b') },
        { brand: inferModelBrand('glm-5.2-fp8') },
        { brand: inferModelBrand('my-internal-model') },
      ]),
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
          brand: inferModelBrand('qwen3-coder-480b'),
          enabled: true,
          contextWindow: 262144,
          maxTokens: 65536,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
          overridden: {},
        },
        {
          id: 'glm-5.2-fp8',
          name: 'glm-5.2-fp8',
          brand: inferModelBrand('glm-5.2-fp8'),
          enabled: true,
          contextWindow: null,
          maxTokens: null,
          images: false,
          reasoning: true,
          thinkingLevels: ['off', 'low', 'high', 'max'],
          defaultThinkingLevel: 'high',
          overridden: {},
        },
        {
          id: 'my-internal-model',
          name: 'my-internal-model',
          brand: inferModelBrand('my-internal-model'),
          enabled: false,
          contextWindow: 8192,
          maxTokens: null,
          images: false,
          reasoning: false,
          thinkingLevels: [],
          defaultThinkingLevel: null,
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
    kind: 'project',
    ...input,
  };
}

const ASK_DEMO: MockTool = tool({
  id: 'ask-demo-1',
  kind: 'ask',
  title: hint('包管理器', 'Package'),
  detail: hint('用哪种包管理器？', 'Which package manager?'),
  fromIntent: false,
  hint: hint('等待回答', 'Waiting'),
  preview: '已向用户提问，等待回答，不要继续。',
  totalLines: 1,
  output: '已向用户提问，等待回答，不要继续。',
  ask: {
    questions: [
      {
        question: hint('用哪种包管理器？', 'Which package manager?'),
        header: hint('包管理器', 'Package'),
        multiSelect: false,
        options: [
          { label: hint('npm', 'npm'), description: hint('Node 自带', 'Bundled with Node') },
          { label: hint('pnpm', 'pnpm'), description: hint('节省磁盘', 'Saves disk') },
        ],
      },
      {
        question: hint('要跑哪些检查？', 'Which checks should run?'),
        header: hint('检查', 'Checks'),
        multiSelect: true,
        options: [
          { label: hint('lint', 'lint'), description: hint('只看风格', 'Style only') },
          { label: hint('test', 'test'), description: hint('跑单元测试', 'Run unit tests') },
          { label: hint('typecheck', 'typecheck'), description: hint('查类型', 'Check types') },
        ],
      },
    ],
    answer: null,
  },
});

const TURN_PATHS = {
  load: 'web/src/data/useConversation.ts',
  thread: 'web/src/components/Thread.tsx',
  css: 'web/src/styles/app.css',
};

function turnEdit(id: string, path: string, added: number, removed: number): MockTool {
  return tool({
    id,
    kind: 'edit',
    title: hint(path, path),
    path,
    diff: { added, removed },
    totalLines: added + removed,
  });
}

function turnsConversation(now: number): MockConv {
  const t1 = turnEdit('turns-t1', TURN_PATHS.load, 14, 5);
  const t2 = turnEdit('turns-t2', TURN_PATHS.thread, 9, 2);
  const t3 = turnEdit('turns-t3', TURN_PATHS.css, 31, 7);
  const turnChange = (path: string, added: number, removed: number): Change => (
    { path, added, removed, error: null, by: { kind: 'main' }, status: 'modified' }
  );
  const diffFor = (path: string, add: string, del: string) => mockDiff(path, [
    { oldStart: 10, newStart: 10, lines: [
      { op: 'ctx', text: '// ...' },
      { op: 'del', text: del },
      { op: 'add', text: add },
      { op: 'ctx', text: '// ...' },
    ] },
  ]);
  return conversation({
    id: 'c-turns',
    workspaceId: 'ws-weft',
    title: '变更按轮显示',
    updatedAt: now - 40 * MINUTE,
    used: 9_400,
    tools: { [t1.id]: t1, [t2.id]: t2, [t3.id]: t3 },
    items: [
      user('turns-u1', '把对话末尾累计的变更块改成跟着每一轮走。'),
      group('turns-g1', [t1.id, t2.id], { zh: '编辑了 2 个文件', en: 'edited 2 files' }),
      assistant('turns-a1', '改好了：变更摘要现在挂在改了文件的那一轮后面，改动在 `useConversation.ts` 和 `Thread.tsx`。'),
      { kind: 'turn_changes', id: 'turns-c1', changes: [
        turnChange(TURN_PATHS.load, 14, 5),
        turnChange(TURN_PATHS.thread, 9, 2),
      ] },
      user('turns-u2', '没改文件的这一轮，下面应该什么都不显示吧？'),
      assistant('turns-a2', '对，这一轮没动任何文件，所以下面不会出现变更摘要。'),
      user('turns-u3', '那把样式也顺手收紧一下。'),
      group('turns-g2', [t3.id], { zh: '编辑了 1 个文件', en: 'edited 1 file' }),
      assistant('turns-a3', '样式收紧了，摘要默认只占一行，点开才看文件列表。'),
      { kind: 'turn_changes', id: 'turns-c2', changes: [turnChange(TURN_PATHS.css, 31, 7)] },
    ],
    changes: [
      turnChange(TURN_PATHS.load, 14, 5),
      turnChange(TURN_PATHS.thread, 9, 2),
      turnChange(TURN_PATHS.css, 31, 7),
    ],
    diffs: {
      [TURN_PATHS.load]: diffFor(TURN_PATHS.load, '  const turnChanges = items.filter(isTurnChanges);', '  const changes = store.changes(id);'),
      [TURN_PATHS.thread]: diffFor(TURN_PATHS.thread, "  if (item.kind === 'turn_changes') return <ChangeSummary />;", '  {changes.length ? <ChangeSummary /> : null}'),
      [TURN_PATHS.css]: diffFor(TURN_PATHS.css, '  height: 36px;', '  height: 40px;'),
    },
  });
}

function askConversation(now: number): MockConv {
  return conversation({
    id: 'c-ask',
    workspaceId: 'ws-weft',
    title: '选择包管理器',
    updatedAt: now - 5 * HOUR,
    used: 1_800,
    tools: { [ASK_DEMO.id]: ASK_DEMO },
    items: [
      user('ask-u1', '帮我定一下这个仓库用什么装依赖、跑哪些检查。'),
      assistant('ask-a1', '先确认两件事后再改配置。'),
      group('ask-g1', [ASK_DEMO.id], { zh: '调用了 ask_user_question', en: 'called ask_user_question once' }, 0),
    ],
  });
}

function consultConversation(now: number): MockConv {
  return conversation({
    id: 'c-consult',
    workspaceId: 'ws-chat-consult',
    title: '代码咨询',
    updatedAt: now - 2 * HOUR,
    used: 2_400,
    items: [
      user('consult-u1', 'TypeScript 里把可选字段默认成某个值，一般怎么写比较干净？'),
      assistant(
        'consult-a1',
        [
          '读的时候用空值合并，别在类型上硬改：',
          '',
          '```ts',
          'const kind = ws.kind ?? \'project\';',
          '```',
          '',
          '`??` 只把 `null` / `undefined` 换成默认值，空字符串和 `0` 会留下来。',
        ].join('\n'),
      ),
    ],
  });
}

function regexConversation(now: number): MockConv {
  const bash = tool({
    id: 'regex-t1',
    kind: 'bash',
    title: hint('node -e "console.log(/\\d+/.test(\'id-42\'))"', 'node -e "console.log(/\\d+/.test(\'id-42\'))"'),
    hint: hint('退出码 0 · 1 行', 'exit 0 · 1 line'),
    exitCode: 0,
    preview: 'true',
    totalLines: 1,
    output: 'true',
  });
  return conversation({
    id: 'c-regex',
    workspaceId: 'ws-chat-regex',
    title: '正则怎么写',
    updatedAt: now - 50 * MINUTE,
    used: 6_800,
    tools: { [bash.id]: bash },
    items: [
      user('regex-u1', '从 `id-42` 这种字符串里取出数字，正则怎么写？'),
      group('regex-g1', [bash.id], { zh: '执行了 1 条命令', en: 'ran 1 command' }),
      assistant(
        'regex-a1',
        [
          '用 `/(\\d+)/` 取第一组：',
          '',
          '```js',
          'const m = \'id-42\'.match(/(\\d+)/);',
          'const n = m ? Number(m[1]) : null; // 42',
          '```',
          '',
          '上面那条命令验证 `/\\d+/` 能匹配到这段文字。',
        ].join('\n'),
      ),
    ],
  });
}

function emptyConversation(now: number): MockConv {
  return conversation({
    id: 'c-empty',
    workspaceId: 'ws-weft',
    title: '新对话',
    updatedAt: now - 5 * MINUTE,
    used: 0,
    items: [],
  });
}

function seedGlab(): GlabSettings {
  const defaults: GlabSettings = {
    enabled: false,
    customPath: '',
    binary: {
      source: 'bundled',
      version: '1.46.1',
      path: '/usr/local/bin/glab',
    },
    connectionIds: [],
    defaultConnectionId: null,
  };
  if (typeof sessionStorage !== 'undefined') {
    try {
      const saved = sessionStorage.getItem('weft_proto_glab');
      if (saved) return { ...defaults, ...JSON.parse(saved) };
    } catch {
      // ignore
    }
  }
  return defaults;
}

export function createSeed(now: number): MockDb {
  const subagents = seedSubThreads(now);
  const conversations = [
    richConversation(now, subagents),
    failedConversation(now),
    interruptedConversation(now),
    noModelFailedConversation(now),
    truncatedConversation(now),
    compactedConversation(now),
    compactFailedConversation(now),
    retryingConversation(now),
    askConversation(now),
    turnsConversation(now),
    testsConversation(now),
    docsConversation(now, subagents),
    scriptsConversation(now),
    gitConversation(now),
    siteOne(now, subagents),
    siteTwo(now),
    archivedOne(now),
    archivedTwo(now),
    consultConversation(now),
    regexConversation(now),
    emptyConversation(now),
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
    workspace({
      id: 'ws-chat-consult',
      name: '代码咨询',
      path: 'D:\\data\\chats\\c-consult',
      git: null,
      kind: 'chat',
    }),
    workspace({
      id: 'ws-chat-regex',
      name: '正则怎么写',
      path: 'D:\\data\\chats\\c-regex',
      git: null,
      kind: 'chat',
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
      ['ws-chat-consult', createRepo([{
        path: 'README.md',
        text: '# 代码咨询\n\n这个对话自己的工作目录。\n',
      }])],
      ['ws-chat-regex', createRepo([{
        path: 'README.md',
        text: '# 正则怎么写\n\n这个对话自己的工作目录。\n',
      }])],
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
    glab: seedGlab(),
    settings: { compaction: { triggerPercent: 80 } },
  };
}
