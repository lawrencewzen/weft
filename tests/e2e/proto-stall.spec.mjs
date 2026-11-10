import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('c-site-1 shows stall strip with tool summary, clicking stop dismisses strip and readies composer', async ({ page }) => {
  const state = await openProto(page);

  // 1. Visit c-site-1: expand website workspace if needed, then open c-site-1
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);

  const strip = page.getByTestId('next-stall-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('已 4 分钟没有动静');

  const tool = page.getByTestId('next-stall-tool');
  await expect(tool).toBeVisible();
  await expect(tool).toContainText('正在运行');
  await expect(tool.locator('code')).toHaveText('npm run build -- --watch');

  const stopBtn = page.getByTestId('next-stall-stop');
  await expect(stopBtn).toBeVisible();
  await expect(stopBtn).toHaveText('停止');

  // 2. Click stop: strip disappears, composer returns to sendable
  await stopBtn.click();
  await expect(strip).toHaveCount(0);

  const input = page.getByTestId('next-composer-input');
  await expect(input).toBeEnabled();
  await expect(page.getByTestId('next-send')).toBeVisible();

  await expectClean(state);
});

test('c-rich has no stall strip', async ({ page }) => {
  const state = await openProto(page);
  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);

  // c-rich has subagent strip but NO stall strip
  await expect(page.getByTestId('next-stall-strip')).toHaveCount(0);
  await expect(page.getByTestId('next-agents-strip')).toBeVisible();

  await expectClean(state);
});

test('stall strip and agents strip stack correctly without inner border-radius when both present', async ({ page }) => {
  const state = await openProto(page);
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);

  // c-site-1 seed is stalled and has an unended subagent; no mock flow auto-advances.
  const stallStrip = page.getByTestId('next-stall-strip');
  const agentsStrip = page.getByTestId('next-agents-strip');
  await expect(stallStrip).toBeVisible();
  await expect(agentsStrip).toBeVisible();

  // Check DOM order: stallStrip comes immediately before agentsStrip
  const isImmediatelyBefore = await page.evaluate(() => {
    const stall = document.querySelector('[data-testid="next-stall-strip"]');
    const agents = document.querySelector('[data-testid="next-agents-strip"]');
    return stall && agents && stall.nextElementSibling === agents;
  });
  expect(isImmediatelyBefore).toBe(true);

  // Check border-radius: .stall-strip + .agents-strip has 0 border-radius
  const agentsRadius = await page.evaluate(() => {
    const agents = document.querySelector('[data-testid="next-agents-strip"]');
    if (!agents) return '';
    const style = window.getComputedStyle(agents);
    return `${style.borderTopLeftRadius} ${style.borderTopRightRadius}`;
  });
  expect(agentsRadius).toBe('0px 0px');

  // Stall strip preserves rounded top corners (18px for unified card)
  const stallRadius = await page.evaluate(() => {
    const stall = document.querySelector('[data-testid="next-stall-strip"]');
    if (!stall) return '';
    const style = window.getComputedStyle(stall);
    return `${style.borderTopLeftRadius} ${style.borderTopRightRadius}`;
  });
  expect(stallRadius).toBe('18px 18px');

  await expectClean(state);
});

test('new activity in stalled conversation dismisses the stall strip', async ({ page }) => {
  const state = await openProto(page);
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);

  const strip = page.getByTestId('next-stall-strip');
  await expect(strip).toBeVisible();

  // Send a message into the stalled conversation
  const input = page.getByTestId('next-composer-input');
  await input.fill('继续更新文案');
  await page.getByTestId('next-send').click();

  // New activity dismisses stall strip
  await expect(strip).toHaveCount(0, { timeout: 10_000 });
  await expectClean(state);
});

test('composer card and status strips align perfectly as one card across c-rich, c-site-1, and c-site-2', async ({ page }) => {
  const state = await openProto(page);

  async function assertCardAlignment(options) {
    const { expectStall, expectAgents } = options;
    const composerBox = page.getByTestId('next-composer');
    await expect(composerBox).toBeVisible();
    const boxRect = await composerBox.boundingBox();
    expect(boxRect).not.toBeNull();

    const whereChip = page.locator('[data-testid="next-composer-where"] [data-testid="next-ws-chip"]');
    await expect(whereChip).toBeVisible();
    const chipRect = await whereChip.boundingBox();
    expect(chipRect).not.toBeNull();
    // where-bar first chip left edge aligns with composer-box (tolerance <= 1px)
    expect(Math.abs(chipRect.x - boxRect.x)).toBeLessThanOrEqual(1);

    if (expectStall) {
      const stallStrip = page.getByTestId('next-stall-strip');
      await expect(stallStrip).toBeVisible();
      const stallRect = await stallStrip.boundingBox();
      expect(stallRect).not.toBeNull();
      // stall-strip left and right edges match composer-box (tolerance <= 1px)
      expect(Math.abs(stallRect.x - boxRect.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((stallRect.x + stallRect.width) - (boxRect.x + boxRect.width))).toBeLessThanOrEqual(1);

      const stallRadius = await stallStrip.evaluate((el) => {
        const s = window.getComputedStyle(el);
        return `${s.borderTopLeftRadius} ${s.borderTopRightRadius}`;
      });
      expect(stallRadius).toBe('18px 18px');
    } else {
      await expect(page.getByTestId('next-stall-strip')).toHaveCount(0);
    }

    if (expectAgents) {
      const agentsStrip = page.getByTestId('next-agents-strip');
      await expect(agentsStrip).toBeVisible();
      const agentsRect = await agentsStrip.boundingBox();
      expect(agentsRect).not.toBeNull();
      // agents-strip left and right edges match composer-box (tolerance <= 1px)
      expect(Math.abs(agentsRect.x - boxRect.x)).toBeLessThanOrEqual(1);
      expect(Math.abs((agentsRect.x + agentsRect.width) - (boxRect.x + boxRect.width))).toBeLessThanOrEqual(1);

      const agentsRadius = await agentsStrip.evaluate((el) => {
        const s = window.getComputedStyle(el);
        return `${s.borderTopLeftRadius} ${s.borderTopRightRadius}`;
      });
      // If stall is present, agents-strip top radius is 0; if stall is absent, agents-strip top radius is 18px
      if (expectStall) {
        expect(agentsRadius).toBe('0px 0px');
      } else {
        expect(agentsRadius).toBe('18px 18px');
      }
    } else {
      await expect(page.getByTestId('next-agents-strip')).toHaveCount(0);
    }

    // composer-box top radius is 0 if any strip is present; bottom radius is always 18px
    const boxRadius = await composerBox.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return `${s.borderTopLeftRadius} ${s.borderTopRightRadius} ${s.borderBottomRightRadius} ${s.borderBottomLeftRadius}`;
    });
    if (expectStall || expectAgents) {
      expect(boxRadius).toBe('0px 0px 18px 18px');
    } else {
      expect(boxRadius).toBe('18px 18px 18px 18px');
    }
  }

  // 1. Check c-rich (only sub-agent strip)
  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  await assertCardAlignment({ expectStall: false, expectAgents: true });

  // 2. Check c-site-1 (both stall strip and agents strip)
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);
  await assertCardAlignment({ expectStall: true, expectAgents: true });

  // 3. Check c-site-2 (only stall strip)
  await page.locator('[data-testid=next-conv-row][data-id="c-site-2"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-2$/);
  await assertCardAlignment({ expectStall: true, expectAgents: false });

  await expectClean(state);
});

test('composer card highlights only when text input is focused, not when status strip buttons are focused', async ({ page }) => {
  const state = await openProto(page);

  // Visit c-site-1: has stall strip with stop button and subagents strip
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);

  const card = page.getByTestId('next-composer-card');
  const input = page.getByTestId('next-composer-input');
  const stallStop = page.getByTestId('next-stall-stop');

  await expect(card).toBeVisible();
  await expect(input).toBeVisible();
  await expect(stallStop).toBeVisible();

  // Initially card is not focused
  await expect(card).not.toHaveClass(/is-focused/);

  // 1. Focus text input: card is highlighted (has .is-focused)
  await input.focus();
  await expect(card).toHaveClass(/is-focused/);

  // 2. Focus stall stop button: card is NOT highlighted
  await stallStop.focus();
  await expect(card).not.toHaveClass(/is-focused/);
  const isStopFocused = await stallStop.evaluate((el) => document.activeElement === el);
  expect(isStopFocused).toBe(true);

  // 3. Expand agents strip and focus subagent stop button: card is NOT highlighted
  const agentsToggle = page.getByTestId('next-agents-strip-toggle');
  await agentsToggle.click();
  const agentsStop = page.getByTestId('next-agents-strip-stop').first();
  await expect(agentsStop).toBeVisible();

  await agentsStop.focus();
  await expect(card).not.toHaveClass(/is-focused/);
  const isAgentsStopFocused = await agentsStop.evaluate((el) => document.activeElement === el);
  expect(isAgentsStopFocused).toBe(true);

  await expectClean(state);
});
