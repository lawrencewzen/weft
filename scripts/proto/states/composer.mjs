// 输入框基线：模型菜单展开、没有配置模型。
import { ensureDemoChat } from '../lib/scenarios.mjs';
import { settle } from '../lib/page.mjs';

export const states = [
  {
    id: 'model-menu',
    title: '模型菜单',
    note: '输入框左侧的模型 chip 展开，两个可选模型 + 管理入口',
    async prepare(ctx) {
      await ensureDemoChat(ctx);
      await ctx.page.getByTestId('next-model-chip').click();
      await ctx.page.getByTestId('next-model-menu').waitFor({ timeout: 30000 });
      await settle(ctx.page, 250);
    },
  },
  {
    id: 'no-model',
    title: '没有模型',
    note: '没有配置任何模型：输入框禁用，给一个「接入模型」入口',
    server: 'bare',
    async prepare(ctx) {
      await ctx.openConv('bare');
      await ctx.page.getByTestId('next-no-model').waitFor({ timeout: 30000 });
      await settle(ctx.page, 300);
    },
  },
];
