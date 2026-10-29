import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const protoFile = path.join(root, 'design', 'prototype', 'index.html');

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('prototype thinking UI: Plan D model-thinking menu, submenus, clamp, recent, and inline fallback', async ({ page }) => {
  expect(
    fs.existsSync(protoFile),
    'prototype build missing: run `npm run build:proto` first',
  ).toBe(true);

  const consoleErrors = [];
  const pageErrors = [];
  const external = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('request', (req) => {
    const url = req.url();
    if (!/^(file|data|blob):/i.test(url)) external.push(url);
  });

  await page.goto(pathToFileURL(protoFile).href);
  await expect(page.getByTestId('next-app')).toBeVisible();

  // 1. Initial state on rich conversation: DeepSeek V4.1 Flash, default thinking is 'high'
  const modelChip = page.getByTestId('next-model-chip');
  await expect(modelChip).toBeVisible();
  await expect(modelChip).toContainText('DeepSeek V4.1 Flash');
  await expect(modelChip).toContainText('· 高');

  // 2. Open menu, hover "思考" displays thinking sub-menu
  await modelChip.click();
  const menu = page.getByTestId('next-model-menu');
  await expect(menu).toBeVisible();

  const thinkingRow = page.getByTestId('next-menu-thinking');
  await expect(thinkingRow).toBeVisible();
  await expect(thinkingRow).toContainText('思考');
  await expect(thinkingRow).toContainText('高');

  await thinkingRow.hover();
  const thinkingSub = page.getByTestId('next-sub-thinking');
  await expect(thinkingSub).toBeVisible();
  await expect(thinkingSub).toContainText('思考 · DeepSeek V4.1 Flash');
  await expect(thinkingSub).toContainText('关');
  await expect(thinkingSub).toContainText('低');
  await expect(thinkingSub).toContainText('高');
  await expect(thinkingSub).toContainText('最高');
  await expect(thinkingSub).toContainText('越高越慢，也越费 token');

  // 3. Pick "最高", button text becomes `· 最高`
  await page.locator('[data-testid=next-thinking-option][data-level="max"]').click();
  await expect(menu).toBeHidden();
  await expect(modelChip).toContainText('DeepSeek V4.1 Flash');
  await expect(modelChip).toContainText('· 最高');

  // 4. Switch to V4 Pro: thinking level automatically adjusts
  await modelChip.click();
  await expect(menu).toBeVisible();
  await page.getByTestId('next-menu-model').hover();
  await expect(page.getByTestId('next-sub-models')).toBeVisible();

  await page.locator('[data-testid=next-model-option][data-model="deepseek-v4-pro"]').click();
  await expect(menu).toBeHidden();
  await expect(modelChip).toContainText('DeepSeek V4 Pro');
  // max is supported on pro, stays max
  await expect(modelChip).toContainText('· 最高');

  // Switch to 'off' on V4 Pro -> button shows no suffix
  await modelChip.click();
  await expect(menu).toBeVisible();
  await page.getByTestId('next-menu-thinking').hover();
  await page.locator('[data-testid=next-thinking-option][data-level="off"]').click();
  await expect(menu).toBeHidden();
  await expect(modelChip).toContainText('DeepSeek V4 Pro');
  await expect(page.getByTestId('next-model-chip-thinking')).toHaveCount(0);

  // 5. Recent items 1-click switch
  await modelChip.click();
  await expect(menu).toBeVisible();
  const recentOption = page.getByTestId('next-recent-option').first();
  await expect(recentOption).toBeVisible();
  await expect(recentOption).toContainText('DeepSeek V4.1 Flash');
  await expect(recentOption).toContainText('最高思考');

  await recentOption.click();
  await expect(menu).toBeHidden();
  await expect(modelChip).toContainText('DeepSeek V4.1 Flash');
  await expect(modelChip).toContainText('· 最高');

  // 6. Unsupported model (qwen3-coder-480b): thinking row is grayed out / disabled
  await modelChip.click();
  await expect(menu).toBeVisible();
  await page.getByTestId('next-menu-model').hover();
  await page.locator('[data-testid=next-model-option][data-model="qwen3-coder-480b"]').click();
  await expect(menu).toBeHidden();
  await expect(modelChip).toContainText('qwen3-coder-480b');
  await expect(page.getByTestId('next-model-chip-thinking')).toHaveCount(0);

  await modelChip.click();
  await expect(menu).toBeVisible();
  const disThinkingRow = page.getByTestId('next-menu-thinking');
  await expect(disThinkingRow).toHaveClass(/dis/);
  await expect(disThinkingRow).toContainText('不支持');

  // 7. Narrow viewport: inline sub-menu with back button
  await page.setViewportSize({ width: 420, height: 800 });

  // Click model row in narrow mode -> enters inline sub-menu
  await page.getByTestId('next-menu-model').click();
  const backBtn = page.getByTestId('next-menu-back');
  await expect(backBtn).toBeVisible();
  await expect(backBtn).toContainText('‹ 模型');

  // Switch back to deepseek-flash
  await page.locator('[data-testid=next-model-option][data-model="deepseek-flash"]').click();
  await expect(menu).toBeHidden();

  // Re-open in narrow mode, click thinking row -> enters inline thinking sub-menu
  await modelChip.click();
  await expect(menu).toBeVisible();
  await page.getByTestId('next-menu-thinking').click();
  await expect(backBtn).toBeVisible();
  await expect(backBtn).toContainText('‹ 思考');

  // Click back button -> returns to primary menu
  await backBtn.click();
  await expect(page.getByTestId('next-menu-model')).toBeVisible();
  await expect(page.getByTestId('next-menu-thinking')).toBeVisible();

  // Close menu with Escape
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Invariants: no uncaught page errors, no console errors, no network requests
  expect(pageErrors, 'page has no uncaught errors').toEqual([]);
  expect(consoleErrors, 'page has no console errors').toEqual([]);
  expect(external, 'page makes no external requests').toEqual([]);
});
