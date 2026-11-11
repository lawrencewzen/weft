import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

async function getTokenColors(page) {
  return page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-line'));
    const map = new Map();
    for (const line of lines) {
      for (const span of Array.from(line.querySelectorAll('span'))) {
        const text = span.textContent?.trim();
        if (text && !map.has(text)) {
          map.set(text, getComputedStyle(span).color);
        }
      }
    }
    return Object.fromEntries(map);
  });
}

test('syntax highlighting in .mjs and package.json: keyword, string, comment, and variable are pairwise distinct in light and dark modes, and JSON keys and values are distinct', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-right-toggle').click();
  await page.getByTestId('next-right-tab-files').click();

  // --- 1. Light Mode: .mjs tokens check ---
  await page.locator('[data-testid=next-file-node][data-path="src/kernel/index.mjs"]').click();
  await expect(page.getByTestId('next-file-editor')).toBeVisible();
  await page.waitForTimeout(500);

  const lightColors = await getTokenColors(page);
  const lightKw = lightColors['import'];
  const lightStr = lightColors["'@earendil-works/pi-durable'"];
  const lightCom = lightColors['/** Pi Durable Harness 的薄封装：对话、任务、检查点都在内核里。 */'];
  const lightVar = lightColors['Harness'];

  expect(lightKw).toBeDefined();
  expect(lightStr).toBeDefined();
  expect(lightCom).toBeDefined();
  expect(lightVar).toBeDefined();

  // All 4 token colors must be pairwise distinct
  const lightMjsSet = new Set([lightKw, lightStr, lightCom, lightVar]);
  expect(lightMjsSet.size, 'keyword, string, comment, and variable colors must all be pairwise distinct in light mode').toBe(4);

  // --- 2. Light Mode: JSON key vs string value check ---
  await page.locator('[data-testid=next-file-node][data-path="package.json"]').click();
  await page.waitForTimeout(500);

  const lightJsonColors = await getTokenColors(page);
  const lightJsonKey = lightJsonColors['"name"'];
  const lightJsonVal = lightJsonColors['"weft"'];

  expect(lightJsonKey).toBeDefined();
  expect(lightJsonVal).toBeDefined();
  expect(lightJsonKey, 'JSON key and string value colors must be distinct in light mode').not.toBe(lightJsonVal);

  // --- 3. Dark Mode: switch theme ---
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'white-dark'));
  await page.waitForTimeout(200);

  // Editor background and base ink check in dark mode
  const darkBg = await page.locator('.cm-editor').evaluate((el) => getComputedStyle(el).backgroundColor);
  const darkInk = await page.locator('.cm-editor').evaluate((el) => getComputedStyle(el).color);
  expect(darkBg).toBe('rgb(31, 31, 31)');
  expect(darkInk).toBe('rgb(228, 228, 228)');

  // JSON in dark mode
  const darkJsonColors = await getTokenColors(page);
  const darkJsonKey = darkJsonColors['"name"'];
  const darkJsonVal = darkJsonColors['"weft"'];

  expect(darkJsonKey).toBeDefined();
  expect(darkJsonVal).toBeDefined();
  expect(darkJsonKey, 'JSON key and string value colors must be distinct in dark mode').not.toBe(darkJsonVal);

  // --- 4. Dark Mode: .mjs tokens check ---
  await page.locator('[data-testid=next-file-node][data-path="src/kernel/index.mjs"]').click();
  await page.waitForTimeout(500);

  const darkColors = await getTokenColors(page);
  const darkKw = darkColors['import'];
  const darkStr = darkColors["'@earendil-works/pi-durable'"];
  const darkCom = darkColors['/** Pi Durable Harness 的薄封装：对话、任务、检查点都在内核里。 */'];
  const darkVar = darkColors['Harness'];

  expect(darkKw).toBeDefined();
  expect(darkStr).toBeDefined();
  expect(darkCom).toBeDefined();
  expect(darkVar).toBeDefined();

  // All 4 token colors must be pairwise distinct in dark mode
  const darkMjsSet = new Set([darkKw, darkStr, darkCom, darkVar]);
  expect(darkMjsSet.size, 'keyword, string, comment, and variable colors must all be pairwise distinct in dark mode').toBe(4);

  // Dark mode colors must also adapt (not be identical to light mode)
  expect(darkKw).not.toBe(lightKw);
  expect(darkStr).not.toBe(lightStr);
  expect(darkCom).not.toBe(lightCom);

  // Reset theme to light
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'white-light'));
  expectClean(state);
});

test('CodeMirror 6 acceptance: md preview/edit toggle, conflict flow, target line scrolling, zoom 0.9 click positioning, search panel', async ({ page }) => {
  const state = await openProto(page);
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

  // 1. Zoom 0.9 click positioning
  await page.getByTestId('next-right-toggle').click();
  await page.getByTestId('next-right-tab-files').click();
  await page.locator('[data-testid=next-file-node][data-path="web/src/data/store.ts"]').click();
  await expect(page.getByTestId('next-file-editor')).toBeVisible();

  const currentZoom = await page.evaluate(() => getComputedStyle(document.documentElement).zoom);
  expect(Number(currentZoom)).toBeCloseTo(0.9, 1);

  const line2 = page.locator('.cm-line').nth(1);
  await expect(line2).toBeVisible();
  const box = await line2.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.click(box.x + 30, box.y + box.height / 2);
    const selInfo = await page.evaluate(() => {
      const sel = window.getSelection();
      if (!sel || !sel.anchorNode) return null;
      const lineEl = sel.anchorNode.nodeType === 3
        ? sel.anchorNode.parentElement?.closest('.cm-line')
        : sel.anchorNode.closest?.('.cm-line');
      const allLines = Array.from(document.querySelectorAll('.cm-line'));
      return {
        lineIndex: allLines.indexOf(lineEl),
        offset: sel.anchorOffset,
      };
    });
    expect(selInfo).not.toBeNull();
    expect(selInfo?.lineIndex).toBe(1); // 0-based index 1 = line 2
  }

  // 2. Search panel opens with Cmd/Ctrl+F and closes with Escape
  await page.keyboard.press(`${modKey}+f`);
  const searchPanel = page.locator('.cm-panel.cm-search');
  await expect(searchPanel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(searchPanel).toHaveCount(0);

  // 3. Target line: open file with target line -> scrolls to line and highlights it
  const kernelLink = page.locator('[data-testid=next-item-assistant] a.md-path').filter({ hasText: '内核入口' });
  await kernelLink.click();
  await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);
  const targetLine = page.locator('.cm-target-line.file-line.is-target');
  await expect(targetLine).toBeVisible();
  await expect(targetLine).toHaveAttribute('data-line', '1');

  // 4. Markdown preview and edit toggle
  await page.getByTestId('next-right-tab-files').click();
  await page.locator('[data-testid=next-file-node][data-path="README.md"]').click();
  // Markdown defaults to preview
  await expect(page.locator('.md-editor-preview')).toBeVisible();
  await expect(page.getByTestId('next-file-open-editor')).toBeVisible();

  // Switch to edit
  await page.getByTestId('next-file-open-editor').click();
  await expect(page.locator('.md-editor-preview')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toBeVisible();

  // Switch back to preview
  await page.getByRole('button', { name: /预览|Preview/ }).click();
  await expect(page.locator('.md-editor-preview')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);

  // 5. Conflict bar on conflict
  await page.locator('[data-testid=next-file-node][data-path="demo/conflict.md"]').click();
  await page.waitForTimeout(1_600); // Wait for mock external editor touch
  await page.getByTestId('next-file-open-editor').click();
  await page.locator('.cm-content').fill('# conflict edit\n');
  await page.getByTestId('next-file-save').click();
  const conflictBar = page.getByTestId('next-file-conflict');
  await expect(conflictBar).toBeVisible();
  await expect(page.getByTestId('next-file-overwrite')).toBeVisible();
  await expect(page.getByTestId('next-file-reload')).toBeVisible();
  await page.getByTestId('next-file-reload').click();
  await expect(conflictBar).toHaveCount(0);

  expectClean(state);
});
