// 对话页基线：草稿、完成态、运行中、工具组展开。
import { settle, waitDone } from '../lib/page.mjs';
import { demo, ensureDemoChat, ensureRunningChat, running, tools } from '../lib/scenarios.mjs';

export const states = [
  {
    id: 'home-draft',
    title: '新对话草稿',
    note: '左栏两个工作区、六个对话；草稿还没发出去',
    async prepare(ctx) {
      await ctx.openDraft('weft');
      await ctx.page.getByTestId('next-composer-input').fill('把右栏「变更」的空状态也截一张。');
      await settle(ctx.page);
    },
  },
  {
    id: 'chat-done',
    title: '完成的对话',
    note: 'Markdown、折叠的工具组、展开的写入/编辑记录、路径标签',
    runs: demo.runs,
    async prepare(ctx) {
      await ensureDemoChat(ctx);
      // 第一个工具组保持折叠，第二个（写入 + 编辑）展开，露出 +/− 记录。
      const group = ctx.page.getByTestId('next-tool-group').nth(1);
      const cls = (await group.getAttribute('class')) || '';
      if (!cls.includes('is-open')) await group.getByTestId('next-tool-group-summary').click();
      await settle(ctx.page);
    },
  },
  {
    id: 'chat-running',
    title: '运行中',
    note: '顶栏「运行中」+ 计时 + 停止按钮',
    send: running.send,
    script: running.script,
    async prepare(ctx) {
      await ensureRunningChat(ctx);
    },
  },
  {
    id: 'chat-tools-open',
    title: '工具组展开',
    note: '工具组展开，最后一条是失败的构建命令',
    send: tools.send,
    script: tools.script,
    async prepare(ctx) {
      await ctx.openConv('tools');
      await ctx.send(tools.send);
      await waitDone(ctx.page, 90000);
      await ctx.page.getByTestId('next-tool-group-summary').first().click();
      await settle(ctx.page);
    },
  },
];
