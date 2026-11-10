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
  await expect(msgBody).toHaveCSS('font-size', '16px');
  await expect(inlineCode).toHaveCSS('border-top-width', '0px');

  await page.locator('[data-testid=next-pref-font] button[data-size="lg"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'lg');
  await expect(msgBody).toHaveCSS('font-size', '17px');

  await page.locator('[data-testid=next-pref-lang] button[data-lang="en"]').click();
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('General');
  await expect(page.getByTestId('next-settings-nav-providers')).toHaveText('Models');
  await page.locator('[data-testid=next-pref-lang] button[data-lang="zh"]').click();
  await expect(page.getByTestId('next-settings-nav-general')).toHaveText('通用');
  await expect(page.getByTestId('next-settings-nav-providers')).toHaveText('模型服务');

  expectClean(state);
});

test('general: chat width options standard, wide, wider, full strictly increase width and persist across reload', async ({ page }) => {
  const state = await openProto(page);
  expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
  await expect(page.locator('.next-shell')).toHaveClass(/right-closed/);
  await expect(page.getByTestId('next-right')).toBeHidden();

  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();

  const thread = page.locator('.thread-inner');
  const composer = page.locator('.composer-stack');
  await expect(thread).toBeVisible();
  await expect(composer).toBeVisible();

  /** @type {number[]} */
  const recordedWidths = [];
  const options = ['standard', 'wide', 'wider', 'full'];

  for (const opt of options) {
    await page.locator(`[data-testid=next-pref-chat-width] button[data-width="${opt}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-chat-width', opt);
    await expect(page.locator(`[data-testid=next-pref-chat-width] button[data-width="${opt}"]`)).toHaveClass(/is-on/);

    const threadBox = await thread.boundingBox();
    const composerBox = await composer.boundingBox();
    expect(threadBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(Math.abs(threadBox.width - composerBox.width)).toBeLessThan(1);
    recordedWidths.push(threadBox.width);
  }

  // Four widths must be strictly ascending
  for (let i = 1; i < recordedWidths.length; i++) {
    expect(recordedWidths[i]).toBeGreaterThan(recordedWidths[i - 1]);
  }

  // Close settings overlay before reloading
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);

  // Reload page and verify chosen width is preserved
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-chat-width', 'full');

  const reloadedThreadBox = await page.locator('.thread-inner').boundingBox();
  const reloadedComposerBox = await page.locator('.composer-stack').boundingBox();
  expect(reloadedThreadBox).not.toBeNull();
  expect(reloadedComposerBox).not.toBeNull();
  expect(Math.abs(reloadedThreadBox.width - reloadedComposerBox.width)).toBeLessThan(1);
  expect(Math.abs(reloadedThreadBox.width - recordedWidths[3])).toBeLessThan(1);

  // Re-open settings and verify option remains selected
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await expect(page.locator('[data-testid=next-pref-chat-width] button[data-width="full"]')).toHaveClass(/is-on/);

  expectClean(state);
});

test('providers: rows, groups, expand, custom add/edit, cancel rollback, no 服务商', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();

  const rows = page.getByTestId('next-provider-row');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('DeepSeek');
  await expect(rows.nth(1)).toContainText('Anthropic');
  await expect(rows.nth(1)).toContainText('k7Qa');
  const dsRow = rows.filter({ hasText: '自建 DeepSeek' });
  const glmRow = rows.filter({ hasText: '智谱 GLM' });
  const gwRow = rows.filter({ hasText: '内网网关' });
  await expect(dsRow).toBeVisible();
  await expect(glmRow).toBeVisible();
  await expect(gwRow).toBeVisible();

  // T100-2: Custom provider icons: DeepSeek, ChatGLM, plug
  await expect(dsRow.locator('.mp-av .brand-icon img')).toHaveAttribute('src', /DeepSeek/);
  await expect(glmRow.locator('.mp-av .brand-icon img')).toHaveAttribute('src', /ChatGLM/);
  await expect(gwRow.locator('.mp-av .brand-icon .brand-icon-plug')).toBeVisible();

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

  const flashRow = page.locator('[data-testid=next-model-row][data-model="deepseek-flash"]');
  await expect(flashRow).toBeVisible();
  await expect(flashRow).toContainText('DeepSeek V4.1 Flash');
  await expect(flashRow).not.toContainText('deepseek-flash');
  await expect(flashRow.locator('.mp-mt-name')).toHaveAttribute('title', 'deepseek-flash');
  const modelToggle = flashRow.getByTestId('next-model-toggle');
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

  // Expand '内网网关' to check its model icons
  await gwRow.click();
  const qwenModelRow = page.locator('[data-testid=next-model-row][data-model="qwen3-coder-480b"]');
  const glmModelRow = page.locator('[data-testid=next-model-row][data-model="glm-5.2-fp8"]');
  const internalModelRow = page.locator('[data-testid=next-model-row][data-model="my-internal-model"]');
  await expect(qwenModelRow.locator('.mp-mt-name .brand-icon img')).toHaveAttribute('src', /Qwen/);
  await expect(glmModelRow.locator('.mp-mt-name .brand-icon img')).toHaveAttribute('src', /ChatGLM/);
  await expect(internalModelRow.locator('.mp-mt-name .brand-icon .brand-icon-plug')).toBeVisible();
  await gwRow.click();

  // Cancel rollback: cancel must close dialog. customOnly shows only the custom card.

  await page.getByTestId('next-provider-add').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await expect(page.locator('[data-testid=next-vendor-card]')).toHaveCount(1);
  await expect(page.locator('[data-testid=next-vendor-card][data-vendor="custom"]')).toBeVisible();
  const addClose = page.getByTestId('next-add-close');
  await expect(addClose).toHaveCSS('border-style', 'none');
  const addCloseBox = await addClose.boundingBox();
  // 28px CSS × --ui-zoom 0.9 → 25.2 visual (Playwright boundingBox)
  expect(Math.abs((addCloseBox?.width ?? 0) - 25.2)).toBeLessThan(1);
  expect(Math.abs((addCloseBox?.height ?? 0) - 25.2)).toBeLessThan(1);
  await page.getByTestId('next-add-cancel').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);
  await expect(rows).toHaveCount(5);

  // 验证未设为全局默认的提供商编辑时默认模型显示「未选择」
  const gatewayRow = rows.filter({ hasText: '内网网关' });
  await gatewayRow.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-edit').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await expect(page.getByTestId('next-add-model-dropdown')).toContainText('未选择');
  await page.getByTestId('next-add-cancel').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);

  // Custom: 新建自定义端点 → 编辑改名（默认模型不变）→ 编辑把图片改成支持、再改回跟随模型
  await page.getByTestId('next-provider-add').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await page.getByTestId('next-custom-name').fill('Local vLLM');
  await page.getByTestId('next-custom-url').fill('http://127.0.0.1:8000/v1');
  await page.getByTestId('next-add-test').click();
  await expect(page.getByTestId('next-add-model-dropdown')).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('next-add-images-dropdown')).toContainText('跟随模型');
  await expect(page.getByTestId('next-add-thinking-dropdown')).toContainText('跟随模型');
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);
  await expect(rows).toHaveCount(6);
  await expect(rows.filter({ hasText: 'Local vLLM' })).toBeVisible();

  // 编辑改名（默认模型不变）
  const customRow = rows.filter({ hasText: 'Local vLLM' });
  await customRow.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-edit').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await page.getByTestId('next-custom-name').fill('Local vLLM Renamed');
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);
  await expect(rows.filter({ hasText: 'Local vLLM Renamed' })).toBeVisible();
  await expect(page.getByTestId('next-provider-default-picker')).toContainText('llama3.3:70b');

  // 编辑把图片改成支持
  const renamedRow = rows.filter({ hasText: 'Local vLLM Renamed' });
  await renamedRow.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-edit').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await expect(page.getByTestId('next-add-images-dropdown')).toContainText('跟随模型');
  await page.getByTestId('next-add-images-dropdown').click();
  await page.getByTestId('next-add-images-option-supported').click();
  await expect(page.getByTestId('next-add-images-dropdown')).toContainText('支持');
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);

  // 再改回跟随模型
  await renamedRow.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-edit').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();
  await expect(page.getByTestId('next-add-images-dropdown')).toContainText('支持');
  await page.getByTestId('next-add-images-dropdown').click();
  await page.getByTestId('next-add-images-option-follow').click();
  await expect(page.getByTestId('next-add-images-dropdown')).toContainText('跟随模型');
  await page.getByTestId('next-provider-finish').click();
  await expect(page.getByTestId('next-add-dialog')).toHaveCount(0);

  // 删除
  await renamedRow.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(rows.filter({ hasText: 'Local vLLM Renamed' })).toHaveCount(0);
  await expect(rows).toHaveCount(5);

  expectClean(state);
});

test('deleting all providers shows the no-model state', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();
  await expect(page.getByTestId('next-provider-row')).toHaveCount(5);

  // Delete all seeded providers
  for (let i = 0; i < 5; i++) {
    await page.getByTestId('next-provider-row').first().getByTestId('next-provider-more').click();
    await page.getByTestId('next-provider-delete').click();
    await page.getByTestId('next-confirm-ok').click();
  }
  await expect(page.getByTestId('next-provider-row')).toHaveCount(0);
  await expect(page.getByTestId('next-provider-default-picker')).toBeDisabled();

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

  // Plugins: toggle the first row (Ask, sorted by name), import another.
  await page.getByTestId('next-settings-nav-plugins').click();
  await expect(page.getByTestId('next-plugin-row')).toHaveCount(4);
  const firstRow = page.getByTestId('next-plugin-row').first();
  await expect(firstRow).toHaveAttribute('data-id', 'ask');
  await expect(page.locator('[data-testid=next-plugin-row][data-id="broken-loader"]').getByTestId('next-plugin-fail')).toContainText('找不到插件 main');
  const firstSwitch = firstRow.getByTestId('next-plugin-toggle');
  await expect(firstSwitch).toHaveAttribute('aria-pressed', 'true');
  await firstSwitch.click();
  await expect(firstSwitch).toHaveAttribute('aria-pressed', 'false');
  await firstSwitch.click();
  await expect(firstSwitch).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('next-plugin-path').fill('C:\\work\\plugins\\lint-helper');
  await page.getByTestId('next-plugin-import').click();
  await expect(page.getByTestId('next-plugin-row')).toHaveCount(5);
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
  await expect(page.getByTestId('next-settings-about')).not.toContainText('致谢');

  expectClean(state);
});

test('dropdown alignment under default zoom: default picker (downward & right-aligned) and edit dialog thinking (upward & left-aligned)', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-providers').click();

  // ① 默认模型选择器（向下展开，右对齐）
  const picker = page.getByTestId('next-provider-default-picker');
  await expect(picker).toBeVisible();
  const pickerBox = await picker.boundingBox();
  expect(pickerBox).not.toBeNull();

  await picker.click();
  const pickerMenu = page.locator('.mp-menu');
  await expect(pickerMenu).toBeVisible();
  const pickerMenuBox = await pickerMenu.boundingBox();
  expect(pickerMenuBox).not.toBeNull();

  // 向下展开时 |menu.y - (trigger.y+trigger.height)| ≤ 6
  expect(Math.abs(pickerMenuBox.y - (pickerBox.y + pickerBox.height))).toBeLessThanOrEqual(6);
  // 右对齐时 |(menu.x+menu.width) - (trigger.x+trigger.width)| ≤ 2
  expect(Math.abs((pickerMenuBox.x + pickerMenuBox.width) - (pickerBox.x + pickerBox.width))).toBeLessThanOrEqual(2);

  // 关闭默认模型选择器
  await page.keyboard.press('Escape');
  await expect(pickerMenu).toHaveCount(0);

  // ② 编辑对话框「默认思考」下拉（向上展开，左对齐）
  const customRow = page.getByTestId('next-provider-row').filter({ hasText: '内网网关' });
  await customRow.getByTestId('next-provider-more').click();
  await page.getByTestId('next-provider-edit').click();
  await expect(page.getByTestId('next-add-dialog')).toBeVisible();

  // 打开「默认思考」下拉
  const thinkingBtn = page.getByTestId('next-add-thinking-dropdown');
  await expect(thinkingBtn).toBeVisible();
  const thinkingBox = await thinkingBtn.boundingBox();
  expect(thinkingBox).not.toBeNull();

  await thinkingBtn.click();
  const thinkingMenu = page.getByTestId('next-add-thinking-menu');
  await expect(thinkingMenu).toBeVisible();
  const thinkingMenuBox = await thinkingMenu.boundingBox();
  expect(thinkingMenuBox).not.toBeNull();

  const viewport = page.viewportSize();
  expect(thinkingMenuBox.y).toBeGreaterThanOrEqual(0);
  expect(thinkingMenuBox.y + thinkingMenuBox.height).toBeLessThanOrEqual(viewport.height);

  // 向上展开时 |(menu.y+menu.height) - trigger.y| ≤ 6
  expect(Math.abs((thinkingMenuBox.y + thinkingMenuBox.height) - thinkingBox.y)).toBeLessThanOrEqual(6);
  // 左对齐时 |menu.x - trigger.x| ≤ 2
  expect(Math.abs(thinkingMenuBox.x - thinkingBox.x)).toBeLessThanOrEqual(2);

  expectClean(state);
});

test('general: the earlier-start line follows the compaction trigger', async ({ page }) => {
  const state = await openProto(page);
  await page.getByTestId('next-open-settings').click();
  const input = page.getByTestId('next-pref-compact-trigger');
  const hint = page.getByTestId('next-pref-compact-effective');
  await expect(input).toHaveValue('80');
  await expect(hint).toContainText('部分模型会更早开始');
  await expect(hint).toContainText('70%');

  await input.fill('60');
  await input.press('Enter');
  await expect(hint).toHaveCount(0);

  await input.fill('90');
  await input.press('Enter');
  await expect(hint).toContainText('部分模型会更早开始');
  const title = await hint.getAttribute('title');
  expect(title).toContain('qwen2.5-coder-32b 70%');
  expect(title).toContain('DeepSeek-V3.2 71%');
  expectClean(state);
});
