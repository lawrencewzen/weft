import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

test('tree search: input shows results, clicking opens file, Esc restores tree with directory expanded state intact', async ({ page }) => {
  const state = await openProto(page);

  // Switch to File tab in right pane
  await page.getByTestId('next-right-toggle').click();
  await page.getByTestId('next-right-tab-files').click();
  const fileBrowser = page.locator('.file-browser');
  await expect(fileBrowser).toBeVisible();

  // In default tree, docs is expanded and docs/PLAN.md is visible
  const docsDir = page.locator('[data-testid=next-file-node][data-path="docs"]');
  await expect(docsDir).toBeVisible();
  const planNode = page.locator('[data-testid=next-file-node][data-path="docs/PLAN.md"]');
  await expect(planNode).toBeVisible();

  // Click docs to collapse it
  await docsDir.click();
  await expect(planNode).toHaveCount(0);

  // Tree search input
  const searchInput = page.getByTestId('next-file-tree-search-input');
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveAttribute('placeholder', '搜索文件…');

  // Type search query
  await searchInput.fill('store');

  // Verify matched search result row is shown
  const storeResult = page.locator('[data-testid=file-search-result-row][data-path="web/src/data/store.ts"]');
  await expect(storeResult).toBeVisible();

  // The original tree nodes are replaced by search results
  await expect(docsDir).toHaveCount(0);

  // Click search result to open file
  await storeResult.click();

  // Verify file opens in editor
  await expect(page.getByTestId('next-file-editor')).toBeVisible();
  await expect(page.locator('.file-preview-head .path')).toContainText('web/src/data/store.ts');

  // Clear query via Escape to restore tree
  await searchInput.focus();
  await page.keyboard.press('Escape');
  await expect(searchInput).toHaveValue('');

  // Original tree is restored and docs directory remains in its collapsed state
  await expect(docsDir).toBeVisible();
  await expect(planNode).toHaveCount(0);

  // Click docsDir to expand it again and verify it opens normally
  await docsDir.click();
  await expect(planNode).toBeVisible();

  expectClean(state);
});

test('Cmd+P opens quick open modal, keyboard navigation and Enter opens file, switches right tab to File and expands right pane', async ({ page }) => {
  const state = await openProto(page);
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

  await expect(page.getByTestId('next-composer-input')).toBeVisible();

  // Right pane starts collapsed by default; ensure toggle is visible
  const collapseBtn = page.getByTestId('next-right-collapse');
  if (await collapseBtn.isVisible().catch(() => false)) {
    await collapseBtn.click();
  }
  await expect(page.getByTestId('next-right-toggle')).toBeVisible();

  // Press Cmd+P / Ctrl+P
  await page.keyboard.press(`${modKey}+p`);

  const modal = page.getByTestId('next-quick-open-modal');
  await expect(modal).toBeVisible();

  const input = page.getByTestId('next-quick-open-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', '搜索文件…');

  // Search for conflict
  await input.fill('conflict');
  const targetRow = page.locator('[data-testid=file-search-result-row][data-path="demo/conflict.md"]');
  await expect(targetRow).toBeVisible();

  // Navigate with keyboard ArrowDown and press Enter
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // Modal is closed
  await expect(modal).toHaveCount(0);

  // Right pane is automatically expanded
  await expect(page.getByTestId('next-right-collapse')).toBeVisible();

  // Right tab is File
  await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);

  // The target file is opened in editor
  await expect(page.getByTestId('next-file-editor')).toContainText('保存冲突演示');

  expectClean(state);
});

test('Esc closes quick open modal and returns focus to previous element', async ({ page }) => {
  const state = await openProto(page);
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

  // Wait for composer textarea to be ready and focus it
  const composer = page.getByTestId('next-composer-input');
  await expect(composer).toBeVisible();
  await composer.focus();
  await expect(composer).toBeFocused();

  // Press Cmd+P / Ctrl+P
  await page.keyboard.press(`${modKey}+p`);
  const modal = page.getByTestId('next-quick-open-modal');
  await expect(modal).toBeVisible();

  const input = page.getByTestId('next-quick-open-input');
  await expect(input).toBeFocused();

  // Press Escape
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // Focus returns to previous element (composer textarea)
  await expect(composer).toBeFocused();

  expectClean(state);
});

test('rapid typing: old search results do not overwrite newer results', async ({ page }) => {
  const state = await openProto(page);
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

  await expect(page.getByTestId('next-composer-input')).toBeVisible();

  // Inject a mock delay into window.fetch for query "first"
  await page.evaluate(() => {
    const orig = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('file-search') && url.includes('q=first')) {
        await new Promise((r) => setTimeout(r, 300));
      }
      return orig(input, init);
    };
  });

  // Open quick open
  await page.keyboard.press(`${modKey}+p`);
  const input = page.getByTestId('next-quick-open-input');
  await expect(input).toBeFocused();

  // Rapidly type "first" and then "demo"
  await input.fill('first');
  await page.waitForTimeout(40);
  await input.fill('demo');

  // Wait for results of "demo"
  const demoResult = page.locator('[data-testid=file-search-result-row][data-path="demo/conflict.md"]');
  await expect(demoResult).toBeVisible();

  // Wait past the delay of the "first" query
  await page.waitForTimeout(350);

  // Ensure results are still for "demo", not overwritten
  await expect(demoResult).toBeVisible();

  await page.keyboard.press('Escape');
  expectClean(state);
});

test('774px viewport has no horizontal scrolling', async ({ page }) => {
  const state = await openProto(page);
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

  await expect(page.getByTestId('next-composer-input')).toBeVisible();
  await page.setViewportSize({ width: 774, height: 800 });

  // Open Cmd+P modal at 774px
  await page.keyboard.press(`${modKey}+p`);
  const modal = page.getByTestId('next-quick-open-modal');
  await expect(modal).toBeVisible();

  const modalHasHScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(modalHasHScroll).toBe(false);

  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // Test tree search at 774px (in drawer)
  await page.getByTestId('next-right-toggle').click();
  await page.getByTestId('next-right-tab-files').click();
  const toggleBtn = page.getByTestId('next-file-tree-toggle');
  if (await toggleBtn.isVisible()) {
    await toggleBtn.click();
  }

  const treeSearch = page.getByTestId('next-file-tree-search-input');
  await expect(treeSearch).toBeVisible();
  await treeSearch.fill('README');

  const treeHasHScroll = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(treeHasHScroll).toBe(false);

  expectClean(state);
});

test('Cmd+P in conversation without workspace does not error', async ({ page }) => {
  const state = await openProto(page);
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

  await expect(page.getByTestId('next-composer-input')).toBeVisible();

  // Click a no-project conversation
  const consultRow = page.locator('[data-testid=next-conv-row][data-id="c-consult"]');
  await expect(consultRow).toBeVisible();
  await consultRow.click();
  await expect(page).toHaveURL(/#\/c\/c-consult$/);

  // Press Cmd+P / Ctrl+P
  await page.keyboard.press(`${modKey}+p`);

  // Modal does not open because conversation has no project workspace
  const modal = page.getByTestId('next-quick-open-modal');
  await expect(modal).toHaveCount(0);

  // No errors
  expectClean(state);
});
