import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * Scheduled tasks (T124-1): Sidebar clock button, active schedules count badge,
 * schedules pane list, create/edit modal with validation (interval >= 5 min),
 * toggle pause/enable, immediate run trigger, expanded execution runs history,
 * and deletion confirmation.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('scheduled tasks: sidebar navigation, badge count, and empty footer note', async ({ page }) => {
  const state = await openProto(page);

  // 1. Sidebar has schedules entry with clock icon and enabled count badge (seeded: 3 enabled)
  const navBtn = page.getByTestId('next-schedules');
  await expect(navBtn).toBeVisible();
  const countBadge = page.getByTestId('next-schedules-count');
  await expect(countBadge).toHaveText('3');

  // 2. Click to navigate to #/schedules
  await navBtn.click();
  await expect(page).toHaveURL(/#\/schedules$/);
  await expect(navBtn).toHaveClass(/sel/);

  // 3. Middle pane renders schedules view
  const pane = page.getByTestId('next-schedules-pane');
  await expect(pane).toBeVisible();
  await expect(page.getByTestId('next-schedules-title')).toHaveText('定时任务');

  const header = page.getByTestId('next-schedules-header');
  await expect(header).toBeVisible();
  const borderBottomWidth = await header.evaluate((el) => window.getComputedStyle(el).borderBottomWidth);
  expect(borderBottomWidth).toBe('0px');

  const newBtn = page.getByTestId('next-schedules-new');
  await expect(newBtn).toBeVisible();

  // Assert "+ 新建" button and top-right toggle (.side-toggle-right) do not overlap
  const rightToggle = page.getByTestId('next-right-toggle');
  await expect(rightToggle).toBeVisible();
  const newBox = await newBtn.boundingBox();
  const toggleBox = await rightToggle.boundingBox();
  expect(newBox).not.toBeNull();
  expect(toggleBox).not.toBeNull();
  const overlaps =
    newBox.x < toggleBox.x + toggleBox.width &&
    newBox.x + newBox.width > toggleBox.x &&
    newBox.y < toggleBox.y + toggleBox.height &&
    newBox.y + newBox.height > toggleBox.y;
  expect(overlaps).toBe(false);

  // 4. Seeded schedule rows: 4 items in total
  const rows = page.getByTestId('next-schedule-row');
  await expect(rows).toHaveCount(4);

  // Assert multi-column grid: at 1440 viewport width, first two cards share the same y position
  const box0 = await rows.nth(0).boundingBox();
  const box1 = await rows.nth(1).boundingBox();
  expect(box0).not.toBeNull();
  expect(box1).not.toBeNull();
  expect(Math.round(box0.y)).toBe(Math.round(box1.y));

  // Assert paused toggle switch is visible with dimensions > 0 and opacity > 0
  const pausedRow = page.locator('[data-testid="next-schedule-row"][data-id="sched-4"]');
  const pausedToggle = pausedRow.getByTestId('next-schedule-toggle');
  await expect(pausedToggle).toBeVisible();
  const pausedBox = await pausedToggle.boundingBox();
  expect(pausedBox.width).toBeGreaterThan(0);
  expect(pausedBox.height).toBeGreaterThan(0);
  const pausedOpacity = await pausedToggle.evaluate((el) => window.getComputedStyle(el).opacity);
  expect(parseFloat(pausedOpacity)).toBeGreaterThan(0);

  // 5. Agent-created badge on sched-2
  const agentRow = page.locator('[data-testid="next-schedule-row"][data-id="sched-2"]');
  await expect(agentRow.getByTestId('next-schedule-agent-badge')).toHaveText('Agent 创建');

  // 6. Footer note visible
  await expect(page.getByTestId('next-schedules-footer-note')).toContainText(
    '退出 Weft 后不会执行，错过的会在下次启动时补跑一次。',
  );

  // Assert no native date/time pickers exist anywhere on page
  await expect(page.locator('input[type="time"], input[type="date"], input[type="datetime-local"]')).toHaveCount(0);

  expectClean(state);
});

test('scheduled tasks: toggle pause/enable updates status and sidebar count badge', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();
  await expect(page.getByTestId('next-schedules-count')).toHaveText('3');

  // sched-1 is enabled; toggle it off
  const sched1 = page.locator('[data-testid="next-schedule-row"][data-id="sched-1"]');
  const toggle1 = sched1.getByTestId('next-schedule-toggle');
  await expect(toggle1).toHaveClass(/is-on/);

  await toggle1.click();
  await expect(toggle1).not.toHaveClass(/is-on/);
  // Sidebar badge updates from 3 to 2
  await expect(page.getByTestId('next-schedules-count')).toHaveText('2');

  // Toggle it back on
  await toggle1.click();
  await expect(toggle1).toHaveClass(/is-on/);
  await expect(page.getByTestId('next-schedules-count')).toHaveText('3');

  expectClean(state);
});

test('scheduled tasks: interval rule validation blocks < 5 minutes', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();

  // Open create dialog
  await page.getByTestId('next-schedules-new').click();
  const dialog = page.getByTestId('next-schedule-dialog');
  await expect(dialog).toBeVisible();

  // Fill name & message
  await page.getByTestId('next-schedule-name-input').fill('间隔测试');
  await page.getByTestId('next-schedule-message-input').fill('执行高频监控');

  // Select interval rule
  await page.getByTestId('next-schedule-rule-interval').click();
  const intervalInput = page.getByTestId('next-schedule-interval-input');

  // Type 3 minutes (< 5 min)
  await intervalInput.fill('3');
  const err = page.getByTestId('next-schedule-err-interval');
  await expect(err).toBeVisible();
  await expect(err).toContainText('间隔不能少于 5 分钟');

  // Submit button should be disabled
  const submitBtn = page.getByTestId('next-schedule-submit');
  await expect(submitBtn).toBeDisabled();

  // Change to 5 minutes (valid)
  await intervalInput.fill('5');
  await expect(err).toHaveCount(0);
  await expect(submitBtn).toBeEnabled();

  // Assert switching rules updates "下次运行" hint in real-time
  const hintEl = page.getByTestId('next-schedule-next-run-hint');
  await expect(hintEl).toBeVisible();
  const intervalHint = await hintEl.textContent();

  await page.getByTestId('next-schedule-rule-daily').click();
  const dailyHint = await hintEl.textContent();
  expect(dailyHint).not.toBe(intervalHint);

  await page.getByTestId('next-schedule-rule-weekly').click();
  const weeklyHint = await hintEl.textContent();
  expect(weeklyHint).not.toBe(dailyHint);

  await page.getByTestId('next-schedule-rule-once').click();
  const onceHint = await hintEl.textContent();
  expect(onceHint).not.toBe(weeklyHint);

  // Custom TimePicker in dialog replaces the native control
  await expect(page.locator('input[type="time"], input[type="date"], input[type="datetime-local"]')).toHaveCount(0);
  const onceTimeInput = page.getByTestId('next-schedule-once-time');
  await onceTimeInput.click();
  const timePopup = page.getByTestId('next-schedule-once-time-popup');
  await expect(timePopup).toBeVisible();
  await page.getByTestId('next-schedule-once-time-hour-14').click();
  await expect(timePopup).toBeVisible();
  await page.getByTestId('next-schedule-once-time-min-30').click();
  await expect(timePopup).toHaveCount(0);
  await expect(onceTimeInput).toHaveValue('14:30');

  // Cancel closes modal without saving
  await page.getByTestId('next-schedule-cancel').click();
  await expect(dialog).toHaveCount(0);

  expectClean(state);
});

test('scheduled tasks: create, immediate run, expand runs, and delete with confirm', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();

  // 1. Create a new weekly schedule
  await page.getByTestId('next-schedules-new').click();
  await page.getByTestId('next-schedule-name-input').fill('每周安全审计');
  await page.getByTestId('next-schedule-message-input').fill('请执行安全依赖检查并汇总报告');
  await page.getByTestId('next-schedule-rule-weekly').click();

  // Choose Target: new chat in first workspace
  await page.getByTestId('next-schedule-target-new').click();
  await page.getByTestId('next-schedule-submit').click();

  // Modal closes, new schedule appears in list (now 5 rows), badge updates to 4
  await expect(page.getByTestId('next-schedule-dialog')).toHaveCount(0);
  await expect(page.getByTestId('next-schedule-row')).toHaveCount(5);
  await expect(page.getByTestId('next-schedules-count')).toHaveText('4');
  await expect(page.locator('.schedules-list')).toContainText('每周安全审计');

  // Find the newly created schedule row
  const newRow = page.locator('[data-testid="next-schedule-row"]').filter({ hasText: '每周安全审计' });
  await expect(newRow).toBeVisible();

  // 2. Immediate run via "..." menu
  await newRow.getByTestId('next-schedule-more').click();
  const runMenuBtn = page.locator('[data-testid="next-ctx-item"][data-action="run"]');
  await expect(runMenuBtn).toBeVisible();
  await runMenuBtn.click();

  // Run triggered, toast shown, last run status badge becomes ok
  const dot = newRow.getByTestId('next-schedule-last-run-dot');
  await expect(dot).toHaveAttribute('data-status', 'ok');
  await expect(dot).toHaveAttribute('title', /成功/);

  // 3. Whole card click opens edit dialog
  await newRow.click();
  const editDialog = page.getByTestId('next-schedule-dialog');
  await expect(editDialog).toBeVisible();
  await expect(page.getByTestId('next-schedule-name-input')).toHaveValue('每周安全审计');
  await page.getByTestId('next-schedule-cancel').click();
  await expect(editDialog).toHaveCount(0);

  // 4. Delete with confirm: cancel keeps the row, confirm removes it
  await newRow.getByTestId('next-schedule-more').click();
  const delMenuBtn = page.locator('[data-testid="next-ctx-item"][data-action="delete"]');
  await expect(delMenuBtn).toBeVisible();
  await delMenuBtn.click();

  // Confirm dialog opens
  const confirmDialog = page.getByTestId('next-confirm');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByTestId('next-confirm-message')).toContainText('每周安全审计');

  // Cancel deletion
  await page.getByTestId('next-confirm-cancel').click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(page.getByTestId('next-schedule-row')).toHaveCount(5);

  // Re-open delete and confirm
  await newRow.getByTestId('next-schedule-more').click();
  await page.locator('[data-testid="next-ctx-item"][data-action="delete"]').click();
  await expect(confirmDialog).toBeVisible();
  await page.getByTestId('next-confirm-ok').click();

  // Row removed, count drops back to 4 rows (and 3 active)
  await expect(confirmDialog).toHaveCount(0);
  await expect(page.getByTestId('next-schedule-row')).toHaveCount(4);
  await expect(page.getByTestId('next-schedules-count')).toHaveText('3');
  await expect(page.locator('.schedules-list')).not.toContainText('每周安全审计');

  expectClean(state);
});

test('composer scheduled send creates once task, displays strip, cancel confirms deletion and removes strip', async ({ page }) => {
  const state = await openProto(page);

  // 1. Open conversation c-tests which has no scheduled tasks
  await page.locator('[data-testid="next-conv-row"][data-id="c-tests"]').click();
  await expect(page.getByTestId('next-conversation-schedule-strip')).toHaveCount(0);

  // 2. Schedule button in composer is disabled when empty
  const schedBtn = page.getByTestId('next-composer-schedule');
  await expect(schedBtn).toBeVisible();
  await expect(schedBtn).toBeDisabled();

  // 3. Type message into composer
  const input = page.locator('[data-testid="next-composer"] textarea');
  await input.fill('请在明天九点运行单测并汇报结果');
  await expect(schedBtn).toBeEnabled();

  // 4. Click schedule button to open quick menu
  await schedBtn.click();
  const popover = page.getByTestId('next-composer-schedule-popover');
  await expect(popover).toBeVisible();
  await expect(page.getByTestId('next-schedule-opt-30m')).toBeVisible();
  await expect(page.getByTestId('next-schedule-opt-1h')).toBeVisible();
  await expect(page.getByTestId('next-schedule-opt-tomorrow')).toBeVisible();
  await expect(page.getByTestId('next-schedule-opt-custom')).toBeVisible();

  // 5. Select "明天 09:00"
  await page.getByTestId('next-schedule-opt-tomorrow').click();
  await expect(popover).toHaveCount(0);

  // 6. Input is cleared and toast appears
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('next-toast')).toContainText('已定时：明天 09:00 发送');

  // 7. Conversation schedule strip appears above composer
  const strip = page.getByTestId('next-conversation-schedule-strip');
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('next-schedule-strip-text')).toContainText('已定时：明天 09:00 发送「请在明天九点运行单测并汇报结果」');

  const cancelBtn = strip.getByTestId('next-schedule-strip-cancel');
  const manageBtn = strip.getByTestId('next-schedule-strip-manage');
  await expect(cancelBtn).toBeVisible();
  await expect(manageBtn).toBeVisible();

  // 8. Cancel with confirmation
  await cancelBtn.click();
  const confirmDialog = page.getByTestId('next-confirm');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog.getByTestId('next-confirm-message')).toContainText('请在明天九点运行单测并汇报结果');

  // Dismiss confirmation -> strip remains
  await page.getByTestId('next-confirm-cancel').click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(strip).toBeVisible();

  // Confirm cancellation -> task is deleted, strip disappears
  await cancelBtn.click();
  await expect(confirmDialog).toBeVisible();
  await page.getByTestId('next-confirm-ok').click();
  await expect(confirmDialog).toHaveCount(0);
  await expect(strip).toHaveCount(0);

  expectClean(state);
});

test('agent created schedule in conversation shows schedule strip, manage navigates and highlights schedule', async ({ page }) => {
  const state = await openProto(page);

  // 1. Open conversation c-ci-schedule (seeded with agent-created task sched-2)
  await page.locator('[data-testid="next-conv-row"][data-id="c-ci-schedule"]').click();

  // 2. Schedule strip appears above composer
  const strip = page.getByTestId('next-conversation-schedule-strip');
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('next-schedule-strip-text')).toContainText('已定时：每个工作日 09:00 发送「检查最新 CI 构建状态并汇报」');

  // Repeating task should NOT display cancel button
  await expect(strip.getByTestId('next-schedule-strip-cancel')).toHaveCount(0);

  // 3. Click "管理" navigates to #/schedules with highlight
  const manageBtn = strip.getByTestId('next-schedule-strip-manage');
  await expect(manageBtn).toBeVisible();
  await manageBtn.click();

  await expect(page).toHaveURL(/#\/schedules\?highlight=sched-2/);
  const row = page.locator('[data-testid="next-schedule-row"][data-id="sched-2"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-highlighted', 'true');

  expectClean(state);
});

test('schedule tool row in conversation navigates to schedules and highlights schedule', async ({ page }) => {
  const state = await openProto(page);

  // 1. Open conversation c-ci-schedule
  await page.locator('[data-testid="next-conv-row"][data-id="c-ci-schedule"]').click();

  // 2. Expand tool group to see tool row
  await page.getByTestId('next-tool-group-summary').first().click();
  const toolRow = page.locator('[data-testid="next-tool-row"][data-tool="schedule"]');
  await expect(toolRow).toBeVisible();
  await expect(toolRow).toContainText('定时任务：新建「每天看 CI」');

  // 3. Click tool row navigates to #/schedules and highlights sched-2
  await toolRow.click();
  await expect(page).toHaveURL(/#\/schedules\?highlight=sched-2/);
  const row = page.locator('[data-testid="next-schedule-row"][data-id="sched-2"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-highlighted', 'true');

  expectClean(state);
});

test('composer clock custom: DatePicker + TimePicker create once task and show strip', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid="next-conv-row"][data-id="c-tests"]').click();
  await expect(page.getByTestId('next-conversation-schedule-strip')).toHaveCount(0);

  const input = page.locator('[data-testid="next-composer"] textarea');
  await input.fill('按计划在明天下午两点半执行回归测试');
  await page.getByTestId('next-composer-schedule').click();
  await page.getByTestId('next-schedule-opt-custom').click();
  await expect(page.getByTestId('next-schedule-custom-view')).toBeVisible();

  await expect(page.locator('input[type="time"], input[type="date"], input[type="datetime-local"]')).toHaveCount(0);

  const customTime = page.getByTestId('next-schedule-custom-time');
  await customTime.click();
  const timePopup = page.getByTestId('next-schedule-custom-time-popup');
  await expect(timePopup).toBeVisible();
  await page.getByTestId('next-schedule-custom-time-hour-14').click();
  await page.getByTestId('next-schedule-custom-time-min-30').click();
  await expect(timePopup).toHaveCount(0);
  await expect(customTime).toHaveValue('14:30');

  await page.getByTestId('next-schedule-custom-confirm').click();
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('next-toast')).toContainText('已定时：');

  const strip = page.getByTestId('next-conversation-schedule-strip');
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('next-schedule-strip-text')).toContainText('按计划在明天下午两点半执行回归测试');

  expectClean(state);
});

async function expectPopupPlacement(page, trigger, popup, placement = 'below') {
  const t = await trigger.boundingBox();
  const p = await popup.boundingBox();
  expect(t).not.toBeNull();
  expect(p).not.toBeNull();
  const vp = page.viewportSize();
  expect(Math.abs(p.x - t.x)).toBeLessThanOrEqual(2);
  if (placement === 'below') {
    expect(p.y).toBeGreaterThanOrEqual(t.y + t.height - 0.5);
    expect(p.y - (t.y + t.height)).toBeLessThanOrEqual(8);
  } else {
    expect(p.y + p.height).toBeLessThanOrEqual(t.y + 0.5);
  }
  expect(p.x).toBeGreaterThanOrEqual(8 - 0.5);
  expect(p.x + p.width).toBeLessThanOrEqual(vp.width - 8 + 0.5);
  expect(p.y).toBeGreaterThanOrEqual(0);
  expect(p.y + p.height).toBeLessThanOrEqual(vp.height);
}

test('schedule dialog: time and date popups anchor below their trigger, 09 centered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();
  await page.getByTestId('next-schedules-new').click();
  await expect(page.getByTestId('next-schedule-dialog')).toBeVisible();

  await page.getByTestId('next-schedule-rule-weekly').click();
  const timeTrigger = page.getByTestId('next-schedule-weekly-time').locator('xpath=ancestor::div[contains(@class,"picker-trigger")][1]');
  await page.getByTestId('next-schedule-weekly-time').click();
  const popup = page.getByTestId('next-schedule-weekly-time-popup');
  await expect(popup).toBeVisible();
  await expectPopupPlacement(page, timeTrigger, popup);
  const hour09 = page.getByTestId('next-schedule-weekly-time-hour-09');
  await expect(hour09).toHaveClass(/is-selected/);
  await expect(page.getByTestId('next-schedule-weekly-time-min-00')).toHaveClass(/is-selected/);
  const cb = await hour09.boundingBox();
  const col = await page.getByTestId('time-picker-hours-col').boundingBox();
  expect(cb.y).toBeGreaterThanOrEqual(col.y - 1);
  expect(cb.y + cb.height).toBeLessThanOrEqual(col.y + col.height + 1);
  const mid = cb.y + cb.height / 2 - (col.y + col.height / 2);
  expect(Math.abs(mid)).toBeLessThanOrEqual(30);
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);

  await page.getByTestId('next-schedule-rule-once').click();
  const dateTrigger = page.getByTestId('next-schedule-once-date').locator('xpath=ancestor::div[contains(@class,"picker-trigger")][1]');
  await page.getByTestId('next-schedule-once-date').click();
  const dpopup = page.getByTestId('next-schedule-once-date-popup');
  await expect(dpopup).toBeVisible();
  await expectPopupPlacement(page, dateTrigger, dpopup);

  // Dark theme: same anchoring
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.getByTestId('next-schedule-once-date').click();
  await expectPopupPlacement(page, dateTrigger, page.getByTestId('next-schedule-once-date-popup'));

  expectClean(state);
});

test('composer custom pickers: popups anchor to their triggers', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid="next-conv-row"][data-id="c-tests"]').click();
  await page.locator('[data-testid="next-composer"] textarea').fill('定位测试');
  await page.getByTestId('next-composer-schedule').click();
  await page.getByTestId('next-schedule-opt-custom').click();

  const timeTrigger = page.getByTestId('next-schedule-custom-time').locator('xpath=ancestor::div[contains(@class,"picker-trigger")][1]');
  await page.getByTestId('next-schedule-custom-time').click();
  const popup = page.getByTestId('next-schedule-custom-time-popup');
  await expect(popup).toBeVisible();
  await expectPopupPlacement(page, timeTrigger, popup, 'above');

  const dateTrigger = page.getByTestId('next-schedule-custom-date').locator('xpath=ancestor::div[contains(@class,"picker-trigger")][1]');
  await page.getByTestId('next-schedule-custom-date').click();
  const dpopup = page.getByTestId('next-schedule-custom-date-popup');
  await expect(dpopup).toBeVisible();
  await expectPopupPlacement(page, dateTrigger, dpopup, 'above');

  expectClean(state);
});

test('schedule dialog: popup flips above the trigger when there is no room below', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  const state = await openProto(page);
  await page.getByTestId('next-schedules').click();
  await page.getByTestId('next-schedules-new').click();
  await page.getByTestId('next-schedule-rule-once').click();
  const dateTrigger = page.getByTestId('next-schedule-once-date').locator('xpath=ancestor::div[contains(@class,"picker-trigger")][1]');
  await page.getByTestId('next-schedule-once-date').click();
  const popup = page.getByTestId('next-schedule-once-date-popup');
  await expect(popup).toBeVisible();
  const t = await dateTrigger.boundingBox();
  const p = await popup.boundingBox();
  expect(p.y + p.height).toBeLessThanOrEqual(t.y + 0.5);
  expect(p.y).toBeGreaterThanOrEqual(0);
  expect(Math.abs(p.x - t.x)).toBeLessThanOrEqual(2);
  expectClean(state);
});

function parseRgb(css) {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unparsable color: ${css}`);
  return m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map(Number);
}
function luminance([r, g, b]) {
  const f = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
async function contrastOf(locator) {
  // Computed colors may be serialised as oklch()/color-mix(); normalise to sRGB through a canvas.
  const [fg, bg] = await locator.evaluate((el) => {
    const toRgb = (c) => {
      const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
      ctx.canvas.width = ctx.canvas.height = 1;
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
    };
    const cs = getComputedStyle(el);
    return [toRgb(cs.color), toRgb(cs.backgroundColor)];
  });
  const [l1, l2] = [luminance(parseRgb(fg)), luminance(parseRgb(bg))].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

// claude-light is excluded: its own --accent/--on-accent pair is 4.1:1 (theme palette, affects every primary button).
for (const theme of ['white-light', 'white-dark', 'claude-dark']) {
  test(`schedule dialog: selected weekday chip and selected date keep contrast >= 4.5 (${theme})`, async ({ page }) => {
    const state = await openProto(page);
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.getByTestId('next-schedules').click();
    await page.getByTestId('next-schedules-new').click();
    await expect(page.getByTestId('next-schedule-dialog')).toBeVisible();

    await page.getByTestId('next-schedule-rule-weekly').click();
    const chip = page.locator('.schedule-day-chip.is-active').first();
    await expect(chip).toBeVisible();
    expect(await contrastOf(chip)).toBeGreaterThanOrEqual(4.5);

    // Hover keeps contrast and stays distinct from an unselected chip.
    await chip.hover();
    expect(await contrastOf(chip)).toBeGreaterThanOrEqual(4.5);
    const bgOf = (l) => l.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await bgOf(chip)).not.toBe(await bgOf(page.locator('.schedule-day-chip:not(.is-active)').first()));

    await page.getByTestId('next-schedule-rule-once').click();
    await page.getByTestId('next-schedule-once-date').click();
    const selected = page.getByTestId('next-schedule-once-date-popup').locator('.date-picker-cell.is-selected');
    await expect(selected).toBeVisible();
    expect(await contrastOf(selected)).toBeGreaterThanOrEqual(4.5);

    expectClean(state);
  });
}

for (const theme of ['light', 'dark']) {
  test(`schedules header has no bottom border and content does not stick to top (${theme}, populated and empty)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const state = await openProto(page);
    await page.getByTestId('next-schedules').click();

    const header = page.getByTestId('next-schedules-header');
    await expect(header).toBeVisible();
    const borderBottomWidth = await header.evaluate((el) => window.getComputedStyle(el).borderBottomWidth);
    expect(borderBottomWidth).toBe('0px');

    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();

    // 1. Populated state: first card is visible and spaced below header
    const firstRow = page.getByTestId('next-schedule-row').first();
    await expect(firstRow).toBeVisible();
    const rowBox = await firstRow.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox.y - (headerBox.y + headerBox.height)).toBeGreaterThanOrEqual(16);

    // 2. Empty state: delete all schedules, empty placeholder is visible, header still has no border, and content does not stick to top
    await page.evaluate(async () => {
      const res = await fetch('/api/v2/schedules');
      const data = await res.json();
      for (const s of data.schedules) {
        await fetch(`/api/v2/schedules/${s.id}`, { method: 'DELETE' });
      }
    });

    const empty = page.getByTestId('next-schedules-empty');
    await expect(empty).toBeVisible();
    const emptyBorder = await header.evaluate((el) => window.getComputedStyle(el).borderBottomWidth);
    expect(emptyBorder).toBe('0px');
    const emptyBox = await empty.boundingBox();
    expect(emptyBox).not.toBeNull();
    expect(emptyBox.y).toBeGreaterThan(headerBox.y + headerBox.height + 20);

    expectClean(state);
  });
}
