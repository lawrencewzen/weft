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

test('1. c-compacted shows the "context compacted" divider with an expandable summary; earlier items are not folded', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-compacted');

  const note = page.getByTestId('next-item-system-note');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-kind', 'compaction');
  const divider = note.getByTestId('next-compaction-divider');
  await expect(divider).toBeVisible();
  await expect(divider.getByTestId('next-compaction-title')).toHaveText('上下文已压缩');
  await expect(divider.getByTestId('next-compaction-meta')).toHaveText('之前 2 条已摘要');
  await expect(divider.locator('svg.handoff-divider-icon')).toBeVisible();

  // Unlike a handoff, nothing before the divider is folded: the model still sees the summary.
  await expect(page.getByTestId('next-thread-earlier-toggle')).toHaveCount(0);
  await expect(page.getByTestId('next-item-user')).toHaveCount(2);
  await expect(page.getByTestId('next-item-user').filter({ hasText: '已压缩' })).toHaveCount(0);
  await expect(page.getByTestId('next-context-banner')).toHaveCount(0);
  await expect(page.getByTestId('next-context-chip')).toBeVisible();

  const toggle = note.getByTestId('next-compaction-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(note.getByTestId('next-compaction-detail')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const detail = note.getByTestId('next-compaction-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('对话摘要');
  await expect(detail).toContainText('subscribe.ts');
  await toggle.click();
  await expect(note.getByTestId('next-compaction-detail')).toHaveCount(0);
  await expectClean(state);
});

test('2. panel compact: running state with spinner and thread line, then the note lands', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  await expect(page.getByTestId('next-context-chip')).toHaveText('86%');
  await expect(page.getByTestId('next-item-system-note')).toHaveCount(0);

  await openMenu(page);
  const row = page.getByTestId('next-menu-compact');
  await expect(row).toHaveText('立即压缩');
  await expect(row).toBeEnabled();
  await row.click();

  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('next-compact-spin')).toBeVisible();
  const pending = page.getByTestId('next-thread-compacting');
  await expect(pending).toHaveText('压缩中…');
  await expect(pending.locator('.run-spin')).toBeVisible();
  await expect(page.getByTestId('next-item-system-note')).toHaveCount(0);
  const before = await pending.boundingBox();
  const beforeBar = await pending.locator('.handoff-divider-bar').boundingBox();

  await expect(pending).toHaveCount(0, { timeout: 10_000 });
  const note = page.getByTestId('next-item-system-note');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-kind', 'compaction');
  await expect(note.getByTestId('next-compaction-title')).toHaveText('上下文已压缩');
  await expect(note.getByTestId('next-compaction-meta')).toHaveText(/^之前 \d+ 条已摘要$/);
  // It lands in place: same slot, same height, no jump.
  const after = await note.boundingBox();
  const afterBar = await note.getByTestId('next-compaction-divider').boundingBox();
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(afterBar.height - beforeBar.height)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('next-compaction-error')).toHaveCount(0);
  await expect(page.getByTestId('next-context-chip')).toHaveAttribute('title', /已用 12%/);
  await expect(page.getByTestId('next-context-chip').locator('.context-chip-pct')).toHaveCount(0);
  await expect(row).toBeEnabled();
  await note.getByTestId('next-compaction-toggle').click();
  await expect(note.getByTestId('next-compaction-detail')).toContainText('对话摘要');

  const calls = (await state.requests()).filter((r) => r.method === 'POST' && /\/compact$/.test(r.url));
  expect(calls).toHaveLength(1);
  await expectClean(state);
});

test('3. compact is clickable while the conversation is running', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-rich');
  await openMenu(page);
  const row = page.getByTestId('next-menu-compact');
  await expect(row).toBeEnabled();
  await row.click();
  await expect(row).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('next-thread-compacting')).toBeVisible();
  await expectClean(state);
});

test('4. c-compact-failed shows the error at the end of the thread, no continue; retry fails the same way', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-compact-failed');

  const err = page.getByTestId('next-compaction-error');
  await expect(err).toBeVisible();
  await expect(err).toHaveText('压缩失败：模型请求超时');
  await expect(err).toHaveClass(/llm-error/);
  await expect(err.getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('next-run-continue')).toHaveCount(0);
  // last child of the thread flow
  const lastIsError = await err.evaluate((el) => el.parentElement?.lastElementChild === el);
  expect(lastIsError).toBe(true);

  await openMenu(page);
  const row = page.getByTestId('next-menu-compact');
  await expect(row).toHaveAttribute('data-state', 'failed');
  await expect(row).toContainText('压缩失败：模型请求超时');
  await row.click();
  await expect(row).toBeDisabled();
  await expect(page.getByTestId('next-compaction-error')).toHaveCount(0);
  await expect(page.getByTestId('next-thread-compacting')).toBeVisible();
  await expect(page.getByTestId('next-compaction-error')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('next-item-system-note')).toHaveCount(0);
  await expectClean(state);
});

test('5. settings: auto-compact trigger validates 60-90 integers and persists for the session', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  const input = page.getByTestId('next-pref-compact-trigger');
  await expect(input).toHaveValue('80');
  await expect(page.getByTestId('next-settings-general')).toContainText('自动压缩触发点');
  const err = page.getByTestId('next-pref-compact-error');

  const puts = async () => (await state.requests()).filter((r) => r.method === 'PUT' && /\/api\/v2\/settings$/.test(r.url)).length;

  for (const bad of ['59', '91', '1.5', '']) {
    await input.fill(bad);
    await input.press('Enter');
    await expect(err).toBeVisible();
    await expect(err).toHaveText('请输入 60 到 90 的整数');
  }
  expect(await puts()).toBe(0);

  await input.fill('60');
  await input.press('Enter');
  await expect(err).toHaveCount(0);
  expect(await puts()).toBe(1);
  await input.fill('90');
  await input.blur();
  await expect(err).toHaveCount(0);
  expect(await puts()).toBe(2);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toBeHidden();
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-pref-compact-trigger')).toHaveValue('90');
  await expectClean(state);
});

test('6. English labels and dark theme', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-pref-lang').locator('[data-lang=en]').click();
  await page.getByTestId('next-pref-appearance').locator('[data-mode=dark]').click();
  await expect(page.getByTestId('next-settings-general')).toContainText('Auto-compact at');
  await page.getByTestId('next-pref-compact-trigger').fill('50');
  await page.getByTestId('next-pref-compact-trigger').press('Enter');
  await expect(page.getByTestId('next-pref-compact-error')).toHaveText('Enter a whole number from 60 to 90');
  await page.keyboard.press('Escape');

  await openConv(page, 'c-compact-failed');
  await expect(page.getByTestId('next-compaction-error')).toHaveText('Compaction failed: model request timed out');
  await openMenu(page);
  await expect(page.getByTestId('next-menu-compact')).toContainText('Compact');
  await page.getByTestId('next-menu-compact').click();
  await expect(page.getByTestId('next-thread-compacting')).toHaveText('Compacting…');
  await expect(page.getByTestId('next-compaction-error')).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press('Escape');
  await openConv(page, 'c-compacted');
  await expect(page.getByTestId('next-compaction-title')).toHaveText('Context compacted');
  await expect(page.getByTestId('next-compaction-meta')).toHaveText('Previous 2 items summarized');
  await page.getByTestId('next-compaction-toggle').click();
  await expect(page.getByTestId('next-compaction-detail')).toContainText('Conversation summary');
  await expectClean(state);
});

test('7. handoff divider is unchanged and shares the compaction divider look in light and dark', async ({ page }) => {
  const state = await openProto(page);

  const look = () => page.getByTestId('next-item-system-note').last().evaluate((el) => {
    const css = (node, prop) => getComputedStyle(node)[prop];
    const bar = el.querySelector('.handoff-divider-bar');
    const line = el.querySelector('.handoff-divider-line');
    const title = el.querySelector('.handoff-divider-title');
    const toggle = el.querySelector('.handoff-detail-toggle');
    return {
      container: el.className,
      barDisplay: css(bar, 'display'),
      lineBg: css(line, 'backgroundColor'),
      lineHeight: css(line, 'height'),
      titleSize: css(title, 'fontSize'),
      titleColor: css(title, 'color'),
      toggleBorder: css(toggle, 'borderTopColor'),
      toggleRadius: css(toggle, 'borderTopLeftRadius'),
      margin: css(el, 'marginTop'),
    };
  });

  const read = async (id) => {
    await openConv(page, id);
    await expect(page.getByTestId('next-item-system-note').last()).toBeVisible();
    return look();
  };

  for (const mode of ['light', 'dark']) {
    await page.getByTestId('next-open-settings').click();
    await page.getByTestId('next-pref-appearance').locator(`[data-mode=${mode}]`).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('next-settings')).toBeHidden();

    const handoff = await read('c-handoff');
    await expect(page.getByTestId('next-handoff-divider')).toBeVisible();
    await expect(page.locator('.handoff-divider-icon')).toHaveCount(0);
    await expect(page.getByTestId('next-handoff-title')).toHaveText('新上下文');
    await expect(page.getByTestId('next-thread-earlier-toggle')).toContainText('之前的上下文');

    const compaction = await read('c-compacted');
    await expect(page.getByTestId('next-compaction-divider')).toBeVisible();
    expect(compaction).toEqual(handoff);
  }
  await expectClean(state);
});

test('7. model menu has no compact row anywhere, including the Context submenu; the window options stay', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  await page.getByTestId('next-model-chip').click();
  const menu = page.getByTestId('next-model-menu');
  await expect(menu.getByTestId('next-menu-context')).toBeVisible();
  await expect(menu.getByTestId('next-menu-compact')).toHaveCount(0);
  await page.getByTestId('next-menu-context').hover();
  const sub = page.getByTestId('next-sub-context');
  await expect(sub).toBeVisible();
  await expect(sub.getByTestId('next-menu-compact')).toHaveCount(0);
  await expect(sub.getByTestId('next-context-option').first()).toBeVisible();
  await expectClean(state);
});

test('8. the context panel shows used / window and compact only, above the chip and inside the viewport', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const chip = page.getByTestId('next-context-chip');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await chip.click();
  const pop = page.getByTestId('next-context-pop');
  await expect(pop).toBeVisible();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('next-context-pop-usage')).toHaveText(/^\S+ \/ \S+$/);
  await expect(page.getByTestId('next-menu-compact')).toBeFocused();
  await expect(page.getByTestId('next-model-menu')).toHaveCount(0);
  await expect(page.getByTestId('next-context-option')).toHaveCount(0);
  const [pb, cb] = await Promise.all([pop.boundingBox(), chip.boundingBox()]);
  expect(pb.y + pb.height).toBeLessThanOrEqual(cb.y);
  expect(pb.x).toBeGreaterThanOrEqual(0);
  expect(pb.x + pb.width).toBeLessThanOrEqual(1440);
  expect(Math.abs((pb.x + pb.width) - (cb.x + cb.width))).toBeLessThanOrEqual(1);
  await expectClean(state);
});

test('9. the panel closes on Escape (focus returns to the chip), outside click and chip click', async ({ page }) => {
  const state = await openProto(page);
  await openConv(page, 'c-docs');
  const chip = page.getByTestId('next-context-chip');
  await chip.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('next-context-pop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-context-pop')).toBeHidden();
  await expect(chip).toBeFocused();
  await chip.click();
  await expect(page.getByTestId('next-context-pop')).toBeVisible();
  await page.mouse.click(700, 300);
  await expect(page.getByTestId('next-context-pop')).toBeHidden();
  await chip.click();
  await chip.click();
  await expect(page.getByTestId('next-context-pop')).toBeHidden();
  await expectClean(state);
});

test('10. a draft conversation shows usage but compact is disabled', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-new-chat').click();
  await expect(page).toHaveURL(/#\/(w\/[^/]+\/)?new$/);
  await page.getByTestId('next-context-chip').click();
  await expect(page.getByTestId('next-context-pop')).toBeVisible();
  await expect(page.getByTestId('next-menu-compact')).toBeDisabled();
  await expectClean(state);
});
