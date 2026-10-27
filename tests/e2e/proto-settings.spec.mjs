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

  await page.locator('[data-testid=next-pref-font] button[data-size="lg"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'lg');

  await page.locator('[data-testid=next-pref-lang] button[data-lang="en"]').click();
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('General');
  await expect(page.getByTestId('next-settings-nav-providers')).toHaveText('Provider');
  await page.locator('[data-testid=next-pref-lang] button[data-lang="zh"]').click();
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('通用');

  expectClean(state);
});

test('providers: wizard, failing probe, Grok device login, default and context window', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(1);

  // Step 1 vendor → step 2 key + probe → step 3 models.
  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor="openai"]').click();
  await page.locator('.ns-foot-acts .ns-btn-primary').click();

  await page.getByTestId('next-key-input').fill('bad-key');
  await page.getByTestId('next-provider-test').click();
  await expect(page.getByTestId('next-test-result')).toHaveClass(/is-bad/);
  await expect(page.getByTestId('next-test-result')).toContainText('bad');
  await page.getByTestId('next-key-input').fill('sk-demo-1234');
  await page.getByTestId('next-provider-test').click();
  await expect(page.getByTestId('next-test-result')).toHaveClass(/is-ok/);

  await page.locator('.ns-foot-acts .ns-btn-primary').click();
  await expect(page.getByTestId('next-model-row').first()).toBeVisible();
  await page.locator('[data-testid=next-model-row][data-model="gpt-5"] .ns-switch').click();
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(2);
  await expect(page.getByTestId('next-provider-row').last()).toContainText('OpenAI');

  // Edit the new provider's name.
  await page.getByTestId('next-provider-row').last().getByTestId('next-provider-edit').click();
  await page.getByTestId('next-provider-name').fill('OpenAI 备用');
  await page.locator('.ns-foot-acts .ns-btn-primary').click();
  await expect(page.getByTestId('next-model-row').first()).toBeVisible();
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-provider-row').last()).toContainText('OpenAI 备用');

  // Grok device-code login: code shown, then it signs in and offers its model.
  await page.getByTestId('next-settings-nav-providers').click();
  await page.getByTestId('next-provider-add').click();
  await page.locator('[data-testid=next-vendor-card][data-vendor="grok"]').click();
  await page.locator('.ns-foot-acts .ns-btn-primary').click();
  await expect(page.getByTestId('next-grok-code')).toContainText('WEFT-DEMO');
  await expect(page.getByTestId('next-model-row').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid=next-model-row][data-model="grok-build"]')).toBeVisible();
  await page.locator('[data-testid=next-model-row][data-model="grok-build"] .ns-switch').click();
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(3);
  await expect(page.getByTestId('next-provider-row').last()).toContainText('Grok');

  // Default model.
  await page.getByTestId('next-default-model').click();
  await page.locator('.ns-pop-item').filter({ hasText: 'Grok Build' }).click();
  await expect(page.getByTestId('next-default-model')).toContainText('Grok Build');

  // Context window (composer chip) hits PUT /context-window.
  await page.locator('.next-settings-close').click();
  await page.getByTestId('next-context-chip').click();
  await expect(page.getByTestId('next-context-menu')).toBeVisible();
  await page.getByTestId('next-context-option').first().click();
  const put = (await state.requests()).filter(
    (row) => row.method === 'PUT' && row.url.includes('/context-window'),
  );
  expect(put.length).toBeGreaterThan(0);
  await expect(page.getByTestId('next-context-menu')).toHaveCount(0);

  expectClean(state);
});

test('deleting the only provider shows the no-model state', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(1);
  await page.getByTestId('next-provider-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(0);

  await page.locator('.next-settings-close').click();
  await expect(page.getByTestId('next-no-model')).toBeVisible();
  await expect(page.getByTestId('next-no-model-connect')).toBeVisible();
  await expect(page.getByTestId('next-composer-input')).toBeDisabled();
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
  await expect(page.getByTestId('next-plugin-fail').first()).toContainText('加载失败');
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
