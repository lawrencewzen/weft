import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

test('1. Right pane pulled to 700px: side-by-side layout, full height, draggable divider, persistent width', async ({ page }) => {
  // Set right pane width to 700px
  const state = await openProto(page);
  await page.evaluate(() => {
    localStorage.setItem('weft_next_right_w', '700');
    localStorage.removeItem('weft_next_file_tree_w');
  });
  await page.reload();
  await page.getByTestId('next-right-tab-files').click();

  const fileBrowser = page.locator('.file-browser');
  await expect(fileBrowser).toBeVisible();

  const fileTree = fileBrowser.locator('> .file-tree');
  const filePreview = fileBrowser.locator('.file-preview');
  const treeDivider = page.getByTestId('next-file-tree-divider');

  await expect(fileTree).toBeVisible();
  await expect(filePreview).toBeVisible();
  await expect(treeDivider).toBeVisible();

  // Side-by-side layout check: tree on left, preview on right
  const treeBox = await fileTree.boundingBox();
  const previewBox = await filePreview.boundingBox();
  const browserBox = await fileBrowser.boundingBox();

  expect(treeBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(browserBox).not.toBeNull();

  expect(treeBox.x).toBeLessThan(previewBox.x);
  // Both take full height
  expect(Math.abs(treeBox.height - previewBox.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(treeBox.height - browserBox.height)).toBeLessThanOrEqual(2);

  // Drag divider to change width
  const divBox = await treeDivider.boundingBox();
  expect(divBox).not.toBeNull();

  const startTreeW = treeBox.width;
  // Drag divider +50px
  await page.mouse.move(divBox.x + divBox.width / 2, divBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(divBox.x + 50, divBox.y + 50);
  await page.mouse.up();

  // Width changed
  const newTreeBox = await fileTree.boundingBox();
  expect(newTreeBox.width).toBeGreaterThan(startTreeW + 30);

  // Stored in localStorage and persists across reload
  const savedW = await page.evaluate(() => localStorage.getItem('weft_next_file_tree_w'));
  expect(savedW).not.toBeNull();
  expect(Number(savedW)).toBeGreaterThan(200);

  await page.reload();
  await page.getByTestId('next-right-tab-files').click();
  const reloadedTreeBox = await page.locator('.file-browser > .file-tree').boundingBox();
  expect(Math.abs(reloadedTreeBox.width - newTreeBox.width)).toBeLessThanOrEqual(2);

  expectClean(state);
});

test('2. Narrow right pane: file tree collapsed, toggle button opens drawer, selection/Esc/click-outside closes drawer', async ({ page }) => {
  const state = await openProto(page);
  // Set right pane width < 420px (cannot fit tree min 140 + preview 280)
  await page.evaluate(() => {
    localStorage.setItem('weft_next_right_w', '360');
  });
  await page.reload();
  await page.getByTestId('next-right-tab-files').click();

  // In narrow mode, side-by-side tree is not displayed in flow
  await expect(page.locator('.file-browser > .file-tree')).toHaveCount(0);
  await expect(page.getByTestId('next-file-tree-divider')).toHaveCount(0);
  await expect(page.locator('.file-preview')).toBeVisible();

  // Toggle button appears in toolbar
  const toggleBtn = page.getByTestId('next-file-tree-toggle');
  await expect(toggleBtn).toBeVisible();

  // 1. Click toggle button -> drawer opens
  await toggleBtn.click();
  const drawer = page.locator('.file-tree-drawer');
  await expect(drawer).toBeVisible();

  // 2. Click file -> opens file and drawer automatically closes
  const readmeNode = drawer.locator('[data-testid=next-file-node][data-path="README.md"]');
  await expect(readmeNode).toBeVisible();
  await readmeNode.click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('next-file-editor')).toBeVisible();

  // 3. Click toggle button again -> Esc closes drawer
  await toggleBtn.click();
  await expect(page.locator('.file-tree-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.file-tree-drawer')).toHaveCount(0);

  // 4. Click toggle button again -> click outside closes drawer
  await toggleBtn.click();
  await expect(page.locator('.file-tree-drawer')).toBeVisible();
  // Click preview area outside the drawer
  await page.mouse.click(360 * 0.9 - 20, 300);
  await expect(page.locator('.file-tree-drawer')).toHaveCount(0);

  // 5. When pane is wide (700px), toggle button does not appear
  await page.evaluate(() => {
    localStorage.setItem('weft_next_right_w', '700');
  });
  await page.reload();
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.getByTestId('next-file-tree-toggle')).toHaveCount(0);
  await expect(page.locator('.file-browser > .file-tree')).toBeVisible();

  expectClean(state);
});

test('3. Maximize: left edge equals middle column, chat hidden, draft preserved, Esc restores, switch conversation restores', async ({ page }) => {
  const state = await openProto(page);
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

  // 1. Enter draft in Composer
  const composerInput = page.getByTestId('next-composer-input');
  await expect(composerInput).toBeVisible();
  await composerInput.fill('草稿测试输入不丢失');

  // Measure center column's left edge before maximize
  const centerBoxBefore = await page.locator('.col-center').boundingBox();
  expect(centerBoxBefore).not.toBeNull();

  // Switch to files tab
  await page.getByTestId('next-right-tab-files').click();
  const maxBtn = page.getByTestId('next-file-maximize');
  await expect(maxBtn).toBeVisible();
  await expect(maxBtn).toHaveAttribute('title', /放大|Maximize/);

  // 2. Click maximize button
  await maxBtn.click();
  await page.waitForTimeout(300);

  // Right pane left edge equals center column's previous left edge
  const rightBoxMaximized = await page.locator('.col-right').boundingBox();
  expect(rightBoxMaximized).not.toBeNull();
  expect(Math.abs(rightBoxMaximized.x - centerBoxBefore.x)).toBeLessThanOrEqual(2);

  // Chat conversation is not visible
  await expect(page.locator('.col-center')).not.toBeVisible();
  await expect(maxBtn).toHaveAttribute('title', /还原|Restore/);

  // 3. Restore via button
  await maxBtn.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).toBeVisible();
  await expect(composerInput).toHaveValue('草稿测试输入不丢失');

  // 4. Maximize again -> Esc restores
  await maxBtn.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).toBeVisible();
  await expect(composerInput).toHaveValue('草稿测试输入不丢失');

  // 5. CodeMirror search panel with Esc: Esc closes search first, next Esc restores maximize
  await page.getByTestId('next-right-tab-files').click();
  await page.locator('[data-testid=next-file-node][data-path="web/src/data/store.ts"]').click();
  await expect(page.getByTestId('next-file-editor')).toBeVisible();

  await maxBtn.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).not.toBeVisible();

  // Focus editor and open search panel
  const cmContent = page.locator('.cm-content');
  await cmContent.click();
  await cmContent.focus();
  await page.keyboard.press(`${modKey}+f`);
  const searchPanel = page.locator('.cm-panel.cm-search');
  await expect(searchPanel).toBeVisible();

  // First Esc closes search panel; right pane remains maximized
  await page.keyboard.press('Escape');
  await expect(searchPanel).toHaveCount(0);
  await expect(page.locator('.col-center')).not.toBeVisible();

  // Second Esc restores maximize
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).toBeVisible();

  // 6. Switching conversation restores automatically
  await page.getByTestId('next-right-tab-files').click();
  await maxBtn.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).not.toBeVisible();

  // Click another conversation in sidebar (e.g. c-docs)
  const docsConv = page.locator('[data-testid=next-conv-row][data-id="c-docs"]');
  await expect(docsConv).toBeVisible();
  await docsConv.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).toBeVisible();

  // 7. Switching to Changes tab restores automatically
  await page.getByTestId('next-right-tab-files').click();
  await maxBtn.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).not.toBeVisible();

  await page.getByTestId('next-right-tab-changes').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).toBeVisible();
  // Maximize button does not exist on Changes tab
  await expect(page.getByTestId('next-file-maximize')).toHaveCount(0);

  // 8. Collapse right pane while maximized restores and collapses without blank space
  await page.getByTestId('next-right-tab-files').click();
  await maxBtn.click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).not.toBeVisible();

  await page.getByTestId('next-right-collapse').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.col-center')).toBeVisible();
  await expect(page.locator('.col-right')).not.toBeVisible();

  // Refresh page restores normal layout (not maximized)
  await page.reload();
  await expect(page.locator('.col-center')).toBeVisible();

  expectClean(state);
});

test('4. 774px viewport has no horizontal scrolling in normal and maximized layouts', async ({ page }) => {
  const state = await openProto(page);
  await page.setViewportSize({ width: 774, height: 900 });
  await page.waitForTimeout(300);

  const hasHScrollNormal = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHScrollNormal).toBe(false);

  // Open right panel and switch to files
  await page.getByTestId('next-right-toggle').click();
  await page.getByTestId('next-right-tab-files').click();
  await page.waitForTimeout(300);

  const hasHScrollOpen = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHScrollOpen).toBe(false);

  // Maximize in 774px viewport
  await page.getByTestId('next-file-maximize').click();
  await page.waitForTimeout(300);

  const hasHScrollMax = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHScrollMax).toBe(false);

  expectClean(state);
});

test('5. Divider dragging accuracy under zoom 0.9: mouse position matches divider within 2px', async ({ page }) => {
  const state = await openProto(page);
  // Set wide pane at 700px
  await page.evaluate(() => {
    localStorage.setItem('weft_next_right_w', '700');
    localStorage.removeItem('weft_next_file_tree_w');
  });
  await page.reload();
  await page.getByTestId('next-right-tab-files').click();

  const currentZoom = await page.evaluate(() => getComputedStyle(document.documentElement).zoom);
  expect(Number(currentZoom)).toBeCloseTo(0.9, 1);

  const treeDivider = page.getByTestId('next-file-tree-divider');
  await expect(treeDivider).toBeVisible();

  const initialDivBox = await treeDivider.boundingBox();
  expect(initialDivBox).not.toBeNull();

  // Move to divider center and start drag
  const dragY = initialDivBox.y + 100;
  await page.mouse.move(initialDivBox.x + initialDivBox.width / 2, dragY);
  await page.mouse.down();

  // Drag by +40px visual
  const targetX = initialDivBox.x + 40;
  await page.mouse.move(targetX, dragY);

  const draggedDivBox = await treeDivider.boundingBox();
  expect(draggedDivBox).not.toBeNull();

  // Divider position matches mouse position within 2px
  expect(Math.abs(draggedDivBox.x - targetX)).toBeLessThanOrEqual(2);

  await page.mouse.up();
  expectClean(state);
});
