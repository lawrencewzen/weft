import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * Right pane, part 2: structured diffs from seeded changes, the mock file tree,
 * Markdown preview/edit/save, the save-conflict demo, path chips and changes
 * produced by a simulated run.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('diff, file tree, preview, save and the 409 conflict demo', async ({ page }) => {
  const state = await openProto(page);

  // Seeded changes (main Agent and sub-agent), sorted by path.
  await expect(page.getByTestId('next-change-row')).toHaveCount(8);
  await expect(page.getByTestId('next-change-row').first()).toHaveAttribute(
    'data-path',
    '/Users/lawrence/.config/weft/notes.md',
  );

  const changesPaneRow = page.locator('[data-testid=next-change-row][data-path="web/src/components/ChangesPane.tsx"]');
  const diffViewRow = page.locator('[data-testid=next-change-row][data-path="web/src/data/diffView.ts"]');
  const testRow = page.locator('[data-testid=next-change-row][data-path="web/src/data/store.test.ts"]');
  const storeRow = page.locator('[data-testid=next-change-row][data-path="web/src/data/store.ts"]');

  // Attribution: main agent displays "主 Agent", subagent displays fixed "子 Agent" with title tooltip.
  await expect(changesPaneRow.getByTestId('next-change-by')).toHaveText('子 Agent');
  await expect(changesPaneRow.getByTestId('next-change-by')).toHaveAttribute('title', '核对 store.ts 的加载顺序');
  await expect(diffViewRow.getByTestId('next-change-by')).toHaveText('主 Agent');
  await expect(testRow.getByTestId('next-change-by')).toHaveText('子 Agent');
  await expect(testRow.getByTestId('next-change-by')).toHaveAttribute('title', '补 text.delta 偏移的用例');
  await expect(storeRow.getByTestId('next-change-by')).toHaveText('主 Agent');

  // Clicking subagent attribution focuses that subagent in the status strip without collapsing the file diff.
  await changesPaneRow.getByTestId('next-change-by').click();
  const strip = page.getByTestId('next-agents-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('data-open', 'true');
  await expect(changesPaneRow.getByTestId('next-diff')).toBeVisible();

  // Right tabs container is aligned to the left, with the collapse button placed at the right end.
  await expect(page.locator('.right-tabs-bar')).toHaveCSS('justify-content', 'flex-start');
  await expect.poll(async () => {
    const collapseBox = await page.getByTestId('next-right-collapse').boundingBox();
    const tabsNavBox = await page.locator('.tabs-nav').boundingBox();
    if (!collapseBox || !tabsNavBox) return false;
    return collapseBox.x >= tabsNavBox.x + tabsNavBox.width;
  }).toBe(true);

  // Changes default to expanded (<= 8 files, <= 300 lines) with diff lines visible.
  await expect(page.getByTestId('next-diff')).toHaveCount(8);
  await expect(page.getByTestId('next-diff-line').first()).toBeVisible();
  expect(await testRow.locator('[data-testid=next-diff-line][data-op=add]').count()).toBeGreaterThan(0);
  const added = testRow.locator('[data-testid=next-diff-line][data-op=add]').first();
  await expect(added.locator('.n.new')).toHaveText('42');
  await expect(added.locator('.code')).toContainText('createEntityStore');

  // store.ts has removals too.
  const storeDiff = storeRow.getByTestId('next-diff');
  await expect(storeDiff).toBeVisible();
  await expect.poll(async () => storeDiff.locator('[data-op=del]').count()).toBeGreaterThan(0);
  expect(await storeDiff.locator('[data-op=add]').count()).toBeGreaterThan(0);

  // File pill can be clicked to collapse and re-expand.
  await page.getByTestId('next-change-row').first().locator('.changed-file-pill').click();
  await expect(page.getByTestId('next-change-row').first().getByTestId('next-diff')).toHaveCount(0);
  await page.getByTestId('next-change-row').first().locator('.changed-file-pill').click();
  await expect(page.getByTestId('next-change-row').first().getByTestId('next-diff')).toBeVisible();

  // A fast answer must not make the diff effect re-request the same file.
  const diffRequests = (await state.requests())
    .filter((row) => decodeURIComponent(row.url).includes('/c-rich/diff'));
  const perPath = new Map();
  for (const row of diffRequests) {
    const path = decodeURIComponent(row.url.split('path=')[1] || '');
    perPath.set(path, (perPath.get(path) || 0) + 1);
  }
  expect([...perPath.values()].every((count) => count === 1)).toBe(true);

  // The thread change-summary opens the same file in the right pane without a new fetch.
  await page.getByTestId('next-change-summary-toggle').click();
  await expect(page.getByTestId('next-change-summary-row')).toHaveCount(5);
  await page.locator('[data-testid=next-change-summary-row][data-path="web/src/data/store.ts"]').click();
  await expect(
    page.locator('[data-testid=next-change-row][data-path="web/src/data/store.ts"]').getByTestId('next-diff'),
  ).toBeVisible();

  // File tab: the mock repository has a real tree.
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.getByTestId('next-file-node').first()).toBeVisible();
  expect(await page.getByTestId('next-file-node').count()).toBeGreaterThan(15);
  await expect(page.locator('[data-testid=next-file-node][data-path="web/src/data/store.ts"]')).toHaveCount(1);

  // T100-2: secret.log, dist, node_modules are marked is-ignored; package.json is not.
  const secretLogNode = page.locator('[data-testid=next-file-node][data-path="secret.log"]');
  const distNode = page.locator('[data-testid=next-file-node][data-path="dist"]');
  const nodeModulesNode = page.locator('[data-testid=next-file-node][data-path="node_modules"]');
  const packageJsonNode = page.locator('[data-testid=next-file-node][data-path="package.json"]');
  await expect(secretLogNode).toHaveClass(/is-ignored/);
  await expect(distNode).toHaveClass(/is-ignored/);
  await expect(nodeModulesNode).toHaveClass(/is-ignored/);
  await expect(packageJsonNode).not.toHaveClass(/is-ignored/);

  // Opening secret.log displays its content
  await secretLogNode.click();
  await expect(page.getByTestId('next-file-editor')).toContainText('local debug log');
  await expect(secretLogNode).toHaveClass(/active/);

  // Markdown files open in the editor tab with a preview.
  await page.locator('[data-testid=next-file-node][data-path="README.md"]').click();
  await expect(page.getByTestId('next-file-editor')).toContainText('常用命令');
  await page.getByTestId('next-file-open-editor').click();
  await page.locator('.cm-content').fill('# weft\n\n原型里改过的一行\n');
  await page.getByTestId('next-file-save').click();
  await expect(page.getByTestId('next-toast')).toContainText('已保存');
  const savedVersion = await page.evaluate(() => (window.__protoRequests || [])
    .filter((row) => row.method === 'PUT' && row.url.includes('/files')).length);
  expect(savedVersion).toBe(1);

  // The saved file shows up in the changes tab with a real line diff (collapsed by default when > 8 files).
  await page.getByTestId('next-right-tab-changes').click();
  const readmeChange = page.locator('[data-testid=next-change-row][data-path="README.md"]');
  await expect(readmeChange).toBeVisible();
  await expect(readmeChange.getByTestId('next-change-by')).toHaveCount(0);
  await expect(readmeChange).not.toHaveClass(/is-open/); // 9 个文件，默认收起
  await readmeChange.locator('.changed-file-pill').click();
  await expect(readmeChange).toHaveClass(/is-open/);
  await expect(readmeChange.getByTestId('next-diff-line').first()).toBeVisible();
  await expect.poll(async () => readmeChange.locator('[data-op=add]').count()).toBeGreaterThan(0);
  await page.getByTestId('next-right-tab-files').click();

  // demo/conflict.md is changed by "another editor" right after it is opened.
  await page.locator('[data-testid=next-file-node][data-path="demo/conflict.md"]').click();
  await expect(page.getByTestId('next-file-editor')).toContainText('保存冲突演示');
  await page.waitForTimeout(1_600);
  await page.getByTestId('next-file-open-editor').click();
  await page.locator('.cm-content').fill('# 冲突演示\n\n我加了一行\n');
  await page.getByTestId('next-file-save').click();
  await expect(page.getByTestId('next-file-conflict')).toBeVisible();
  const conflict = await page.evaluate(() => (window.__protoRequests || [])
    .some((row) => row.method === 'PUT' && row.url.includes('/files')));
  expect(conflict).toBe(true);
  await page.getByTestId('next-file-reload').click();
  await expect(page.getByTestId('next-file-conflict')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('外部修改');

  // Clicking an edit tool row jumps to that file's diff in the changes tab.
  await page.getByTestId('next-tool-group-summary').nth(1).click();
  await page.locator('[data-testid=next-tool-row][data-tool="edit"]').first().click();
  await expect(page.getByTestId('next-right-tab-changes')).toHaveClass(/active/);
  await expect(page.locator('[data-testid=next-change-row][data-path="web/src/data/store.ts"]')).toHaveClass(/is-open/);

  // A path chip in an assistant message opens the file at the referenced line.
  await page.locator('[data-testid=next-item-assistant] .md-path').first().click();
  await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);
  await expect(page.locator('.file-view-content .file-line.is-target')).toBeVisible();

  expectClean(state);
});

test('a simulated edit lands in the changes list with its diff', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-new-chat').click();
  await page.getByTestId('next-composer-input').fill('改一下 web/src/data/store.ts 里的 items 顺序');
  await page.getByTestId('next-send').click();
  await expect(page.getByTestId('next-stop')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('next-send')).toBeVisible();

  await expect(page.getByTestId('next-change-row')).toHaveCount(1);
  await expect(page.getByTestId('next-change-row').first()).toHaveAttribute('data-path', 'web/src/data/store.ts');
  await expect(page.getByTestId('next-change-row').first().getByTestId('next-change-by')).toHaveText('主 Agent');
  // Edit change defaults to expanded
  await expect(page.getByTestId('next-diff-line').first()).toBeVisible();
  expect(await page.locator('[data-testid=next-diff-line][data-op=add]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-testid=next-diff-line][data-op=del]').count()).toBeGreaterThan(0);

  // The same file is now marked as modified in the file tree.
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.locator('[data-testid=next-file-node][data-path="web/src/data/store.ts"]')).toContainText('M');

  expectClean(state);
});

test('diff long line wraps in default narrow pane and unwraps when widened', async ({ page }) => {
  const state = await openProto(page);

  const testRow = page.locator('[data-testid=next-change-row][data-path="web/src/data/store.test.ts"]');
  await expect(testRow).toBeVisible();
  const diffLines = testRow.locator('.diff-lines');
  await expect(diffLines).toBeVisible();

  // 1. In default narrow pane: .diff-lines scrollWidth <= clientWidth
  const scrollInfo = await diffLines.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollInfo.scrollWidth).toBeLessThanOrEqual(scrollInfo.clientWidth);

  // Short single-line vs long line in store.test.ts
  const shortLine = testRow.locator('[data-testid=next-diff-line]').filter({ hasText: 'const store = createEntityStore()' }).first();
  const longLine = testRow.locator('[data-testid=next-diff-line]').filter({ hasText: 'textDelta(store' }).first();
  await expect(shortLine).toBeVisible();
  await expect(longLine).toBeVisible();

  // user-select: none on line number and sign
  await expect(longLine.locator('.n.new')).toHaveCSS('user-select', 'none');
  await expect(longLine.locator('.sign')).toHaveCSS('user-select', 'none');
  await expect(longLine.locator('.code')).toHaveCSS('white-space', 'pre-wrap');
  await expect(longLine.locator('.code')).toHaveCSS('overflow-wrap', 'anywhere');

  const shortBox = await shortLine.boundingBox();
  const longBox = await longLine.boundingBox();
  expect(shortBox).not.toBeNull();
  expect(longBox).not.toBeNull();

  // 2. Long line height > single line height
  expect(longBox.height).toBeGreaterThan(shortBox.height);

  // 3. Line background width equals pane width
  const linesBox = await diffLines.boundingBox();
  expect(linesBox).not.toBeNull();
  expect(Math.abs(longBox.width - linesBox.width)).toBeLessThanOrEqual(1);

  // 4. Line number x coordinate matches other lines
  const shortNumBox = await shortLine.locator('.n.new').boundingBox();
  const longNumBox = await longLine.locator('.n.new').boundingBox();
  expect(shortNumBox).not.toBeNull();
  expect(longNumBox).not.toBeNull();
  expect(Math.abs(longNumBox.x - shortNumBox.x)).toBeLessThanOrEqual(1);

  const shortSignBox = await shortLine.locator('.sign').boundingBox();
  const longSignBox = await longLine.locator('.sign').boundingBox();
  expect(shortSignBox).not.toBeNull();
  expect(longSignBox).not.toBeNull();
  expect(Math.abs(longSignBox.x - shortSignBox.x)).toBeLessThanOrEqual(1);

  // Drag divider to widen the right pane beyond long line length
  const divider = page.locator('.col-divider[data-side="right"]');
  await expect(divider).toBeVisible();
  const divBox = await divider.boundingBox();
  expect(divBox).not.toBeNull();

  // Drag divider to the left to widen the right pane
  await page.mouse.move(divBox.x - 2, divBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(divBox.x - 2 - 350, divBox.y + 100, { steps: 10 });
  await page.mouse.up();

  // When widened, the long line does not wrap, height equals single line height
  await expect.poll(async () => {
    const widenedLongBox = await longLine.boundingBox();
    const widenedShortBox = await shortLine.boundingBox();
    if (!widenedLongBox || !widenedShortBox) return null;
    return Math.abs(widenedLongBox.height - widenedShortBox.height);
  }).toBeLessThanOrEqual(1);

  // Verify selecting across lines does not copy line numbers or +/- signs
  const selectedText = await testRow.locator('.diff-lines').evaluate((el) => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.addRange(range);
    return sel?.toString() || '';
  });
  expect(selectedText).toContain('const store = createEntityStore();');
  expect(selectedText).not.toMatch(/^\s*\d+/m);
  expect(selectedText).not.toMatch(/^\s*[+−]/m);

  expectClean(state);
});
