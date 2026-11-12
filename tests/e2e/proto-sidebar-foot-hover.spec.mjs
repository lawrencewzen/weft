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
}
