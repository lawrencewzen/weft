import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

test('clicking file:// and relative markdown file links opens the file in the right pane', async ({ page }) => {
  const state = await openProto(page);

  // 1. Locate the assistant message link with file:// scheme
  const kernelLink = page.locator('[data-testid=next-item-assistant] a.md-path').filter({ hasText: '内核入口' });
  await expect(kernelLink).toBeVisible();
  await expect(kernelLink).toHaveAttribute('data-path', 'src/kernel/index.mjs');
  await expect(kernelLink).toHaveAttribute('data-line', '1');
  await expect(kernelLink).not.toHaveAttribute('target', '_blank');

  // 2. Click the file:// link -> right pane switches to files tab, opens src/kernel/index.mjs at line 1
  await kernelLink.click();
  await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);
  await expect(page.locator('.file-preview-head')).toContainText('src/kernel/index.mjs');
  await expect(page.locator('.file-view-content .file-line.is-target')).toBeVisible();
  await expect(page.locator('.file-view-content .file-line.is-target')).toHaveAttribute('data-line', '1');

  // 3. Locate the relative path link
  const cssLink = page.locator('[data-testid=next-item-assistant] a.md-path').filter({ hasText: 'app.css' });
  await expect(cssLink).toBeVisible();
  await expect(cssLink).toHaveAttribute('data-path', 'web/src/styles/app.css');
  await expect(cssLink).not.toHaveAttribute('target', '_blank');

  // 4. Click the relative path link -> right pane opens web/src/styles/app.css
  await cssLink.click();
  await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);
  await expect(page.locator('.file-preview-head')).toContainText('web/src/styles/app.css');

  expectClean(state);
});
