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
  await expect(menu.locator('[data-kind=command]')).toHaveCount(5);
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

test('/compact runs the existing compaction; draft hides it', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const input = page.getByTestId('next-composer-input');
  await input.click();
  await input.fill('/comp');
  await expect(page.getByTestId('next-slash-item')).toHaveAttribute('data-id', 'compact');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await expect.poll(async () => (await state.requests()).some((r) => /\/compact$/.test(r.url) && r.method === 'POST')).toBe(true);

  await page.getByTestId('next-new-chat').click();
  const draftInput = page.getByTestId('next-composer-input');
  await draftInput.click();
  await draftInput.fill('/');
  await expect(page.getByTestId('next-slash-menu')).toBeVisible();
  await expect(page.locator('[data-testid=next-slash-item][data-id="compact"]')).toHaveCount(0);
  await expect(page.locator('[data-testid=next-slash-item][data-id="handoff"]')).toHaveCount(0);
  expectClean(state);
});

test('/handoff, /schedule, /model and /new', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const input = page.getByTestId('next-composer-input');
  await input.click();

  await input.fill('/hand');
  await input.press('Enter');
  await expect(input).toHaveValue('/handoff ');
  await input.type('只留下迁移进度');
  await input.press('Enter');
  await expect.poll(async () => (await state.requests()).some((r) => /\/handoff$/.test(r.url) && r.method === 'POST')).toBe(true);
  await expect(input).toHaveValue('');
  await expect(input).toBeEnabled();

  await input.fill('/sch');
  await input.press('Enter');
  await expect(input).toHaveValue('/schedule ');
  await input.type('明天检查日志');
  await input.press('Enter');
  await expect(page.getByTestId('next-composer-schedule-popover')).toBeVisible();
  await expect(input).toHaveValue('明天检查日志');
  await page.getByTestId('next-schedule-opt-1h').click();
  await expect(input).toHaveValue('');

  await input.fill('/mod');
  await input.press('Enter');
  await expect(page.getByTestId('next-menu-model')).toBeVisible();
  await page.keyboard.press('Escape');

  await input.fill('/new');
  await input.press('Enter');
  await expect(page).toHaveURL(/#\/(w\/[^/]+\/)?new$/);
  expectClean(state);
});

test('picking a skill shows a removable tag and the reply says which skill ran', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const input = page.getByTestId('next-composer-input');
  await input.click();
  await input.fill('/');
  await expect(page.locator('[data-testid=next-slash-item][data-kind=skill]')).toHaveCount(4);
  await input.fill('/code');
  await input.press('Enter');
  const tag = page.getByTestId('next-skill-tag');
  await expect(tag).toContainText('/code-review');
  await expect(input).toHaveValue('');

  await page.getByTestId('next-skill-remove').click();
  await expect(tag).toHaveCount(0);

  await input.fill('/code');
  await input.press('Enter');
  await expect(tag).toBeVisible();
  await input.fill('看一下这次改动');
  await input.press('Enter');
  await expect(tag).toHaveCount(0);
  await expect(page.getByTestId('next-item-user').last()).toContainText('/code-review 看一下这次改动');
  await expect(page.getByTestId('next-item-assistant').last()).toContainText('用了技能「代码审查」', { timeout: 30_000 });
  expectClean(state);
});
