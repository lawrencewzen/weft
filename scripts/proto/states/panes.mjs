// 右栏与面板收纳基线。
import { ensureDemoChat } from '../lib/scenarios.mjs';
import { settle } from '../lib/page.mjs';

const PROTOTYPE_MD = 'docs/notes/prototype.md';

function fileNode(page, filePath) {
  return page.locator(`[data-testid=next-file-node][data-path="${filePath}"]`);
}

async function expandDir(page, dir) {
  const node = fileNode(page, dir);
  await node.waitFor({ timeout: 30000 });
  const cls = (await node.getAttribute('class')) || '';
  if (!cls.includes('is-open')) await node.click();
}

export const states = [
  {
    id: 'right-changes',
    title: '右栏 · 变更',
    note: '一个文件的 diff 展开，头部有 +/− 合计',
    async prepare(ctx) {
      await ensureDemoChat(ctx);
      await ctx.page.getByTestId('next-right-tab-changes').click();
      const row = ctx.page.locator(`[data-testid=next-change-row][data-path="${PROTOTYPE_MD}"]`);
      await row.waitFor({ timeout: 30000 });
      const diff = ctx.page.locator(`[data-testid=next-diff][data-path="${PROTOTYPE_MD}"]`);
      if ((await diff.count()) === 0) await row.locator('.changed-file-pill').click();
      await diff.waitFor({ timeout: 30000 });
      await settle(ctx.page, 300);
    },
  },
  {
    id: 'right-files',
    title: '右栏 · 文件',
    note: '文件树展开到 docs/notes，右侧是 Markdown 预览',
    async prepare(ctx) {
      await ensureDemoChat(ctx);
      await ctx.page.getByTestId('next-right-tab-files').click();
      await expandDir(ctx.page, 'docs');
      await expandDir(ctx.page, 'docs/notes');
      const file = fileNode(ctx.page, PROTOTYPE_MD);
      await file.waitFor({ timeout: 30000 });
      await file.click();
      await ctx.page.getByTestId('next-file-view').filter({ hasText: '原型截取' }).waitFor({ timeout: 30000 });
      await settle(ctx.page, 300);
    },
  },
  {
    id: 'panels-collapsed',
    title: '左右栏收起',
    note: '只留对话区，两侧各有一个展开按钮',
    async prepare(ctx) {
      await ensureDemoChat(ctx);
      await ctx.page.getByTestId('next-left-collapse').click();
      await ctx.page.getByTestId('next-right-collapse').click();
      await ctx.page.getByTestId('next-left-open').waitFor({ state: 'visible', timeout: 30000 });
      await ctx.page.getByTestId('next-right-toggle').waitFor({ state: 'visible', timeout: 30000 });
      await settle(ctx.page, 400);
    },
  },
];
