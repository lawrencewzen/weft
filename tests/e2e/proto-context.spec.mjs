import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const protoFile = path.join(root, 'design', 'prototype', 'index.html');

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('prototype context window UI: context in model menu, presets, custom input, warn banner, and non-clickable chip', async ({ page }) => {
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

  // 1. Context chip is non-clickable display only
  const contextChip = page.getByTestId('next-context-chip');
  await expect(contextChip).toBeVisible();
  await expect(contextChip).toHaveText('24%');
  await contextChip.click();
  await expect(page.getByTestId('next-context-menu')).toHaveCount(0);
  await expect(page.getByTestId('next-model-menu')).toBeHidden();

  // 2. Open model menu, hover context row reveals submenu
  const modelChip = page.getByTestId('next-model-chip');
  await modelChip.click();
  const menu = page.getByTestId('next-model-menu');
  await expect(menu).toBeVisible();

  const ctxRow = page.getByTestId('next-menu-context');
  await expect(ctxRow).toBeVisible();
  await expect(ctxRow).toContainText('上下文');
  await expect(ctxRow).toContainText('1M');

  await ctxRow.hover();
  const ctxSub = page.getByTestId('next-sub-context');
  await expect(ctxSub).toBeVisible();
  await expect(ctxSub).toContainText('DeepSeek V4.1 Flash 的上下文上限');

  // 3. Pick 64K preset -> menu closes, ring and percent update to 75%
  await page.locator('[data-testid=next-context-option][data-tokens="64000"]').click();
  await expect(menu).toBeHidden();
  await expect(contextChip).toHaveText('75%');
  await expect(contextChip).toHaveAttribute('title', /48\.2k \/ 64k/);
  await expect(contextChip).toHaveAttribute('title', /已用 75%/);

  // Re-open model menu, context row now shows 64k
  await modelChip.click();
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('next-menu-context')).toContainText('64k');

  // 4. Custom input: enter 50000 -> 48.2k / 50k is 96%, triggers warn banner
  await page.getByTestId('next-menu-context').hover();
  await expect(ctxSub).toBeVisible();
  const customInput = page.getByTestId('next-context-custom');
  await customInput.fill('50000');
  await page.getByTestId('next-context-apply').click();
  await expect(menu).toBeHidden();

  await expect(contextChip).toHaveText('96%');
  await expect(contextChip).toHaveClass(/is-warn/);
  await expect(page.getByTestId('next-context-banner')).toBeVisible();
  await expect(page.getByTestId('next-context-banner')).toContainText('96%');

  // Re-open model menu, context row shows 50k · 自定义
  await modelChip.click();
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('next-menu-context')).toContainText('50k · 自定义');

  // 5. Restore default -> resets to catalog window (1M), removes warn banner
  await page.getByTestId('next-menu-context').hover();
  await expect(ctxSub).toBeVisible();
  await page.getByTestId('next-context-restore').click();
  await expect(menu).toBeHidden();

  await expect(contextChip).toHaveText('5%');
  await expect(contextChip).not.toHaveClass(/is-warn/);
  await expect(page.getByTestId('next-context-banner')).toHaveCount(0);

  // 6. Inline sub-menu on narrow screen
  await page.setViewportSize({ width: 500, height: 800 });
  await modelChip.click();
  await expect(menu).toBeVisible();

  await page.getByTestId('next-menu-context').click();
  const backBtn = page.getByTestId('next-menu-back');
  await expect(backBtn).toBeVisible();
  await expect(backBtn).toContainText('‹ 上下文');

  await backBtn.click();
  await expect(page.getByTestId('next-menu-model')).toBeVisible();
  await expect(page.getByTestId('next-menu-context')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Invariants: no uncaught page errors, no console errors, no external requests
  expect(pageErrors, 'page has no uncaught errors').toEqual([]);
  expect(consoleErrors, 'page has no console errors').toEqual([]);
  expect(external, 'page makes no external requests').toEqual([]);
});
