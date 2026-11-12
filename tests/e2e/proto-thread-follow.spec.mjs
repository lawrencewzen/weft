import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('thread auto-follows bottom during streaming, stops following on user scroll up, and resumes when scrolled back to bottom', async ({ page }) => {
  const state = await openProto(page);

  // Switch to an idle conversation (c-docs)
  await page.locator('[data-testid=next-conv-row][data-id="c-docs"]').click();
  await expect(page).toHaveURL(/#\/c\/c-docs$/);

  const thread = page.locator('.center-thread');
  await expect(thread).toBeVisible();

  const STICK_PX = 80;

  // 1. Send "长回复" to trigger a long streaming output
  const composerInput = page.getByTestId('next-composer-input');
  await composerInput.fill('长回复');
  await page.getByTestId('next-send').click();

  // Wait for streaming to start
  const liveMessage = page.locator('[data-streaming="true"]');
  await expect(liveMessage).toBeVisible({ timeout: 10_000 });

  // Sample multiple times during streaming: assert scroll position stays stuck to bottom
  let streamedSamples = 0;
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(300);
    const scrollInfo = await thread.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      dist: el.scrollHeight - el.scrollTop - el.clientHeight,
    }));
    // Thread must have grown taller than viewport
    if (scrollInfo.scrollHeight > scrollInfo.clientHeight) {
      expect(scrollInfo.dist, `sample ${i} dist < STICK_PX (${scrollInfo.dist}px)`).toBeLessThan(STICK_PX);
      streamedSamples++;
    }
  }
  expect(streamedSamples, 'at least several samples while overflowing').toBeGreaterThanOrEqual(3);

  // Wait for the first run to complete
  await expect(liveMessage).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('next-stop')).toHaveCount(0);

  // Assert thread is still at bottom after run completes
  const postRun1 = await thread.evaluate((el) => ({
    dist: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  expect(postRun1.dist).toBeLessThan(STICK_PX);

  // 2. Start a second long reply to test user scrolling up mid-stream
  await composerInput.fill('长回复');
  await page.getByTestId('next-send').click();

  await expect(liveMessage).toBeVisible({ timeout: 10_000 });

  // Wait until content overflows significantly
  await page.waitForFunction(() => {
    const el = document.querySelector('.center-thread');
    return el && el.scrollHeight > el.clientHeight + 350;
  }, { timeout: 10_000 });

  // Mid-stream: scroll up by 300px
  await thread.evaluate((el) => {
    el.scrollTop -= 300;
  });

  const scrolledTop = await thread.evaluate((el) => el.scrollTop);

  // Wait while stream continues: assert it is NOT pulled back down to bottom
  await page.waitForTimeout(600);
  const midScroll = await thread.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    dist: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));

  expect(midScroll.dist, 'distance from bottom remains >= 200px after user scroll up').toBeGreaterThanOrEqual(200);
  expect(midScroll.scrollTop, 'scrollTop did not jump to bottom').toBeLessThanOrEqual(scrolledTop + 10);

  // 3. Scroll back to bottom: assert follow resumes
  await thread.evaluate((el) => {
    el.scrollTop = el.scrollHeight - el.clientHeight;
  });

  // Verify it stays at bottom as streaming finishes
  await page.waitForTimeout(400);
  const resumedScroll = await thread.evaluate((el) => ({
    dist: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  expect(resumedScroll.dist, 'resumed follow near bottom').toBeLessThan(STICK_PX);

  // Wait for second run to complete
  await expect(liveMessage).toHaveCount(0, { timeout: 15_000 });
  const finalScroll = await thread.evaluate((el) => ({
    dist: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  expect(finalScroll.dist, 'final scroll at bottom').toBeLessThan(STICK_PX);

  expectClean(state);
});
