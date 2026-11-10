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

test('模拟运行：改了文件的轮出摘要，运行中不出，之后只问问题的轮不出', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill('改一下 web/src/data/store.ts 里的 items 顺序');
  await page.getByTestId('next-send').click();
  // 运行中那一轮在结束前不显示摘要
  await expect(page.getByTestId('next-stop')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('next-change-summary')).toHaveCount(0);

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

test('c-rich：摘要在历史轮次里而不在末尾，最新用户消息和运行中活动之间没有摘要', async ({ page }) => {
  const state = await openProto(page);
  await expect(page).toHaveURL(/#\/c\/c-rich$/);

  // 历史轮次（第 1 轮）有摘要：8 个文件已更改
  const summaries = page.getByTestId('next-change-summary');
  await expect(summaries).toHaveCount(1);
  await expect(summaries.locator('.change-summary-head-title')).toHaveText('8 个文件已更改');

  // DOM 顺序：第 1 轮回复 -> 摘要 -> 第 2 轮最新用户消息「你好」-> 正在运行的等待行
  const order = await page.evaluate(() => {
    const inner = document.querySelector('.thread-inner');
    return [...(inner?.children || [])].map((el) => {
      const testId = el.getAttribute('data-testid') || '';
      if (testId === 'next-change-summary') return 'summary';
      if (testId === 'next-thread-pending') return 'pending';
      if (testId === 'next-item-user') return `user:${el.textContent?.trim() || ''}`;
      if (testId === 'next-item-assistant') return 'assistant';
      return '';
    }).filter(Boolean);
  });

  const summaryIdx = order.indexOf('summary');
  const user2Idx = order.findIndex((x) => x.includes('user:你好'));
  const pendingIdx = order.indexOf('pending');

  expect(summaryIdx).toBeGreaterThan(-1);
  expect(user2Idx).toBeGreaterThan(summaryIdx); // 摘要在第 2 轮用户消息之前
  expect(pendingIdx).toBeGreaterThan(user2Idx); // 正在运行的行在第 2 轮用户消息之后

  // 最新用户消息和运行中活动之间没有摘要
  expect(pendingIdx - user2Idx).toBe(1);

  // 右栏累计仍为 8 个文件
  await page.getByTestId('next-right-toggle').click();
  await expect(page.getByTestId('next-change-row')).toHaveCount(8);

  expectClean(state);
});

test('没有按轮数据的对话流里不显示任何摘要', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-failed"]').click();
  await expect(page).toHaveURL(/#\/c\/c-failed$/);
  await expect(page.getByTestId('next-change-summary')).toHaveCount(0);

  await page.locator('[data-testid=next-conv-row][data-id="c-tests"]').click();
  await expect(page).toHaveURL(/#\/c\/c-tests$/);
  await expect(page.getByTestId('next-change-summary')).toHaveCount(0);

  expectClean(state);
});

test('c-docs：改过文件的轮次显示摘要，没改过的不显示', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-docs"]').click();
  await expect(page).toHaveURL(/#\/c\/c-docs$/);

  // 只有第 2 轮改了 docs/ARCHITECTURE_V2.md，所以只有 1 个摘要
  const summaries = page.getByTestId('next-change-summary');
  await expect(summaries).toHaveCount(1);
  await expect(summaries.locator('.change-summary-head-title')).toHaveText('1 个文件已更改');
  await expect(summaries.locator('.change-summary-head-sum .add')).toHaveText('+18');

  // 点开查看文件列表
  await summaries.getByTestId('next-change-summary-toggle').click();
  await expect(summaries.getByTestId('next-change-summary-row')).toHaveCount(1);
  await expect(summaries.locator('[data-testid=next-change-summary-row][data-path="docs/ARCHITECTURE_V2.md"]')).toBeVisible();

  // 右栏累计 1 个文件
  await page.getByTestId('next-right-toggle').click();
  await expect(page.getByTestId('next-change-row')).toHaveCount(1);

  expectClean(state);
});
