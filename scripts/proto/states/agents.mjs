// 子 Agent 基线：侧栏树（运行中 / 完成 / 失败）和子 Agent 视图。
import { settle, waitDone } from '../lib/page.mjs';

const AGENTS_SEND = '派三个子 Agent 分头看';
const CHECK_TASK = '检查仓库状态，有未提交改动就列出来。';
const DOC_TASK = '整理原型说明文档，按页面分组写清楚。';
const DEPS_TASK = '升级依赖到最新版本，跑一遍构建。';

export const states = [
  {
    id: 'subagents',
    title: '子 Agent 树与汇报卡片',
    note: '侧栏三个子 Agent（运行中 / 完成 / 失败），主对话里带回汇报卡片；失败那条的树行目前只显示「等待」',
    send: AGENTS_SEND,
    script: [
      {
        tools: [
          { tool: 'subagent', args: { action: 'spawn', name: '巡检', title: '检查仓库状态', message: CHECK_TASK } },
          { tool: 'subagent', args: { action: 'spawn', name: '文档整理', title: '整理原型说明', message: DOC_TASK } },
          { tool: 'subagent', args: { action: 'spawn', name: '依赖升级', title: '升级依赖', message: DEPS_TASK } },
        ],
      },
      { text: '三个子 Agent 都派出去了，巡检的先回来。' },
      // 汇报回到主对话时会新起一次 run。空 turn 让这次 run 直接结束，
      // 主对话里不再多出一条「ok」气泡。
      ...Array.from({ length: 8 }, () => ({ when: 'no reply needed', end: true })),
      ...Array.from({ length: 8 }, () => ({ when: 'subagent 依赖升级 failed', end: true })),
      { when: '检查仓库状态', delayMs: 1200, text: '仓库干净，没有未提交改动，也没有待推送的提交。' },
      { when: '整理原型说明', delayMs: 240000, text: '整理完了。' },
      { when: '升级依赖', delayMs: 3000, error: '子 Agent 失败：npm ci 退出码 1' },
    ],
    async prepare(ctx) {
      await ctx.openConv('agents');
      await ctx.send(AGENTS_SEND);
      await waitDone(ctx.page, 90000);
      const rows = ctx.page.getByTestId('next-subagent-row');
      await rows.nth(2).waitFor({ timeout: 90000 });
      await ctx.page.locator('[data-testid=next-subagent-row][data-status=running]').first().waitFor({ timeout: 90000 });
      await ctx.page.locator('[data-testid=next-subagent-row][data-status=done]').first().waitFor({ timeout: 90000 });
      await ctx.page.getByTestId('next-item-subagent-report').first().waitFor({ timeout: 90000 });
      // 汇报卡片里有一条失败：树行拿不到 failed（见 PR 说明），失败只在卡片上体现。
      await ctx.page.locator('[data-testid=next-item-subagent-report].is-failed').waitFor({ timeout: 90000 });
      await settle(ctx.page, 400);
    },
  },
  {
    id: 'subagent-view',
    title: '子 Agent 视图',
    note: '打开巡检这个子 Agent，左栏保留树、行高亮',
    async prepare(ctx) {
      await ctx.openConv('agents');
      const doneRow = ctx.page.locator('[data-testid=next-subagent-row][data-status=done]').first();
      await doneRow.waitFor({ timeout: 60000 });
      await doneRow.click();
      await ctx.page.getByTestId('next-subagent-view').waitFor({ timeout: 30000 });
      await ctx.page.getByTestId('next-subagent-back').waitFor({ timeout: 30000 });
      await settle(ctx.page, 400);
    },
  },
];
