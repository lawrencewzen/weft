import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

async function openConv(page, id) {
  await page.locator(`[data-testid=next-conv-row][data-id="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/c/${id}$`));
}

async function openMenu(page) {
  await page.getByTestId('next-context-chip').click();
  await expect(page.getByTestId('next-context-pop')).toBeVisible();
}

test('1. c-handoff defaults to collapsed earlier context; click expands and collapses; divider and notes work', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-handoff');

  // Verify earlier context toggle is visible by default with item count
  const toggleEarlier = page.getByTestId('next-thread-earlier-toggle');
  await expect(toggleEarlier).toBeVisible();
  await expect(toggleEarlier).toContainText('之前的上下文 · 5 条');
  await expect(toggleEarlier).toHaveAttribute('aria-expanded', 'false');

  // Verify earlier items (before last handoff) are hidden when collapsed
  await expect(page.getByTestId('next-item-user')).toHaveCount(0);
  await expect(page.getByTestId('next-item-assistant')).toHaveCount(2);

  // Verify handoff divider line is rendered
  const note = page.getByTestId('next-item-system-note').filter({ has: page.getByTestId('next-handoff-divider') });
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-kind', 'handoff');

  const divider = note.getByTestId('next-handoff-divider');
  await expect(divider).toBeVisible();
  await expect(divider.getByTestId('next-handoff-title')).toHaveText('新上下文');

  // Context usage reflects lower percentage after handoff
  await expect(page.getByTestId('next-context-chip')).toHaveAttribute('title', /已用 14%/);

  // Expand earlier context
  await toggleEarlier.click();
  await expect(toggleEarlier).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('next-item-user')).toHaveCount(1);
  await expect(page.getByTestId('next-item-assistant')).toHaveCount(4);

  // Verify handoff tool row in earlier tool group shows "交接到新上下文" and no technical name
  const handoffTool = page.locator('[data-testid=next-tool-row][data-tool="handoff"]');
  await expect(handoffTool).toHaveCount(1);
  await expect(handoffTool).toContainText('交接到新上下文');
  await expect(handoffTool).not.toContainText('handoff');

  // Collapse earlier context again
  await toggleEarlier.click();
  await expect(toggleEarlier).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('next-item-user')).toHaveCount(0);
  await expect(page.getByTestId('next-item-assistant')).toHaveCount(2);

  // Toggle handoff detail expansion
  const toggleDetail = note.getByTestId('next-handoff-toggle');
  await expect(toggleDetail).toBeVisible();
  await expect(toggleDetail).toContainText('交接说明');
  await expect(note.getByTestId('next-handoff-detail')).toHaveCount(0);

  await toggleDetail.click();
  const detail = note.getByTestId('next-handoff-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('迁移进度交接');
  await expect(detail).toContainText('packages/core');

  // Toggle collapse detail
  await toggleDetail.click();
  await expect(note.getByTestId('next-handoff-detail')).toHaveCount(0);

  await expectClean(state);
});

test('2. click handoff in context panel: shows spinner, pending text, lands divider, and folds earlier items', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  await expect(page.getByTestId('next-context-chip')).toHaveText('86%');

  const initialNotes = await page.getByTestId('next-handoff-divider').count();
  expect(initialNotes).toBe(0);
  await expect(page.getByTestId('next-thread-earlier-toggle')).toHaveCount(0);

  await openMenu(page);
  const row = page.getByTestId('next-menu-handoff');
  await expect(row).toHaveText('交接到新上下文');
  await expect(row).toBeEnabled();
  await row.click();

  // Button becomes disabled with running spinner
  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('next-handoff-spin')).toBeVisible();

  // Thread pending displays waiting text
  await expect(page.getByTestId('next-thread-pending')).toContainText('正在交接到新上下文');

  // Wait for run to finish
  await expect(page.getByTestId('next-thread-pending')).toHaveCount(0, { timeout: 10_000 });

  // New divider line appeared
  const newNote = page.getByTestId('next-item-system-note').filter({ has: page.getByTestId('next-handoff-divider') });
  await expect(newNote).toHaveCount(1);
  await expect(newNote.getByTestId('next-handoff-title')).toHaveText('新上下文');

  // Items before handoff are now folded into earlier context toggle
  const earlierToggle = page.getByTestId('next-thread-earlier-toggle');
  await expect(earlierToggle).toBeVisible();
  await expect(earlierToggle).toHaveAttribute('aria-expanded', 'false');

  // Context percentage decreased
  await expect(page.getByTestId('next-context-chip')).toHaveAttribute('title', /已用 14%/);
  await expect(page.getByTestId('next-context-chip').locator('.context-chip-pct')).toHaveCount(0);
  await expect(row).toBeEnabled();

  // Expanding the newly created handoff detail works
  const toggle = newNote.getByTestId('next-handoff-toggle');
  await toggle.click();
  await expect(newNote.getByTestId('next-handoff-detail')).toBeVisible();
  await expect(newNote.getByTestId('next-handoff-detail')).toContainText('迁移进度交接');

  const calls = (await state.requests()).filter((r) => r.method === 'POST' && /\/handoff$/.test(r.url));
  expect(calls).toHaveLength(1);

  await expectClean(state);
});

test('3. multiple handoffs only produce a single earlier-context toggle, and window.__protoHandoff supports instructions', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-handoff');

  // Initially 1 handoff in c-handoff
  await expect(page.getByTestId('next-handoff-divider')).toHaveCount(1);
  await expect(page.getByTestId('next-thread-earlier-toggle')).toHaveCount(1);

  // Trigger a second handoff with instructions via window.__protoHandoff
  const focusText = '重点关注 packages/server 的配置';
  await page.evaluate((text) => window.__protoHandoff(text), focusText);

  // Wait for run to complete
  await expect(page.getByTestId('next-thread-pending')).toContainText('正在交接到新上下文');
  await expect(page.getByTestId('next-thread-pending')).toHaveCount(0, { timeout: 10_000 });

  // Now there are 2 handoffs: the first one is folded into the earlier context,
  // so only the latest divider shows and there is still ONLY ONE toggle row
  await expect(page.getByTestId('next-handoff-divider')).toHaveCount(1);
  const earlierToggle = page.getByTestId('next-thread-earlier-toggle');
  await expect(earlierToggle).toHaveCount(1);

  // The latest handoff's notes contain the instructions
  const notes = page.getByTestId('next-item-system-note').filter({ has: page.getByTestId('next-handoff-divider') });
  const secondNote = notes.last();
  const toggleSecond = secondNote.getByTestId('next-handoff-toggle');
  await toggleSecond.click();

  const secondDetail = secondNote.getByTestId('next-handoff-detail');
  await expect(secondDetail).toBeVisible();
  await expect(secondDetail).toContainText('交接重点');
  await expect(secondDetail).toContainText(focusText);

  // Expanding the earlier context shows all earlier items (including the first handoff)
  await earlierToggle.click();
  await expect(earlierToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('next-handoff-divider')).toHaveCount(2);
  await expect(notes.first()).toBeVisible();

  await expectClean(state);
});

test('4. draft conversation disables handoff in context pop', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await openMenu(page);
  const row = page.getByTestId('next-menu-handoff');
  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute('data-state', 'unavailable');
  await expectClean(state);
});

test('5. English labels for handoff divider, toggle, earlier context, and menu', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-pref-lang').locator('[data-lang=en]').click();
  await page.keyboard.press('Escape');

  await openConv(page, 'c-handoff');
  const earlierToggle = page.getByTestId('next-thread-earlier-toggle');
  await expect(earlierToggle).toBeVisible();
  await expect(earlierToggle).toContainText('Previous context · 5 items');

  const divider = page.getByTestId('next-handoff-divider');
  await expect(divider.getByTestId('next-handoff-title')).toHaveText('New context');
  await expect(divider.getByTestId('next-handoff-toggle')).toContainText('Handoff notes');

  await openMenu(page);
  await expect(page.getByTestId('next-menu-handoff')).toHaveText('Handoff to new context');
  await expectClean(state);
});
