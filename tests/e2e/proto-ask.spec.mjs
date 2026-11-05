import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 60_000 });

test('c-ask full keyboard walkthrough answers two questions and submits', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  const panel = page.getByTestId('next-ask-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('next-composer')).toBeHidden();

  // Waiting state in message stream: lists questions without options
  const initialToolRow = page.locator('[data-testid=next-tool-row][data-tool="ask"]');
  await expect(initialToolRow).toBeVisible();
  await expect(initialToolRow.getByTestId('next-tool-row-status')).toHaveText('等待回答');
  await expect(initialToolRow.getByTestId('next-tool-row-question').first()).toHaveText('用哪种包管理器？');
  await expect(initialToolRow.locator('.ask-option')).toHaveCount(0);
  await expect(initialToolRow).not.toContainText('Node 自带');

  // Progress shows 1 / 2
  await expect(page.getByTestId('next-ask-progress')).toHaveText('1 / 2');

  // Question 1: single-select (1: npm, 2: pnpm). Press 2 to select pnpm
  await page.keyboard.press('2');
  const pnpmOption = page.getByTestId('next-ask-option').filter({ hasText: 'pnpm' });
  await expect(pnpmOption).toHaveAttribute('aria-checked', 'true');

  // Press ArrowRight to switch to question 2
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('next-ask-progress')).toHaveText('2 / 2');

  // Question 2: multi-select (1: lint, 2: test, 3: typecheck). Press 1 and 2
  await page.keyboard.press('1');
  await page.keyboard.press('2');
  const lintOption = page.getByTestId('next-ask-option').filter({ hasText: 'lint' });
  const testOption = page.getByTestId('next-ask-option').filter({ hasText: 'test' });
  await expect(lintOption).toHaveAttribute('aria-checked', 'true');
  await expect(testOption).toHaveAttribute('aria-checked', 'true');

  // Submit via Cmd+Enter / Ctrl+Enter from anywhere
  await page.keyboard.press('Meta+Enter');

  // Panel unmounts and composer is restored immediately
  await expect(page.getByTestId('next-ask-panel')).toBeHidden();
  await expect(page.getByTestId('next-composer')).toBeVisible();

  // Tool row card in message stream displays answered card with full question text and answers
  const toolRow = page.locator('[data-testid=next-tool-row][data-tool="ask"]');
  await expect(toolRow).toBeVisible();
  await expect(toolRow.getByTestId('next-tool-row-status')).toHaveText('已回答');

  const q1Text = toolRow.getByTestId('next-tool-row-question').first();
  const q1Ans = toolRow.getByTestId('next-tool-row-hint').first();
  await expect(q1Text).toHaveText('用哪种包管理器？');
  await expect(q1Ans).toContainText('pnpm');

  const q2Text = toolRow.getByTestId('next-tool-row-question').nth(1);
  const q2Ans = toolRow.getByTestId('next-tool-row-hint').nth(1);
  await expect(q2Text).toHaveText('要跑哪些检查？');
  await expect(q2Ans).toContainText('lint、test');

  // Verify answer color and question color are different
  const qColor = await q1Text.evaluate((el) => window.getComputedStyle(el).color);
  const ansColor = await q1Ans.evaluate((el) => window.getComputedStyle(el).color);
  expect(qColor).not.toBe(ansColor);

  expectClean(state);
});

test('c-ask multi-select checks two options, Cmd+Enter on checked option keeps both in submission and record', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  // Question 1: single-select (select pnpm)
  await page.getByTestId('next-ask-option').filter({ hasText: 'pnpm' }).click();

  // Wait for auto-jump to question 2
  await expect(page.getByTestId('next-ask-progress')).toHaveText('2 / 2', { timeout: 3000 });

  // Question 2: check two options (lint and test)
  const lintOption = page.getByTestId('next-ask-option').filter({ hasText: 'lint' });
  const testOption = page.getByTestId('next-ask-option').filter({ hasText: 'test' });

  await lintOption.click();
  await expect(lintOption).toHaveAttribute('aria-checked', 'true');

  await testOption.click();
  await expect(testOption).toHaveAttribute('aria-checked', 'true');

  // Explicitly focus an already-checked option (lint)
  await lintOption.focus();
  await expect(lintOption).toBeFocused();

  // Capture answer payload by wrapping window.fetch in page
  await page.evaluate(() => {
    window.__sentAnswers = [];
    const origFetch = window.fetch;
    window.fetch = (input, init) => {
      if (init?.body && typeof init.body === 'string') {
        try {
          const parsed = JSON.parse(init.body);
          if (parsed.answer) window.__sentAnswers.push(parsed.answer);
        } catch {}
      }
      return origFetch(input, init);
    };
  });

  // Press Meta+Enter (Cmd+Enter) while focused on the already-checked option
  await page.keyboard.press('Meta+Enter');

  // Panel unmounts and composer is restored
  await expect(page.getByTestId('next-ask-panel')).toBeHidden();
  await expect(page.getByTestId('next-composer')).toBeVisible();

  // Verify payload contained both lint and test in answers
  const sentAnswers = await page.evaluate(() => window.__sentAnswers);
  expect(sentAnswers).toHaveLength(1);
  const q2Answer = sentAnswers[0].answers?.find((a) => a.questionIndex === 1);
  expect(q2Answer?.selected).toEqual(expect.arrayContaining(['lint', 'test']));
  expect(q2Answer?.selected).toHaveLength(2);

  // Tool row in conversation record displays both lint and test
  const toolRow = page.locator('[data-testid=next-tool-row][data-tool="ask"]');
  await expect(toolRow).toBeVisible();
  const recordHint = toolRow.getByTestId('next-tool-row-hint').nth(1);
  await expect(recordHint).toContainText('lint');
  await expect(recordHint).toContainText('test');

  expectClean(state);
});

test('c-ask visual styles: initial focus is unstyled, keyboard navigation shows subtle cue, no border clipping', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  const panel = page.getByTestId('next-ask-panel');
  await expect(panel).toBeVisible();

  const options = page.getByTestId('next-ask-option');
  const opt0 = options.first();
  const opt1 = options.nth(1);

  // 1. Initial mount: opt0 is aria-checked=false, border color is same as unselected opt1
  await expect(opt0).toHaveAttribute('aria-checked', 'false');
  await expect(opt1).toHaveAttribute('aria-checked', 'false');

  const opt0BorderInitial = await opt0.evaluate((el) => window.getComputedStyle(el).borderColor);
  const opt1BorderInitial = await opt1.evaluate((el) => window.getComputedStyle(el).borderColor);
  const opt0BgInitial = await opt0.evaluate((el) => window.getComputedStyle(el).backgroundColor);
  expect(opt0BorderInitial).toBe(opt1BorderInitial);

  // 2. Press arrow down key -> keyboard navigation becomes active, focus moves to opt1
  await page.keyboard.press('ArrowDown');
  await expect(opt1).toHaveClass(/is-focused/);
  await expect(page.locator('.ask-options')).toHaveClass(/is-keyboard/);

  // Focused item background changes to subtle hover/sub color (accounting for CSS transition)
  await expect.poll(async () => {
    return opt1.evaluate((el) => window.getComputedStyle(el).backgroundColor);
  }).not.toBe(opt0BgInitial);

  // Focus border is NOT the dark/accent selected border
  const opt1BorderFocused = await opt1.evaluate((el) => window.getComputedStyle(el).borderColor);

  // 3. Select opt0 by clicking
  await opt0.click();
  await expect(opt0).toHaveAttribute('aria-checked', 'true');
  const opt0BorderSelected = await opt0.evaluate((el) => window.getComputedStyle(el).borderColor);

  // Selected item border is distinctly different from keyboard focus border
  expect(opt0BorderSelected).not.toBe(opt1BorderFocused);

  // 4. Verify options clientWidth / bounding box is completely within scroll container without clipping
  const isWithinContainer = await page.evaluate(() => {
    const container = document.querySelector('.ask-body');
    const opts = Array.from(document.querySelectorAll('.ask-option'));
    if (!container || opts.length === 0) return false;
    const cRect = container.getBoundingClientRect();
    return opts.every((opt) => {
      const oRect = opt.getBoundingClientRect();
      return (
        oRect.left >= cRect.left - 0.5 &&
        oRect.right <= cRect.right + 0.5 &&
        opt.clientWidth <= container.clientWidth
      );
    });
  });
  expect(isWithinContainer).toBe(true);

  expectClean(state);
});

test('c-ask single-select auto-jumps to next question after 150ms', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  await expect(page.getByTestId('next-ask-progress')).toHaveText('1 / 2');

  // Click option pnpm on question 1
  await page.getByTestId('next-ask-option').filter({ hasText: 'pnpm' }).click();

  // After ~150ms, automatically advances to question 2
  await expect(page.getByTestId('next-ask-progress')).toHaveText('2 / 2', { timeout: 3000 });
  await expect(page.getByTestId('next-ask-question')).toContainText('要跑哪些检查？');

  expectClean(state);
});

test('c-ask permanent textarea auto-grows as content increases', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  const textarea = page.getByTestId('next-ask-other-input');
  await expect(textarea).toBeVisible();

  const initialHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height);

  // Type multiple lines
  await textarea.fill('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
  const expandedHeight = await textarea.evaluate((el) => el.getBoundingClientRect().height);

  expect(expandedHeight).toBeGreaterThan(initialHeight);

  expectClean(state);
});

test('c-ask persists draft across conversation switches', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  // Select pnpm on question 1
  await page.getByTestId('next-ask-option').filter({ hasText: 'pnpm' }).click();
  // Switch to question 2 and type custom text
  const tabs = page.getByTestId('next-ask-tab');
  await tabs.nth(1).click();
  const textarea = page.getByTestId('next-ask-other-input');
  await textarea.fill('benchmarks');

  // Switch to another conversation in ws-weft (e.g. c-tests)
  await page.locator('[data-testid=next-conv-row][data-id="c-tests"]').click();
  await expect(page).toHaveURL(/#\/c\/c-tests$/);

  // Switch back to c-ask
  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  // Check question 1 selection is still saved
  await tabs.nth(0).click();
  const pnpmOption = page.getByTestId('next-ask-option').filter({ hasText: 'pnpm' });
  await expect(pnpmOption).toHaveAttribute('aria-checked', 'true');

  // Check question 2 text is still saved
  await tabs.nth(1).click();
  const textarea2 = page.getByTestId('next-ask-other-input');
  await expect(textarea2).toHaveValue('benchmarks');

  expectClean(state);
});

test('c-ask skip path restores composer and shows skipped in tool row', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  await expect(page.getByTestId('next-ask-panel')).toBeVisible();
  await expect(page.getByTestId('next-composer')).toBeHidden();

  // Click skip
  await page.getByTestId('next-ask-skip').click();

  // Panel unmounts and composer is restored
  await expect(page.getByTestId('next-ask-panel')).toBeHidden();
  await expect(page.getByTestId('next-composer')).toBeVisible();

  // Tool row card displays "已跳过" status, lists questions without answers, overall grey
  const toolRow = page.locator('[data-testid=next-tool-row][data-tool="ask"]');
  await expect(toolRow).toBeVisible();
  await expect(toolRow).toHaveClass(/is-skipped/);
  await expect(toolRow.getByTestId('next-tool-row-status')).toHaveText('已跳过');
  await expect(toolRow.getByTestId('next-tool-row-question').first()).toHaveText('用哪种包管理器？');
  await expect(toolRow.getByTestId('next-tool-row-question').nth(1)).toHaveText('要跑哪些检查？');
  // Does not show answers
  await expect(toolRow.getByTestId('next-tool-row-hint')).toHaveCount(0);

  expectClean(state);
});

test('c-ask multi-line other answer preserves newlines in record card', async ({ page }) => {
  const state = await openProto(page);

  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  // Question 1: select pnpm
  await page.getByTestId('next-ask-option').filter({ hasText: 'pnpm' }).click();
  await expect(page.getByTestId('next-ask-progress')).toHaveText('2 / 2', { timeout: 3000 });

  // Question 2: type multi-line other text
  const textarea = page.getByTestId('next-ask-other-input');
  await textarea.fill('benchmarks\nprofile\ne2e');

  // Submit via Cmd+Enter
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByTestId('next-ask-panel')).toBeHidden();

  // Answer card in record displays multi-line text with pre-wrap
  const toolRow = page.locator('[data-testid=next-tool-row][data-tool="ask"]');
  await expect(toolRow).toBeVisible();
  const q2Ans = toolRow.getByTestId('next-tool-row-hint').nth(1);
  await expect(q2Ans).toContainText('benchmarks\nprofile\ne2e');

  const whiteSpace = await q2Ans.evaluate((el) => window.getComputedStyle(el).whiteSpace);
  expect(whiteSpace).toMatch(/pre-wrap/);

  expectClean(state);
});

test('c-ask has no horizontal scroll at 774px viewport width', async ({ page }) => {
  const state = await openProto(page);

  await page.evaluate(() => { window.location.hash = '#/c/c-ask'; });
  await page.setViewportSize({ width: 774, height: 900 });

  await expect(page.getByTestId('next-ask-panel')).toBeVisible();

  const box = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    return {
      htmlScroll: html.scrollWidth,
      htmlClient: html.clientWidth,
      bodyScroll: body.scrollWidth,
      bodyClient: body.clientWidth,
    };
  });
  expect(box.htmlScroll).toBeLessThanOrEqual(box.htmlClient + 1);
  expect(box.bodyScroll).toBeLessThanOrEqual(box.bodyClient + 1);

  const panelOverflow = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="next-ask-panel"]');
    if (!panel) return false;
    return panel.scrollWidth > panel.clientWidth;
  });
  expect(panelOverflow).toBe(false);

  expectClean(state);
});

test('c-ask renders properly in dark mode', async ({ page }) => {
  const state = await openProto(page);

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('[data-testid=next-conv-row][data-id="c-ask"]').click();
  await expect(page).toHaveURL(/#\/c\/c-ask$/);

  const panel = page.getByTestId('next-ask-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('next-ask-other-input')).toBeVisible();
  await expect(page.getByTestId('next-ask-next')).toBeVisible();

  // Options rendered cleanly in dark theme
  const opt0 = page.getByTestId('next-ask-option').first();
  await expect(opt0).toBeVisible();
  await opt0.click();
  await expect(opt0).toHaveAttribute('aria-checked', 'true');

  // Verify border is not clipped in dark mode
  const isWithin = await page.evaluate(() => {
    const container = document.querySelector('.ask-body');
    const opts = Array.from(document.querySelectorAll('.ask-option'));
    if (!container || opts.length === 0) return false;
    const cRect = container.getBoundingClientRect();
    return opts.every((opt) => {
      const oRect = opt.getBoundingClientRect();
      return oRect.left >= cRect.left - 0.5 && oRect.right <= cRect.right + 0.5;
    });
  });
  expect(isWithin).toBe(true);

  expectClean(state);
});
