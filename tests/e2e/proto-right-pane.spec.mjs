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

  // Two seeded changes, sorted by path.
  await expect(page.getByTestId('next-change-row')).toHaveCount(2);
  await expect(page.getByTestId('next-change-row').first()).toHaveAttribute(
    'data-path',
    'web/src/data/store.test.ts',
  );

  // A change opens as a structured diff with line numbers.
  await page.getByTestId('next-change-row').first().locator('.changed-file-pill').click();
  await expect(page.getByTestId('next-diff')).toBeVisible();
  await expect(page.getByTestId('next-diff-line').first()).toBeVisible();
  expect(await page.locator('[data-testid=next-diff-line][data-op=add]').count()).toBeGreaterThan(0);
  const added = page.locator('[data-testid=next-diff-line][data-op=add]').first();
  await expect(added.locator('.n.new')).toHaveText('42');
  await expect(added.locator('.code')).toContainText('createEntityStore');

  // The second change has removals too.
  await page.getByTestId('next-change-row').nth(1).locator('.changed-file-pill').click();
  const storeDiff = page.getByTestId('next-change-row').nth(1).getByTestId('next-diff');
  await expect(storeDiff).toBeVisible();
  await expect.poll(async () => storeDiff.locator('[data-op=del]').count()).toBeGreaterThan(0);
  expect(await storeDiff.locator('[data-op=add]').count()).toBeGreaterThan(0);

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
  await expect(page.getByTestId('next-change-summary-row')).toHaveCount(2);
  await page.locator('[data-testid=next-change-summary-row][data-path="web/src/data/store.ts"]').click();
  await expect(
    page.locator('[data-testid=next-change-row][data-path="web/src/data/store.ts"]').getByTestId('next-diff'),
  ).toBeVisible();

  // File tab: the mock repository has a real tree.
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.getByTestId('next-file-node').first()).toBeVisible();
  expect(await page.getByTestId('next-file-node').count()).toBeGreaterThan(15);
  await expect(page.locator('[data-testid=next-file-node][data-path="web/src/data/store.ts"]')).toHaveCount(1);

  // Markdown files open in the editor tab with a preview.
  await page.locator('[data-testid=next-file-node][data-path="README.md"]').click();
  await expect(page.getByTestId('next-file-editor')).toContainText('常用命令');
  await page.getByTestId('next-file-open-editor').click();
  await page.locator('.md-editor-content').fill('# weft\n\n原型里改过的一行\n');
  await page.getByTestId('next-file-save').click();
  await expect(page.getByTestId('next-toast')).toContainText('已保存');
  const savedVersion = await page.evaluate(() => (window.__protoRequests || [])
    .filter((row) => row.method === 'PUT' && row.url.includes('/files')).length);
  expect(savedVersion).toBe(1);

  // The saved file shows up in the changes tab with a real line diff.
  await page.getByTestId('next-right-tab-changes').click();
  const readmeChange = page.locator('[data-testid=next-change-row][data-path="README.md"]');
  await expect(readmeChange).toBeVisible();
  await readmeChange.locator('.changed-file-pill').click();
  await expect(readmeChange.getByTestId('next-diff-line').first()).toBeVisible();
  await expect.poll(async () => readmeChange.locator('[data-op=add]').count()).toBeGreaterThan(0);
  await page.getByTestId('next-right-tab-files').click();

  // demo/conflict.md is changed by "another editor" right after it is opened.
  await page.locator('[data-testid=next-file-node][data-path="demo/conflict.md"]').click();
  await expect(page.getByTestId('next-file-editor')).toContainText('保存冲突演示');
  await page.waitForTimeout(1_600);
  await page.getByTestId('next-file-open-editor').click();
  await page.locator('.md-editor-content').fill('# 冲突演示\n\n我加了一行\n');
  await page.getByTestId('next-file-save').click();
  await expect(page.getByTestId('next-file-conflict')).toBeVisible();
  const conflict = await page.evaluate(() => (window.__protoRequests || [])
    .some((row) => row.method === 'PUT' && row.url.includes('/files')));
  expect(conflict).toBe(true);
  await page.getByTestId('next-file-reload').click();
  await expect(page.getByTestId('next-file-conflict')).toHaveCount(0);
  await expect(page.locator('.md-editor-content')).toContainText('外部修改');

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
  await page.getByTestId('next-change-row').first().locator('.changed-file-pill').click();
  await expect(page.getByTestId('next-diff-line').first()).toBeVisible();
  expect(await page.locator('[data-testid=next-diff-line][data-op=add]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-testid=next-diff-line][data-op=del]').count()).toBeGreaterThan(0);

  // The same file is now marked as modified in the file tree.
  await page.getByTestId('next-right-tab-files').click();
  await expect(page.locator('[data-testid=next-file-node][data-path="web/src/data/store.ts"]')).toContainText('M');

  expectClean(state);
});
