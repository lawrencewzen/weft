import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

async function openConv(page, id) {
  await page.locator(`[data-testid=next-conv-row][data-id="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${id}$`));
}

async function openMenu(page) {
  await page.getByTestId('next-model-chip').click();
  await expect(page.getByTestId('next-model-menu')).toBeVisible();
}

test('1. c-compacted shows a grey compaction note, not a user bubble; no context banner', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-compacted');

  const note = page.getByTestId('next-item-system-note');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-kind', 'compaction');
  await expect(note).toHaveText('已压缩较早的上下文');
  await expect(page.getByTestId('next-item-user')).toHaveCount(2);
  await expect(page.getByTestId('next-item-user').filter({ hasText: '已压缩' })).toHaveCount(0);
  await expect(page.getByTestId('next-context-banner')).toHaveCount(0);
  await expect(page.getByTestId('next-context-chip')).toBeVisible();
  await expectClean(state);
});

test('2. menu compact: running state with spinner and thread line, then the note lands', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  await expect(page.getByTestId('next-context-chip')).toHaveText('86%');
  await expect(page.getByTestId('next-item-system-note')).toHaveCount(0);

  await openMenu(page);
  const row = page.getByTestId('next-menu-compact');
  await expect(row).toHaveText('压缩');
  await expect(row).toBeEnabled();
  await row.click();

  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('next-compact-spin')).toBeVisible();
  await expect(page.getByTestId('next-thread-compacting')).toHaveText('正在压缩上下文');

  await expect(page.getByTestId('next-thread-compacting')).toHaveCount(0, { timeout: 10_000 });
  const note = page.getByTestId('next-item-system-note');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-kind', 'compaction');
  await expect(page.getByTestId('next-compaction-error')).toHaveCount(0);
  await expect(page.getByTestId('next-context-chip')).toHaveText('12%');
  await expect(row).toBeEnabled();

  const calls = (await state.requests()).filter((r) => r.method === 'POST' && /\/compact$/.test(r.url));
  expect(calls).toHaveLength(1);
  await expectClean(state);
});

test('3. compact is clickable while the conversation is running', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-rich');
  await openMenu(page);
  const row = page.getByTestId('next-menu-compact');
  await expect(row).toBeEnabled();
  await row.click();
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('next-thread-compacting')).toBeVisible();
  await expectClean(state);
});

test('4. c-compact-failed shows the error at the end of the thread, no continue; retry fails the same way', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-compact-failed');

  const err = page.getByTestId('next-compaction-error');
  await expect(err).toBeVisible();
  await expect(err).toHaveText('压缩失败：模型请求超时');
  await expect(err).toHaveClass(/llm-error/);
  await expect(err.getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('next-run-continue')).toHaveCount(0);
  // last child of the thread flow
  const lastIsError = await err.evaluate((el) => el.parentElement?.lastElementChild === el);
  expect(lastIsError).toBe(true);

  await openMenu(page);
  const row = page.getByTestId('next-menu-compact');
  await expect(row).toHaveAttribute('data-state', 'failed');
  await expect(row).toContainText('压缩失败：模型请求超时');
  await row.click();
  await expect(row).toBeDisabled();
  await expect(page.getByTestId('next-compaction-error')).toHaveCount(0);
  await expect(page.getByTestId('next-thread-compacting')).toBeVisible();
  await expect(page.getByTestId('next-compaction-error')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('next-item-system-note')).toHaveCount(0);
  await expectClean(state);
});

test('5. settings: auto-compact trigger validates 60-90 integers and persists for the session', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  const input = page.getByTestId('next-pref-compact-trigger');
  await expect(input).toHaveValue('80');
  await expect(page.getByTestId('next-settings-general')).toContainText('自动压缩触发点');
  const err = page.getByTestId('next-pref-compact-error');

  const puts = async () => (await state.requests()).filter((r) => r.method === 'PUT' && /\/api\/v2\/settings$/.test(r.url)).length;

  for (const bad of ['59', '91', '1.5', '']) {
    await input.fill(bad);
    await input.press('Enter');
    await expect(err).toBeVisible();
    await expect(err).toHaveText('请输入 60 到 90 的整数');
  }
  expect(await puts()).toBe(0);

  await input.fill('60');
  await input.press('Enter');
  await expect(err).toHaveCount(0);
  expect(await puts()).toBe(1);
  await input.fill('90');
  await input.blur();
  await expect(err).toHaveCount(0);
  expect(await puts()).toBe(2);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toBeHidden();
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-pref-compact-trigger')).toHaveValue('90');
  await expectClean(state);
});

test('6. English labels and dark theme', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-pref-lang').locator('[data-lang=en]').click();
  await page.getByTestId('next-pref-appearance').locator('[data-mode=dark]').click();
  await expect(page.getByTestId('next-settings-general')).toContainText('Auto-compact at');
  await page.getByTestId('next-pref-compact-trigger').fill('50');
  await page.getByTestId('next-pref-compact-trigger').press('Enter');
  await expect(page.getByTestId('next-pref-compact-error')).toHaveText('Enter a whole number from 60 to 90');
  await page.keyboard.press('Escape');

  await openConv(page, 'c-compact-failed');
  await expect(page.getByTestId('next-compaction-error')).toHaveText('Compaction failed: model request timed out');
  await openMenu(page);
  await expect(page.getByTestId('next-menu-compact')).toContainText('Compact');
  await page.getByTestId('next-menu-compact').click();
  await expect(page.getByTestId('next-thread-compacting')).toHaveText('Compacting context');
  await expect(page.getByTestId('next-compaction-error')).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press('Escape');
  await openConv(page, 'c-compacted');
  await expect(page.getByTestId('next-item-system-note')).toHaveText('Earlier context was compacted');
  await expectClean(state);
});
