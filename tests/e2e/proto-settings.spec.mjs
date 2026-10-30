import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

/**
 * Settings: every page is usable against the in-browser backend. Failure paths
 * are deterministic: a Provider key starting with `bad` fails the probe, a Git
 * token starting with `bad` fails the connection test, and a plugin path
 * containing `bad` fails to load.
 */
test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('opening settings keeps the conversation behind the overlay', async ({ page }) => {
  const state = await openProto(page);
  await expect(page.getByTestId('next-status')).toContainText('重构会话列表的加载逻辑');
  await expect(page.getByTestId('next-item-assistant').first()).toBeVisible();
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await expect(page.getByTestId('next-status')).toContainText('重构会话列表的加载逻辑');
  await expect(page.getByTestId('next-status')).not.toContainText(/加载中|Loading/);
  await expect(page.getByTestId('next-item-assistant').first()).toBeVisible();
  await expect(page.getByTestId('next-change-summary')).toBeVisible();
  expectClean(state);
});

test('general: language, appearance, theme and font size apply immediately', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();

  await page.locator('[data-testid=next-pref-appearance] button[data-mode="dark"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark$/);
  await page.locator('[data-testid=next-pref-appearance] button[data-mode="light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light$/);

  await page.locator('[data-testid=next-pref-theme] button[data-family="claude"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^claude-/);
  await page.locator('[data-testid=next-pref-theme] button[data-family="white"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^white-/);

  const msgBody = page.locator('[data-testid=next-item-assistant] .msg-body').first();
  const inlineCode = page.locator('.msg-body code:not(pre code)').first();
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'md');
  await expect(msgBody).toHaveCSS('font-size', '14.5px');
  await expect(inlineCode).toHaveCSS('border-top-width', '0px');

  await page.locator('[data-testid=next-pref-font] button[data-size="lg"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'lg');
  await expect(msgBody).toHaveCSS('font-size', '15.5px');

  await page.locator('[data-testid=next-pref-lang] button[data-lang="en"]').click();
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('General');
  await expect(page.getByTestId('next-settings-nav-providers')).toHaveText('Models');
  await page.locator('[data-testid=next-pref-lang] button[data-lang="zh"]').click();
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('通用');
  await expect(page.getByTestId('next-settings-nav-providers')).toHaveText('模型服务');

  expectClean(state);
});

test('providers: rows, groups, expand, Grok auto-detect, Anthropic key, custom, cancel rollback, no 服务商', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();

  const rows = page.getByTestId('next-provider-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('DeepSeek');
  await expect(rows.nth(1)).toContainText('内网网关');
  await expect(page.getByTestId('next-provider-group')).toHaveCount(1);
  await expect(page.locator('[data-testid=next-provider-group][data-group="apikey"]')).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('服务商');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('接入 Provider');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('点一行展开');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('新对话使用');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('只保存在本机');
  await expect(page.getByTestId('next-provider-page')).not.toContainText('上下文接口没返回');

  const testBtns = page.getByTestId('next-provider-test');
  const box0 = await testBtns.nth(0).boundingBox();
  const box1 = await testBtns.nth(1).boundingBox();
  expect(box0).not.toBeNull();
  expect(box1).not.toBeNull();
  expect(Math.round(box0.x)).toBe(Math.round(box1.x));

  await expect(page.locator('[data-testid=next-model-row][data-model="deepseek-flash"]')).toBeVisible();
  const modelToggle = page.locator('[data-testid=next-model-row][data-model="deepseek-flash"] [data-testid=next-model-toggle]');
  const hadOn = await modelToggle.evaluate((el) => el.classList.contains('mp-on'));
  await modelToggle.click();
  await expect(modelToggle).toHaveClass(hadOn ? /^mp-sw(?!.*mp-on)/ : /mp-sw mp-on/);

  const ctxVal = page.locator('[data-testid=next-model-row][data-model="deepseek-flash"] .mp-num .mp-v').first();
  await ctxVal.click();
  const ctxInput = page.getByTestId('next-ctx-input');
  await expect(ctxInput).toBeVisible();
  await ctxInput.fill('500K');
  await ctxInput.press('Enter');
  await expect(page.locator('[data-testid=next-model-row][data-model="deepseek-flash"] .mp-num .mp-v').first()).toHaveText('500K');

  // Cancel rollback: Grok auto-connects, cancel must DELETE
  await page.getByTestId('next-provider-add').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await expect(page.locator('[data-testid=next-vendor-card][data-vendor="xai"]')).toBeVisible();
  const addClose = page.getByTestId('next-add-close');
  await expect(addClose).toHaveCSS('border-style', 'none');
  const addCloseBox = await addClose.boundingBox();
  expect(addCloseBox?.width).toBe(28);
  expect(addCloseBox?.height).toBe(28);
  await expect(page.getByTestId('next-model-dropdown')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('next-add-cancel').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);
  await expect(rows).toHaveCount(2);

  // Grok auto-detect → dropdown → create
  await page.getByTestId('next-provider-add').click();
  await expect(page.getByTestId('next-model-dropdown')).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('next-detected-check')).toBeVisible();
  await page.getByTestId('next-model-dropdown').click();
  await expect(page.getByTestId('next-model-option').first()).toBeVisible();
  await expect(page.getByTestId('next-model-option').first()).not.toHaveText(/grok-/i);
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'Grok' })).toBeVisible();
  await expect(page.locator('[data-testid=next-provider-group][data-group="builtin"]')).toBeVisible();

  // Anthropic: fill Key → 测试 → dropdown → create
  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor="anthropic"]').click();
  await page.getByTestId('next-key-input').fill('sk-demo-1234');
  await page.getByTestId('next-add-test').click();
  await expect(page.getByTestId('next-model-dropdown')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('next-provider-finish').click();
  await expect(rows.filter({ hasText: 'Anthropic' })).toBeVisible();

  // Custom
  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor="custom"]').click();
  await page.getByTestId('next-custom-name').fill('Local vLLM');
  await page.getByTestId('next-custom-url').fill('http://127.0.0.1:8000/v1');
  await page.getByTestId('next-add-test').click();
  await expect(page.getByTestId('next-model-dropdown')).toBeEnabled({ timeout: 10_000 });
  await page.getByTestId('next-provider-finish').click();
  await expect(rows.filter({ hasText: 'Local vLLM' })).toBeVisible();

  const rowToRemove = rows.filter({ hasText: 'Local vLLM' });
  await rowToRemove.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(rows.filter({ hasText: 'Local vLLM' })).toHaveCount(0);

  expectClean(state);
});

test('deleting all providers shows the no-model state', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(2);

  // Delete all seeded providers
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('next-provider-row').first().getByTestId('next-provider-more').click();
    await page.getByTestId('next-provider-delete').click();
    await page.getByTestId('next-confirm-ok').click();
  }
  await expect(page.getByTestId('next-provider-row')).toHaveCount(0);

  await page.locator('.next-settings-close').click();
  await expect(page.getByTestId('next-no-model')).toBeVisible();
  await expect(page.getByTestId('next-no-model-connect')).toBeVisible();

  // c-rich is seeded running (T51-7), so the round button is Stop. The idle
  // no-model send control is on c-docs.
  await page.locator('[data-testid=next-conv-row][data-id="c-docs"]').click();
  await expect(page.getByTestId('next-no-model')).toBeVisible();
  await expect(page.getByTestId('next-no-model-connect')).toBeVisible();
  await expect(page.getByTestId('next-composer-input')).toBeDisabled();
  await expect(page.getByTestId('next-composer-input')).toHaveAttribute(
    'placeholder',
    /先接入一个模型|Connect a model/,
  );
  await expect(page.getByTestId('next-composer-attach')).toHaveCount(0);
  await expect(page.getByTestId('next-send')).toBeDisabled();
  await page.getByTestId('next-no-model-connect').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();
  await expect(page.getByTestId('next-provider-add')).toBeVisible();

  expectClean(state);
});

test('git connections, plugins, skills and about', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();

  // Git: failed test with a bad token, then success, then edit and delete.
  await page.getByTestId('next-settings-nav-git').click();
  await expect(page.getByTestId('next-git-row')).toHaveCount(2);
  await page.getByTestId('next-git-add').click();
  await page.getByTestId('next-git-name').fill('本地 GitLab');
  await page.getByTestId('next-git-url').fill('http://gitlab.dev.local');
  await page.getByTestId('next-git-token').fill('bad-token');
  await page.getByTestId('next-git-test').click();
  await expect(page.getByTestId('next-git-test-result')).toContainText('拒绝');
  await page.getByTestId('next-git-token').fill('glpat-ok-1234');
  await page.getByTestId('next-git-test').click();
  await expect(page.getByTestId('next-git-test-result')).toContainText('lawrence');
  await page.getByTestId('next-git-save').click();
  await expect(page.getByTestId('next-git-row')).toHaveCount(3);
  const row = page.getByTestId('next-git-row').filter({ hasText: '本地 GitLab' });
  await row.getByTestId('next-git-row-test').click();
  await expect(row).toContainText('lawrence');
  await row.getByTestId('next-git-edit').click();
  await page.getByTestId('next-git-name').fill('本地 GitLab（改）');
  await page.getByTestId('next-git-save').click();
  const renamed = page.getByTestId('next-git-row').filter({ hasText: '（改）' });
  await expect(renamed).toBeVisible();
  await renamed.getByTestId('next-git-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(page.getByTestId('next-git-row')).toHaveCount(2);

  // Plugins: toggle one, import another.
  await page.getByTestId('next-settings-nav-plugins').click();
  await expect(page.getByTestId('next-plugin-row')).toHaveCount(3);
  await expect(page.getByTestId('next-plugin-fail').first()).toContainText('找不到插件 main');
  const firstSwitch = page.getByTestId('next-plugin-row').first().getByTestId('next-plugin-toggle');
  await firstSwitch.click();
  await expect(firstSwitch).toHaveAttribute('aria-pressed', 'false');
  await firstSwitch.click();
  await expect(firstSwitch).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('next-plugin-path').fill('C:\\work\\plugins\\lint-helper');
  await page.getByTestId('next-plugin-import').click();
  await expect(page.getByTestId('next-plugin-row')).toHaveCount(4);
  await expect(page.getByTestId('next-plugin-row').filter({ hasText: 'lint-helper' })).toBeVisible();

  // Skills: add, toggle, delete; the bundled one is read-only.
  await page.getByTestId('next-settings-nav-skills').click();
  await expect(page.getByTestId('next-skill-row')).toHaveCount(2);
  await expect(page.locator('[data-testid=next-skill-row][data-id="code-review"]').getByTestId('next-skill-delete')).toHaveCount(0);
  await page.getByTestId('next-skill-add').click();
  await page.getByTestId('next-skill-name').fill('提交信息整理');
  await page.getByTestId('next-skill-desc').fill('按改动整理提交信息');
  await page.getByTestId('next-skill-body').fill('# 步骤\n1. 看 diff\n');
  await page.getByTestId('next-skill-save').click();
  const created = page.locator('[data-testid=next-skill-row][data-id="提交信息整理"]');
  await expect(created).toBeVisible();
  await expect(page.getByTestId('next-skill-row')).toHaveCount(3);
  await created.getByTestId('next-skill-toggle').click();
  await expect(created.getByTestId('next-skill-toggle')).toHaveAttribute('aria-pressed', 'false');
  await created.getByTestId('next-skill-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(page.getByTestId('next-skill-row')).toHaveCount(2);

  // About.
  await page.getByTestId('next-settings-nav-about').click();
  await expect(page.getByTestId('next-about-version')).toHaveText('0.1.0-prototype');
  await expect(page.getByTestId('next-about-protocol')).toHaveText('2.0.0');

  expectClean(state);
});
