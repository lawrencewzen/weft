import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * After switching the prototype to English, chrome copy (buttons, labels,
 * placeholders, titles) must not contain Chinese. Conversation bodies, code,
 * and user / model / entity names are excluded.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

const HAN = /[\u4e00-\u9fff]/;

const EXCLUDE_SEL = [
  '[data-testid="next-item-user"]',
  '[data-testid="next-item-assistant"]',
  '[data-testid="next-item-system-note"]',
  '[data-testid="next-auto-continue-note"]',
  '[data-testid="next-item-subagent-report"]',
  '[data-testid="next-subagent-report"]',
  '[data-testid="next-tool-group-list"]',
  '[data-testid="next-dispatch-card"]',
  '[data-testid="next-change-summary"]',
  'pre',
  'code',
  '.code-block-card',
  '.sb-conv-title',
  '.conv-node-title',
  '.sb-proj-name',
  '.ws-node-title',
  '.top-title',
  '.search-result-title',
  '.search-result-project',
  '.ns-ext-desc',
  '.ns-ext-mark',
  '.ns-ext-card-top > b',
  '.ns-git-name > b',
  '[data-testid="next-provider-row"] .mp-pn-name > span:first-child',
  '[data-testid="next-file-node"]',
  '[data-testid="next-change-row"]',
  '[data-testid="next-diff"]',
  '[data-testid="next-change-summary-row"]',
  '[data-testid="next-agents-strip-name"]',
  '[data-testid="next-agents-strip-doing"]',
  '[data-testid="next-agents-strip-detail"]',
  '[data-testid="next-agents-strip-step"]',
  '.md-path',
  '.model-chip-name',
  '.model-menu-title',
  '.ws-chip-path',
  '[data-testid="next-change-by"]',
  '.composer-queue-text',
].join(',');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} [rootSel]
 * @returns {Promise<string[]>}
 */
async function chromeStrings(page, rootSel = '[data-testid="next-app"]') {
  return page.evaluate(({ excludeSel, rootSel: root }) => {
    const host = document.querySelector(root);
    if (!host) return [];
    const out = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const el = node.parentElement;
      const text = String(node.textContent || '').trim();
      node = walker.nextNode();
      if (!text || !el) continue;
      if (el.closest(excludeSel)) continue;
      out.push(text);
    }
    for (const el of host.querySelectorAll('[placeholder], [title], [aria-label]')) {
      if (el.closest(excludeSel)) continue;
      // Conversation row `title` is the user-given chat title.
      if (el.closest('[data-testid="next-conv-row"]')) continue;
      for (const attr of ['placeholder', 'title', 'aria-label']) {
        const value = el.getAttribute(attr);
        if (value && value.trim()) out.push(value.trim());
      }
    }
    return out;
  }, { excludeSel: EXCLUDE_SEL, rootSel });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} label
 * @param {string} [rootSel]
 */
async function assertNoChineseChrome(page, label, rootSel) {
  const strings = await chromeStrings(page, rootSel);
  const hits = strings.filter((s) => HAN.test(s));
  expect(hits, `${label}: ${hits.slice(0, 15).join(' | ')}`).toEqual([]);
}

test('english UI chrome has no Chinese on the main surfaces', async ({ page }) => {
  const state = await openProto(page);

  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await page.locator('[data-testid=next-pref-lang] button[data-lang="en"]').click();
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('General');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const settingsPages = [
    ['general', 'next-settings-general'],
    ['providers', 'next-provider-page'],
    ['git', 'next-settings-git'],
    ['plugins', 'next-settings-plugins'],
    ['skills', 'next-settings-skills'],
    ['about', 'next-settings-about'],
  ];
  for (const [id, testId] of settingsPages) {
    await page.getByTestId(`next-settings-nav-${id}`).click();
    await expect(page.getByTestId(testId)).toBeVisible();
    await assertNoChineseChrome(page, `settings ${id}`, '[data-testid="next-settings"]');
  }

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);

  // Conversation page (default seeded chat) + T67 Chats section
  await expect(page.getByTestId('next-composer-input')).toBeVisible();
  await expect(page.getByTestId('next-chats-section')).toHaveText('Chats');
  await assertNoChineseChrome(page, 'conversation');

  // New chat: pick No project (T67)
  await page.getByTestId('next-new-chat').click();
  await expect(page).toHaveURL(/\/new/);
  await expect(page.getByTestId('next-draft-hint')).toBeVisible();
  const heroChip = page.getByTestId('next-draft-hero-ws');
  await expect(heroChip).toBeVisible();
  await heroChip.click();
  await expect(page.getByTestId('next-draft-hero-menu')).toBeVisible();
  const noneOpt = page.locator('[data-testid=next-ws-chip-option][data-id="__none__"]');
  await expect(noneOpt).toContainText('No project');
  await assertNoChineseChrome(page, 'project chip menu');
  await noneOpt.click();
  await expect(page.getByTestId('next-draft-hint')).toContainText('What should we do?');
  await expect(heroChip).toContainText('No project');
  await assertNoChineseChrome(page, 'new chat no project');

  // ⌘K search
  await page.getByTestId('next-search').click();
  await expect(page.getByTestId('next-search-modal')).toBeVisible();
  await assertNoChineseChrome(page, 'search');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-search-modal')).toHaveCount(0);

  // Model menu (thinking + context) on a seeded conversation
  await page.locator('[data-testid=next-conv-row][data-id="c-rich"]').click();
  await expect(page).toHaveURL(/#\/c\/c-rich$/);
  const modelChip = page.getByTestId('next-model-chip');
  await expect(modelChip).toBeVisible();
  await modelChip.click();
  const menu = page.getByTestId('next-model-menu');
  await expect(menu).toBeVisible();
  await page.getByTestId('next-menu-thinking').hover();
  await expect(page.getByTestId('next-sub-thinking')).toBeVisible();
  await assertNoChineseChrome(page, 'model thinking menu');
  await page.getByTestId('next-menu-context').hover();
  await expect(page.getByTestId('next-sub-context')).toBeVisible();
  await assertNoChineseChrome(page, 'model context menu');
  await page.keyboard.press('Escape');

  // Right pane tabs
  await page.getByTestId('next-right-tab-changes').click();
  await assertNoChineseChrome(page, 'right tab changes');
  await page.getByTestId('next-right-tab-files').click();
  await assertNoChineseChrome(page, 'right tab files');
  await page.getByTestId('next-right-tab-term').click();
  await assertNoChineseChrome(page, 'right tab terminal');

  // Sub-agent strip expanded
  const strip = page.getByTestId('next-agents-strip');
  await expect(strip).toBeVisible();
  if ((await strip.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('next-agents-strip-toggle').click();
  }
  await expect(strip).toHaveAttribute('data-open', 'true');
  await assertNoChineseChrome(page, 'agents strip expanded');

  // Stall strip on c-site-1
  const websiteNode = page.locator('[data-testid=next-ws-node][data-id="ws-website"]');
  if (await websiteNode.locator('.sb-conv-list').isHidden()) {
    await websiteNode.getByTestId('next-ws-toggle').click();
  }
  await page.locator('[data-testid=next-conv-row][data-id="c-site-1"]').click();
  await expect(page).toHaveURL(/#\/c\/c-site-1$/);
  await expect(page.getByTestId('next-stall-strip')).toBeVisible();
  await assertNoChineseChrome(page, 'stall strip');

  // Empty project list: Add project row (T67)
  await page.getByTestId('proto-clear-projects').click();
  await expect(page.getByTestId('next-ws-empty-add')).toBeVisible();
  await expect(page.getByTestId('next-ws-empty-add')).toContainText('Add project');
  await expect(page.getByTestId('next-chats-section')).toHaveText('Chats');
  await expect(page.getByTestId('next-ws-chip')).toContainText('No project');
  await expect(page.getByTestId('next-draft-hint')).toContainText('What should we do?');
  await assertNoChineseChrome(page, 'empty projects add row');

  expectClean(state);
});
