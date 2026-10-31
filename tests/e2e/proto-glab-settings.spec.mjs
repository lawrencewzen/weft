import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('glab settings: enable switch, select two connections, pick default host, run test, and retain state', async ({ page }) => {
  const state = await openProto(page);

  // 打开设置
  await page.getByTestId('next-open-settings').click();
  await expect(page.getByTestId('next-settings')).toBeVisible();

  // 导航到 GitLab CLI
  await page.getByTestId('next-settings-nav-glab').click();
  await expect(page.getByTestId('next-settings-glab')).toBeVisible();

  // 初始状态：总开关关闭，连接区域禁用
  const enabledSwitch = page.getByTestId('next-glab-enabled');
  await expect(enabledSwitch).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.ns-glab-connections')).toHaveClass(/is-disabled/);

  // 打开总开关
  await enabledSwitch.click();
  await expect(enabledSwitch).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ns-glab-connections')).not.toHaveClass(/is-disabled/);

  // 此时列出 2 个连接
  const connCheckboxes = page.getByTestId('next-glab-conn');
  await expect(connCheckboxes).toHaveCount(2);

  // 勾选第一个连接，此时只勾选了 1 个，默认主机单选不出现
  await connCheckboxes.nth(0).check();
  await expect(connCheckboxes.nth(0)).toBeChecked();
  await expect(page.getByTestId('next-glab-default')).toHaveCount(0);

  // 勾选第二个连接，勾选多于一个时出现「默认主机」单选
  await connCheckboxes.nth(1).check();
  await expect(connCheckboxes.nth(1)).toBeChecked();
  const defaultRadios = page.getByTestId('next-glab-default');
  await expect(defaultRadios).toHaveCount(2);

  // 选默认主机（选择第二个连接作为默认主机）
  await defaultRadios.nth(1).check();
  await expect(defaultRadios.nth(1)).toBeChecked();

  // 点测试看到成功结果
  await page.getByTestId('next-glab-test').click();
  const testResult = page.getByTestId('next-glab-test-result');
  await expect(testResult).toBeVisible();
  await expect(testResult).toHaveClass(/is-ok/);
  await expect(testResult).toContainText('lawrence');

  // 切换页面再回来仍保留
  await page.getByTestId('next-settings-nav-general').click();
  await expect(page.getByTestId('next-settings-general')).toBeVisible();
  await page.getByTestId('next-settings-nav-glab').click();
  await expect(page.getByTestId('next-settings-glab')).toBeVisible();

  // 断言切换后状态依然保留
  await expect(page.getByTestId('next-glab-enabled')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('next-glab-conn').nth(0)).toBeChecked();
  await expect(page.getByTestId('next-glab-conn').nth(1)).toBeChecked();
  await expect(page.getByTestId('next-glab-default').nth(1)).toBeChecked();

  // 刷新后设置仍保留
  await page.reload();
  await page.getByTestId('next-open-settings').click();
  await page.getByTestId('next-settings-nav-glab').click();
  await expect(page.getByTestId('next-settings-glab')).toBeVisible();
  await expect(page.getByTestId('next-glab-enabled')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('next-glab-conn').nth(0)).toBeChecked();
  await expect(page.getByTestId('next-glab-conn').nth(1)).toBeChecked();
  await expect(page.getByTestId('next-glab-default').nth(1)).toBeChecked();

  expectClean(state);
});
