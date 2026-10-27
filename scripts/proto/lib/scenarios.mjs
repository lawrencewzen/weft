// Conversation scenarios. Each entry is `{ send, script }` for one run, or
// `{ runs: [...] }` for a conversation with several user turns. Turns without
// `when` are tagged with their run's `send` by the capture runner, so several
// conversations can share one script file and one server.
import { settle, waitDone, waitRunning } from './page.mjs';

const PROTOTYPE_MD = [
  '# 原型截取',
  '',
  '- 用演示模型跑真实网页端',
  '- 用 Playwright 存 DOM 和 CSS',
  '- 输出单文件 HTML',
].join('\n');

const DONE_ANSWER = [
  '原型基线补好了，改动都在 `docs/notes/prototype.md`。',
  '',
  '## 这次做了什么',
  '',
  '- 截图脚本改成按状态定义逐个截取',
  '- 产物是单文件 HTML，双击就能打开',
  '- 深色模式直接切 `data-theme` 就能生效',
  '',
  '```bash',
  'npm run build:web',
  'npm run proto:capture',
  '```',
  '',
  '下一步按 `src/components/Composer.tsx` 的样式再对一遍。',
].join('\n');

export const demo = {
  runs: [
    {
      send: '先看下现在的结构，我要补一段原型说明。',
      // 一次一个工具：并行调用在 transcript 里的落盘顺序不固定，截图就不可复现。
      script: [
        { tool: 'read', args: { path: 'README.md' } },
        { tool: 'read', args: { path: 'docs/ARCHITECTURE.md' } },
        { tool: 'ls', args: { path: 'src/components' } },
        { text: '结构看过了：README 讲启动，ARCHITECTURE 讲分层。我去 docs/notes 下补原型说明。' },
      ],
    },
    {
      send: '好，补到 docs/notes 下，最后一行写得具体一点。',
      script: [
        { tool: 'write', args: { path: 'docs/notes/prototype.md', content: PROTOTYPE_MD } },
        {
          tool: 'edit',
          args: {
            path: 'docs/notes/prototype.md',
            edits: [{ oldText: '- 输出单文件 HTML', newText: '- 输出单文件 HTML，双击就能看' }],
          },
        },
        { text: DONE_ANSWER },
      ],
    },
  ],
};

export const running = {
  send: '跑一次长任务看状态条',
  // 只有一次很慢的模型调用，状态条停在「运行中」，不会截到工具行中间状态。
  script: [{ delayMs: 300000, text: '全部单元测试通过。' }],
};

const FAIL_BUILD = `node -e "console.error('Error: 构建失败：找不到 dist/index.html'); process.exit(1)"`;

export const tools = {
  send: '看下刚才的构建为什么失败',
  script: [
    { tool: 'read', args: { path: 'web/vite.config.ts' } },
    { tool: 'ls', args: { path: 'public-next' } },
    { tool: 'bash', args: { command: FAIL_BUILD } },
    { text: '构建跑挂了，缺 `dist/index.html`，我下一条消息修。' },
  ],
};

const CHECK_TASK = '检查仓库状态，有未提交改动就列出来。';
const DOC_TASK = '整理原型说明文档，按页面分组写清楚。';
const DEPS_TASK = '升级依赖到最新版本，跑一遍构建。';

export const agents = {
  send: '派三个子 Agent 分头看',
  script: [
    // 逐个派出：并行调用落盘顺序不固定，树里三行的先后就不可复现。
    { tool: 'subagent', args: { action: 'spawn', name: '巡检', title: '检查仓库状态', message: CHECK_TASK } },
    { tool: 'subagent', args: { action: 'spawn', name: '文档整理', title: '整理原型说明', message: DOC_TASK } },
    { tool: 'subagent', args: { action: 'spawn', name: '依赖升级', title: '升级依赖', message: DEPS_TASK } },
    { text: '三个子 Agent 都派出去了，巡检的先回来。' },
    // 汇报回到主对话时会新起一次 run。空 turn 让这次 run 直接结束，
    // 主对话里不再多出一条「ok」气泡。
    ...Array.from({ length: 8 }, () => ({ when: 'no reply needed', end: true })),
    ...Array.from({ length: 8 }, () => ({ when: 'subagent 依赖升级 failed', end: true })),
    { when: '检查仓库状态', delayMs: 1200, text: '仓库干净，没有未提交改动，也没有待推送的提交。' },
    { when: '整理原型说明', delayMs: 240000, text: '整理完了。' },
    { when: '升级依赖', delayMs: 3000, error: '子 Agent 失败：npm ci 退出码 1' },
  ],
};

const done = new WeakSet();

/** 主对话只跑一次；后面的右栏、模型菜单、收起面板都复用它。 */
export async function ensureDemoChat(ctx) {
  await ctx.openConv('demo');
  if (done.has(ctx.session)) return;
  for (const run of demo.runs) {
    await ctx.send(run.send);
    await waitDone(ctx.page, 90000);
  }
  done.add(ctx.session);
}

const agentsDone = new WeakSet();

/** 三个子 Agent 的树只准备一次；打开子 Agent 视图时复用它。 */
export async function ensureAgentsRun(ctx) {
  await ctx.openConv('agents');
  if (agentsDone.has(ctx.session)) return;
  await ctx.send(agents.send);
  await waitDone(ctx.page, 90000);
  const rows = ctx.page.getByTestId('next-subagent-row');
  await rows.nth(2).waitFor({ timeout: 90000 });
  await ctx.page.locator('[data-testid=next-subagent-row][data-status=running]').first().waitFor({ timeout: 90000 });
  await ctx.page.locator('[data-testid=next-subagent-row][data-status=done]').first().waitFor({ timeout: 90000 });
  await ctx.page.getByTestId('next-item-subagent-report').first().waitFor({ timeout: 90000 });
  await ctx.page.locator('[data-testid=next-item-subagent-report].is-failed').waitFor({ timeout: 90000 });
  await settle(ctx.page, 400);
  agentsDone.add(ctx.session);
}

/** 运行态对话只跑一次（它一直停在运行中）。 */
const runningDone = new WeakSet();

export async function ensureRunningChat(ctx) {
  await ctx.openConv('long');
  if (runningDone.has(ctx.session)) return;
  await ctx.send(running.send);
  await waitRunning(ctx.page, 60000);
  await ctx.page.getByTestId('next-elapsed').waitFor({ timeout: 20000 });
  await settle(ctx.page, 1300);
  runningDone.add(ctx.session);
}
