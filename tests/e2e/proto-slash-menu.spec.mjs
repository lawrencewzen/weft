import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

async function openConv(page, id) {
  await page.locator(`[data-testid=next-conv-row][data-id="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${id}$`));
}

test('slash menu opens on a leading slash only, filters, and closes on Esc', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-rich');
  const input = page.getByTestId('next-composer-input');
  const menu = page.getByTestId('next-slash-menu');

  await input.click();
  await input.fill('看看 /');
  await expect(menu).toHaveCount(0);
  await input.fill('src/a');
  await expect(menu).toHaveCount(0);

  await input.fill('/');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-kind=command]')).toHaveCount(4);
  await expect(menu.locator('[data-kind=skill]')).toHaveCount(4);

  await input.fill('/rev');
  await expect(page.getByTestId('next-slash-item')).toHaveCount(1);
  await expect(page.getByTestId('next-slash-item')).toHaveAttribute('data-id', 'code-review');

  await input.fill('/co');
  await input.press('Escape');
  await expect(menu).toHaveCount(0);
  await input.fill('');
  await input.fill('/');
  await expect(menu).toBeVisible();
  expectClean(state);
});

test('/compact becomes chip, supports instructions, and triggers compaction on Enter; draft hides it', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const input = page.getByTestId('next-composer-input');
  await input.click();
  await input.fill('/comp');
  await expect(page.getByTestId('next-slash-item')).toHaveAttribute('data-id', 'compact');
  await input.press('Enter');
  await expect(page.getByTestId('next-composer-chip')).toHaveText('压缩');
  await expect(input).toHaveValue('');
  await input.type('只保留核心架构说明');
  await input.press('Enter');
  await expect.poll(async () => (await state.requests()).some((r) => /\/compact$/.test(r.url) && r.method === 'POST')).toBe(true);
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('next-composer-chip')).toHaveCount(0);

  await page.getByTestId('next-new-chat').click();
  const draftInput = page.getByTestId('next-composer-input');
  await draftInput.click();
  await draftInput.fill('/');
  await expect(page.getByTestId('next-slash-menu')).toBeVisible();
  await expect(page.locator('[data-testid=next-slash-item][data-id="compact"]')).toHaveCount(0);
  await expect(page.locator('[data-testid=next-slash-item][data-id="handoff"]')).toHaveCount(0);
  expectClean(state);
});

test('/handoff, /schedule, and /new (no /model in menu)', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const input = page.getByTestId('next-composer-input');
  await input.click();

  await input.fill('/hand');
  await input.press('Enter');
  await expect(page.getByTestId('next-composer-chip')).toHaveText('交接');
  await expect(input).toHaveValue('');
  await input.type('只留下迁移进度');
  await input.press('Enter');
  await expect.poll(async () => (await state.requests()).some((r) => /\/handoff$/.test(r.url) && r.method === 'POST')).toBe(true);
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('next-composer-chip')).toHaveCount(0);
  await expect(input).toBeEnabled();

  await input.fill('/sch');
  await input.press('Enter');
  await expect(page.getByTestId('next-composer-chip')).toHaveText('定时');
  await expect(input).toHaveValue('');
  await input.type('明天检查日志');
  await input.press('Enter');
  await expect(page.getByTestId('next-composer-schedule-popover')).toBeVisible();
  await expect(input).toHaveValue('明天检查日志');
  await expect(page.getByTestId('next-composer-chip')).toHaveText('定时');
  await page.getByTestId('next-schedule-opt-1h').click();
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('next-composer-chip')).toHaveCount(0);

  // /model does not exist in slash menu
  await input.fill('/mod');
  await expect(page.locator('[data-testid=next-slash-item][data-id="model"]')).toHaveCount(0);
  await input.fill('');

  await input.fill('/new');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/(w\/[^/]+\/)?new$/);
  expectClean(state);
});

test('running conversation: /compact and /handoff show disabled reason, flash on click/Enter, and sending with chip does not clear input', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-rich');
  const input = page.getByTestId('next-composer-input');
  await input.click();
  await input.fill('请开始分析');
  await input.press('Enter');
  await expect(page.getByTestId('next-stop')).toBeVisible();

  await input.fill('/comp');
  const compactRow = page.locator('[data-testid=next-slash-item][data-id="compact"]');
  await expect(compactRow).toBeVisible();
  await expect(compactRow).toHaveAttribute('aria-disabled', 'true');
  await expect(compactRow.locator('.composer-at-dir')).toHaveText('运行中，结束后可用');

  await input.press('Enter');
  await expect(compactRow).toHaveAttribute('data-flash', 'true');
  await expect(page.getByTestId('next-composer-chip')).toHaveCount(0);
  await expect(input).toHaveValue('/comp');

  await compactRow.click({ force: true });
  await expect(compactRow).toHaveAttribute('data-flash', 'true');
  await expect(page.getByTestId('next-composer-chip')).toHaveCount(0);

  await input.fill('/hand');
  const handoffRow = page.locator('[data-testid=next-slash-item][data-id="handoff"]');
  await expect(handoffRow).toBeVisible();
  await expect(handoffRow).toHaveAttribute('aria-disabled', 'true');
  await expect(handoffRow.locator('.composer-at-dir')).toHaveText('运行中，结束后可用');

  expectClean(state);
});

test('a skill is a block inside the input, Backspace removes it, the bubble shows it too', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const input = page.getByTestId('next-composer-input');
  await input.click();
  await input.fill('/');
  await expect(page.locator('[data-testid=next-slash-item][data-kind=skill]')).toHaveCount(4);
  await input.fill('/code');
  await input.press('Enter');
  const chip = page.getByTestId('next-composer-chip');
  await expect(chip).toHaveText('代码审查');
  await expect(input).toHaveValue('');
  // Not above the input any more.
  await expect(page.getByTestId('next-skill-tag')).toHaveCount(0);
  await expect(page.getByTestId('next-composer-tags')).toHaveCount(0);

  // The block sits on the first line: same vertical band as the typed text, text starts after it.
  await input.type('x');
  const box = await chip.boundingBox();
  const area = await input.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(area.y - 2);
  expect(box.y + box.height).toBeLessThanOrEqual(area.y + 36);
  expect(await input.evaluate((el) => parseFloat(el.style.textIndent))).toBeGreaterThan(box.width);
  await input.press('Backspace');

  // Backspace at the start removes the whole block.
  await input.press('Backspace');
  await expect(chip).toHaveCount(0);
  await expect(input).toHaveValue('');
  expect(await input.evaluate((el) => el.style.textIndent)).toBe('');

  await input.fill('/code');
  await input.press('Enter');
  await expect(chip).toBeVisible();
  await input.fill('看一下这次改动\n第二行');
  await input.press('Enter');
  await expect(chip).toHaveCount(0);
  const bubble = page.getByTestId('next-item-user').last();
  await expect(bubble.getByTestId('next-user-chip')).toHaveText('代码审查');
  await expect(bubble).toContainText('看一下这次改动');
  await expect(bubble).not.toContainText('/code-review');
  await expect(page.getByTestId('next-item-assistant').last()).toContainText('用了技能「代码审查」', { timeout: 30_000 });
  expectClean(state);
});

test('an unknown /xxx message is shown as typed, without a block', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const input = page.getByTestId('next-composer-input');
  await input.click();
  await input.fill('/nope 看一下');
  await input.press('Enter');
  const bubble = page.getByTestId('next-item-user').last();
  await expect(bubble).toContainText('/nope 看一下');
  await expect(bubble.getByTestId('next-user-chip')).toHaveCount(0);
  expectClean(state);
});
