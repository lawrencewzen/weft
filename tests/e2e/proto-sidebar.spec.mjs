import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('sidebar settings row uses the rounded gear icon (viewBox 24)', async ({ page }) => {
  const state = await openProto(page);

  const settings = page.getByTestId('next-open-settings');
  await expect(settings).toBeVisible();
  await expect(settings.locator('svg')).toHaveAttribute('viewBox', '0 0 24 24');

  expectClean(state);
});

test('sidebar top actions: new chat row, search row, shortcuts, and zero subagents', async ({ page }) => {
  const state = await openProto(page);

  const sidebar = page.getByTestId('next-sidebar');
  await expect(sidebar).toBeVisible();

  // Top action: new chat row
  const newChatRow = page.getByTestId('next-new-chat');
  await expect(newChatRow).toBeVisible();
  await expect(newChatRow).toContainText('新对话');
  await expect(newChatRow.locator('.sb-kbd')).toHaveText(/⌘N|Ctrl\+N/);

  // Top action: search row
  const searchRow = page.getByTestId('next-search');
  await expect(searchRow).toBeVisible();
  await expect(searchRow).toContainText('搜索');
  await expect(searchRow.locator('.sb-kbd')).toHaveText(/⌘K|Ctrl\+K/);

  // Sidebar completely omits subagents
  await expect(sidebar.getByTestId('next-subagent-chip')).toHaveCount(0);
  await expect(sidebar.getByTestId('next-subagent-tree')).toHaveCount(0);
  await expect(sidebar.getByTestId('next-subagent-row')).toHaveCount(0);

  expectClean(state);
});

test('⌘K search modal filters all conversations across projects, navigates with arrows, and Enter opens selection', async ({ page }) => {
  const state = await openProto(page);

  // Open search modal via search row click
  await page.getByTestId('next-search').click();
  const modal = page.getByTestId('next-search-modal');
  await expect(modal).toBeVisible();

  // Search input is focused
  const input = page.getByTestId('next-search-input');
  await expect(input).toBeFocused();

  // Right pane tab is covered by the palette overlay (cannot be clicked)
  const changesTab = page.getByTestId('next-right-tab-changes');
  await expect(changesTab).toBeVisible();
  const tabBox = await changesTab.boundingBox();
  expect(tabBox).not.toBeNull();
  const topElement = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el ? {
      className: el.className,
      isOverlay: !!el.closest('.search-palette-overlay'),
    } : null;
  }, { x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 });
  expect(topElement?.isOverlay).toBe(true);

  // Palette position and dimensions: ~14vh top, 600px CSS × --ui-zoom 0.9 → ~540 visual
  const palette = modal.locator('.search-palette');
  const paletteBox = await palette.boundingBox();
  expect(paletteBox).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const expectedTop = viewport.height * 0.14;
  expect(Math.abs(paletteBox.y - expectedTop)).toBeLessThan(15);
  expect(Math.abs(paletteBox.width - 540)).toBeLessThan(15);

  // Empty query shows "最近" label
  await expect(modal.locator('.search-palette-label')).toHaveText('最近');

  // Initially lists all conversations from active workspaces
  const allResults = modal.getByTestId('next-search-result');
  expect(await allResults.count()).toBeGreaterThan(3);

  // Filter conversations
  await input.fill('架构');
  await expect(modal.getByTestId('next-search-result')).toHaveCount(1);
  await expect(modal.locator('.search-palette-label')).toHaveCount(0);
  const result = modal.getByTestId('next-search-result').first();
  await expect(result.locator('.search-result-title')).toContainText('把架构文档的图补上');
  await expect(result.locator('.search-result-project')).toContainText('weft');

  // Clear query and test arrow key navigation
  await input.fill('');
  await expect(modal.locator('.search-palette-label')).toHaveText('最近');
  await expect(allResults.nth(0)).toHaveClass(/is-selected/);
  await input.press('ArrowDown');
  await expect(allResults.nth(1)).toHaveClass(/is-selected/);
  await input.press('ArrowUp');
  await expect(allResults.nth(0)).toHaveClass(/is-selected/);

  // Filter for docs conversation and press Enter to navigate
  await input.fill('把架构文档');
  await expect(modal.getByTestId('next-search-result')).toHaveCount(1);
  await input.press('Enter');

  // Modal closes and navigates to the selected conversation
  await expect(modal).toHaveCount(0);
  await expect(page).toHaveURL(/#\/c\/c-docs$/);
  await expect(page.locator('[data-testid=next-conv-row][data-id="c-docs"]')).toHaveClass(/conv-active/);

  // Open via keyboard shortcut and close via Escape
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);

  // Open via keyboard shortcut and close via clicking backdrop overlay
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(modal).toBeVisible();
  await page.locator('.search-palette-overlay').click({ position: { x: 20, y: 20 } });
  await expect(modal).toHaveCount(0);

  expectClean(state);
});

test('workspace project row collapse and expand toggles folder icon and conversations list', async ({ page }) => {
  const state = await openProto(page);

  const wsNode = page.getByTestId('next-ws-node').first();
  await expect(wsNode).toBeVisible();

  const toggle = wsNode.getByTestId('next-ws-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Children are initially visible
  const convList = wsNode.locator('.sb-conv-list');
  await expect(convList).toBeVisible();

  // Collapse workspace
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(convList).toBeHidden();

  // Expand workspace again
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(convList).toBeVisible();

  // Hovering workspace shows plus button and more button
  await toggle.hover();
  await expect(wsNode.getByTestId('next-ws-add')).toBeVisible();
  await expect(wsNode.locator('.ws-node-more')).toBeVisible();

  expectClean(state);
});

test('conversation row status icons, hover more menu, and context menu', async ({ page }) => {
  const state = await openProto(page);

  // Conversation with running status (c-rich)
  const richRow = page.locator('[data-testid=next-conv-row][data-id="c-rich"]');
  await expect(richRow).toBeVisible();
  await expect(richRow).toHaveAttribute('data-status', 'running');
  await expect(richRow.locator('.conv-status-slot [data-status="running"]')).toBeVisible();

  // Idle conversation has no status icon
  const gitRow = page.locator('[data-testid=next-conv-row][data-id="c-git"]');
  await expect(gitRow).toBeVisible();
  await expect(gitRow).toHaveAttribute('data-status', 'idle');
  await expect(gitRow.locator('.conv-status-slot [data-status]')).toHaveCount(0);

  // Hover reveals more button
  await richRow.hover();
  const moreBtn = richRow.getByTestId('next-conv-more');
  await expect(moreBtn).toBeVisible();

  // Clicking more button opens context menu
  await moreBtn.click();
  const ctxMenu = page.getByTestId('next-ctx-menu');
  await expect(ctxMenu).toBeVisible();

  // Click outside to dismiss context menu
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(ctxMenu).toHaveCount(0);

  expectClean(state);
});

test('unread conversation has bold styling and clears upon opening', async ({ page }) => {
  const state = await openProto(page);

  // c-docs was seeded with updatedAt > lastOpened
  const docsRow = page.locator('[data-testid=next-conv-row][data-id="c-docs"]');
  await expect(docsRow).toBeVisible();
  await expect(docsRow).toHaveClass(/unread/);

  // Unread title has bold font weight
  const titleEl = docsRow.locator('.sb-conv-title');
  const fontWeight = await titleEl.evaluate((el) => getComputedStyle(el).fontWeight);
  expect(Number.parseInt(fontWeight, 10)).toBeGreaterThanOrEqual(600);

  // Opening the conversation marks it as read and clears bold styling
  await docsRow.click();
  await expect(page).toHaveURL(/#\/c\/c-docs$/);
  await expect(docsRow).not.toHaveClass(/unread/);

  expectClean(state);
});

test('right pane changes tab has no oversized svg icons (regression guard against unstyled chevrons)', async ({ page }) => {
  const state = await openProto(page);

  // Open c-rich conversation
  const richRow = page.locator('[data-testid=next-conv-row][data-id="c-rich"]');
  await expect(richRow).toBeVisible();
  await richRow.click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);

  // Ensure right pane changes tab is active
  const changesTab = page.getByTestId('next-right-tab-changes');
  await expect(changesTab).toBeVisible();
  await changesTab.click();

  // Wait for change rows to render
  const changeRows = page.getByTestId('next-change-row');
  await expect(changeRows.first()).toBeVisible();

  // Assert no SVG icon on the page has width or height exceeding 40px
  const oversizedSvgs = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('svg'));
    return svgs
      .map((svg) => {
        const rect = svg.getBoundingClientRect();
        return {
          className: svg.getAttribute('class') || '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          parent: svg.parentElement?.className || '',
        };
      })
      .filter((item) => item.width > 40 || item.height > 40);
  });

  expect(oversizedSvgs).toEqual([]);

  // Specifically verify the chevron icon in the changed-file-pill has layout width 12px
  const firstChev = changeRows.first().locator('.changed-file-pill svg.ws-chev');
  await expect(firstChev).toBeVisible();
  const chevWidth = await firstChev.evaluate((el) => Number.parseFloat(getComputedStyle(el).width));
  const chevHeight = await firstChev.evaluate((el) => Number.parseFloat(getComputedStyle(el).height));
  expect(chevWidth).toBe(12);
  expect(chevHeight).toBe(12);

  expectClean(state);
});
