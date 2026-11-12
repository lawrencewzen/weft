import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
const isClear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';

for (const scheme of ['light', 'dark']) {
  test(`sidebar foot hovers per button, not per row (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const state = await openProto(page);

    const row = page.locator('.sb-foot-row');
    const settings = page.getByTestId('next-open-settings');
    const archived = page.getByTestId('next-archived-toggle');
    const theme = page.getByTestId('next-appearance-toggle');
    const dot = page.getByTestId('next-service-dot');
    await expect(row).toBeVisible();

    // 设置：只有按钮自己亮
    await settings.hover();
    expect(isClear(await bg(row))).toBe(true);
    expect(isClear(await bg(settings))).toBe(false);
    expect(isClear(await bg(archived))).toBe(true);

    // 归档：只有归档亮
    await archived.hover();
    expect(isClear(await bg(row))).toBe(true);
    expect(isClear(await bg(archived))).toBe(false);
    expect(isClear(await bg(settings))).toBe(true);
    expect(isClear(await bg(theme))).toBe(true);

    // 主题：只有主题亮
    await theme.hover();
    expect(isClear(await bg(row))).toBe(true);
    expect(isClear(await bg(theme))).toBe(false);
    expect(isClear(await bg(archived))).toBe(true);

    // 行内空白处（设置与圆点之间的右侧空隙）：什么都不亮
    const rb = await row.boundingBox();
    const sb = await settings.boundingBox();
    const db = await dot.boundingBox();
    const midX = (sb.x + sb.width + db.x) / 2;
    expect(midX).toBeGreaterThan(sb.x + sb.width - 1);
    await page.mouse.move(midX, rb.y + rb.height / 2);
    expect(isClear(await bg(row))).toBe(true);
    expect(isClear(await bg(settings))).toBe(true);
    expect(isClear(await bg(archived))).toBe(true);
    expect(isClear(await bg(theme))).toBe(true);

    // 服务状态圆点悬停时行不亮
    await dot.hover();
    expect(isClear(await bg(row))).toBe(true);

    // 其他侧边栏行悬停不变
    const newChat = page.getByTestId('next-new-chat');
    await newChat.hover();
    expect(isClear(await bg(newChat))).toBe(false);

    expectClean(state);
  });

  test(`sidebar foot divider spans full width and archived section has top and bottom borders with aligned empty note (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const state = await openProto(page);

    const sidebar = page.getByTestId('next-sidebar');
    const foot = page.locator('.sb-foot');
    const row = page.locator('.sb-foot-row');
    const archivedToggle = page.getByTestId('next-archived-toggle');

    await expect(sidebar).toBeVisible();
    await expect(foot).toBeVisible();
    await expect(row).toBeVisible();

    // 1. 底栏分割线撑满侧边栏宽度：线的左右端与侧边栏左右边对齐
    const sideBox = await sidebar.boundingBox();
    const footBox = await foot.boundingBox();
    expect(sideBox).toBeTruthy();
    expect(footBox).toBeTruthy();

    expect(Math.abs(footBox.x - sideBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(footBox.width - sideBox.width)).toBeLessThanOrEqual(0.5);
    expect(parseFloat(await foot.evaluate((el) => window.getComputedStyle(el).borderTopWidth))).toBeCloseTo(1, 0);

    // 底栏按钮位置不变（保持在侧栏内边距内，与上方按钮对齐）
    const rowBox = await row.boundingBox();
    expect(rowBox.x).toBeGreaterThan(sideBox.x);
    expect(rowBox.x + rowBox.width).toBeLessThan(sideBox.x + sideBox.width);

    // 2. 展开归档（非空）：列表中有 2 条归档对话，归档区顶线和底栏顶线均存在且撑满
    await archivedToggle.click();
    const archSection = page.getByTestId('next-sidebar-archived-section');
    await expect(archSection).toBeVisible();
    const archList = page.getByTestId('next-archived-list');
    await expect(archList).toBeVisible();
    const rows = archList.getByTestId('next-conv-row');
    await expect(rows).toHaveCount(2);

    // 归档区顶线存在且左右撑满
    const archBox = await archSection.boundingBox();
    expect(archBox).toBeTruthy();
    expect(Math.abs(archBox.x - sideBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(archBox.width - sideBox.width)).toBeLessThanOrEqual(0.5);
    expect(parseFloat(await archSection.evaluate((el) => window.getComputedStyle(el).borderTopWidth))).toBeCloseTo(1, 0);
    expect(parseFloat(await foot.evaluate((el) => window.getComputedStyle(el).borderTopWidth))).toBeCloseTo(1, 0);

    // 记录非空时第一个归档项标题文字左边距
    const firstTitle = rows.first().locator('.sb-conv-title');
    const firstTitleBox = await firstTitle.boundingBox();
    expect(firstTitleBox).toBeTruthy();

    // 3. 展开归档（空）：将归档对话全部取消归档，展示空提示，两根线依然存在
    for (const rowItem of await rows.all()) {
      await rowItem.click({ button: 'right' });
      const ctxMenu = page.getByTestId('next-ctx-menu');
      await expect(ctxMenu).toBeVisible();
      await ctxMenu.locator('[data-action="unarchive"]').click();
    }

    const emptyNote = page.getByTestId('next-archived-empty');
    await expect(emptyNote).toBeVisible();
    await expect(emptyNote).toHaveText('没有归档的对话');

    // 空提示文字的左边距和归档项标题文字左边对齐
    const emptyNoteBox = await emptyNote.boundingBox();
    expect(emptyNoteBox).toBeTruthy();
    const emptyTextLeft = await emptyNote.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().left;
    });
    expect(Math.abs(emptyTextLeft - firstTitleBox.x)).toBeLessThanOrEqual(1);

    // 归档区顶线与底栏顶线均保留，两根线之间竖直距离 ≥ 提示行高度
    const archBoxEmpty = await archSection.boundingBox();
    const footBoxEmpty = await foot.boundingBox();
    expect(archBoxEmpty).toBeTruthy();
    expect(footBoxEmpty).toBeTruthy();
    expect(parseFloat(await archSection.evaluate((el) => window.getComputedStyle(el).borderTopWidth))).toBeCloseTo(1, 0);
    expect(parseFloat(await foot.evaluate((el) => window.getComputedStyle(el).borderTopWidth))).toBeCloseTo(1, 0);

    const lineDistance = footBoxEmpty.y - archBoxEmpty.y;
    expect(lineDistance).toBeGreaterThanOrEqual(emptyNoteBox.height);
    expect(emptyNoteBox.y).toBeGreaterThanOrEqual(archBoxEmpty.y);
    expect(emptyNoteBox.y + emptyNoteBox.height).toBeLessThanOrEqual(footBoxEmpty.y + 0.5);

    expectClean(state);
  });
}
