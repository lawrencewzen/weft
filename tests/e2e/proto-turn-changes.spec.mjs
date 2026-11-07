import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('文件变更只跟着改了文件的那一轮，默认一行', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-turns"]').click();
  await expect(page).toHaveURL(/#\/c\/c-turns$/);

  // 三轮：改 2 个、没改、改 1 个 -> 两个摘要，各在自己那一轮后面。
  const cards = page.getByTestId('next-change-summary');
  await expect(cards).toHaveCount(2);
  const assistants = page.getByTestId('next-item-assistant');
  await expect(assistants).toHaveCount(3);

  // 顺序：第 1 轮回复 -> 摘要 -> 第 2 轮提问和回复（无摘要）-> 第 3 轮回复 -> 摘要。
  const order = await page.evaluate(() => {
    const inner = document.querySelector('.thread-inner');
    return [...(inner?.children || [])].map((el) => {
      const id = el.getAttribute('data-testid') || '';
      return id.replace('next-item-', '').replace('next-change-summary', 'summary');
    });
  });
  const flat = order.filter((x) => ['user', 'assistant', 'summary'].includes(x));
  expect(flat).toEqual(['user', 'assistant', 'summary', 'user', 'assistant', 'user', 'assistant', 'summary']);

  // 默认一行：标题、增删、查看，没有文件列表。
  const first = cards.nth(0);
  await expect(first.locator('.change-summary-head-title')).toHaveText('2 个文件已更改');
  await expect(first.locator('.change-summary-head-sum .add')).toHaveText('+23');
  await expect(first.locator('.change-summary-head-sum .del')).toHaveText('−7');
  await expect(first.getByTestId('next-change-summary-view')).toHaveText('查看 ›');
  await expect(first.getByTestId('next-change-summary-row')).toHaveCount(0);
  const second = cards.nth(1);
  await expect(second.locator('.change-summary-head-title')).toHaveText('1 个文件已更改');
  const h = (await first.boundingBox())?.height ?? 999;
  expect(h).toBeLessThan(48);

  // 展开、收起，各自独立。
  await first.getByTestId('next-change-summary-toggle').click();
  await expect(first.getByTestId('next-change-summary-row')).toHaveCount(2);
  await expect(second.getByTestId('next-change-summary-row')).toHaveCount(0);
  await first.getByTestId('next-change-summary-toggle').click();
  await expect(first.getByTestId('next-change-summary-row')).toHaveCount(0);

  // 点文件名打开差异。
  await second.getByTestId('next-change-summary-toggle').click();
  await second.getByTestId('next-change-summary-row').click();
  await expect(page.locator('.right-tabs-bar .tab-btn.active')).toContainText('变更');
  await expect(
    page.locator('[data-testid=next-change-row][data-path="web/src/styles/app.css"]').getByTestId('next-diff'),
  ).toBeVisible();

  // 右栏仍是累计的 3 个文件；查看打开右栏变更页。
  await expect(page.getByTestId('next-change-row')).toHaveCount(3);
  await page.getByTestId('next-right-tab-files').click();
  await first.getByTestId('next-change-summary-view').click();
  await expect(page.locator('.right-tabs-bar .tab-btn.active')).toContainText('变更');
  await expect(first.getByTestId('next-change-summary-row')).toHaveCount(0);

  expectClean(state);
});

test('模拟运行：改了文件的轮出摘要，之后只问问题的轮不出', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill('改一下 web/src/data/store.ts 里的 items 顺序');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('next-change-summary')).toHaveCount(1);
  await expect(page.getByTestId('next-change-summary-row')).toHaveCount(0);

  await page.getByTestId('next-composer-input').fill('这个函数是干什么的？');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('next-item-assistant')).toHaveCount(2);
  await expect(page.getByTestId('next-change-summary')).toHaveCount(1);
  expectClean(state);
});
