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

test('1. c-handoff displays divider line with short title and expandable detail', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-handoff');

  // Verify handoff divider line is rendered
  const note = page.getByTestId('next-item-system-note').filter({ has: page.getByTestId('next-handoff-divider') });
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-kind', 'handoff');

  const divider = note.getByTestId('next-handoff-divider');
  await expect(divider).toBeVisible();
  await expect(divider.getByTestId('next-handoff-title')).toHaveText('新上下文');

  // Verify previous items are displayed normally and not faded/dimmed
  await expect(page.getByTestId('next-item-user')).toHaveCount(1);
  await expect(page.getByTestId('next-item-assistant')).toHaveCount(4);

  // Verify handoff tool row in tool group shows "交接到新上下文" and no technical name
  const handoffTool = page.locator('[data-testid=next-tool-row][data-tool="handoff"]');
  await expect(handoffTool).toHaveCount(1);
  await expect(handoffTool).toContainText('交接到新上下文');
  await expect(handoffTool).not.toContainText('handoff');

  // Context usage reflects lower percentage after handoff
  await expect(page.getByTestId('next-context-chip')).toHaveAttribute('title', /已用 14%/);

  // Toggle detail expansion
  const toggle = note.getByTestId('next-handoff-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText('交接说明');
  await expect(note.getByTestId('next-handoff-detail')).toHaveCount(0);

  await toggle.click();
  const detail = note.getByTestId('next-handoff-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('迁移进度交接');
  await expect(detail).toContainText('packages/core');

  // Toggle collapse
  await toggle.click();
  await expect(note.getByTestId('next-handoff-detail')).toHaveCount(0);

  await expectClean(state);
});

test('2. click handoff in context panel: shows spinner, pending text, then new divider and reduced context percent', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  await expect(page.getByTestId('next-context-chip')).toHaveText('86%');

  const initialNotes = await page.getByTestId('next-handoff-divider').count();
  expect(initialNotes).toBe(0);

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

  // Context percentage decreased
  await expect(page.getByTestId('next-context-chip')).toHaveAttribute('title', /已用 14%/);
  await expect(page.getByTestId('next-context-chip').locator('.context-chip-pct')).toHaveCount(0);
  await expect(row).toBeEnabled();

  // Expanding the newly created handoff detail works
  const toggle = newNote.getByTestId('next-handoff-toggle');
  await toggle.click();
  await expect(newNote.getByTestId('next-handoff-detail')).toBeVisible();
  await expect(newNote.getByTestId('next-handoff-detail')).toContainText('交接说明');

  const calls = (await state.requests()).filter((r) => r.method === 'POST' && /\/handoff$/.test(r.url));
  expect(calls).toHaveLength(1);

  await expectClean(state);
});

test('3. draft conversation disables handoff in context pop', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-nav-new-chat').click();
  await openMenu(page);
  const row = page.getByTestId('next-menu-handoff');
  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute('data-state', 'unavailable');
  await expectClean(state);
});

test('4. English labels for handoff', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-pref-lang').locator('[data-lang=en]').click();
  await page.keyboard.press('Escape');

  await openConv(page, 'c-handoff');
  const divider = page.getByTestId('next-handoff-divider');
  await expect(divider.getByTestId('next-handoff-title')).toHaveText('New context');
  await expect(divider.getByTestId('next-handoff-toggle')).toContainText('Handoff notes');

  await openMenu(page);
  await expect(page.getByTestId('next-menu-handoff')).toHaveText('Handoff to new context');
  await expectClean(state);
});
