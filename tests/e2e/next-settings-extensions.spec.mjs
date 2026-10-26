import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import { loginNext } from './helpers/next.mjs';
import { startFakeGitlab } from '../helpers/fake-gitlab.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });

const PAT = 'glpat-e2e-secret-9k3q';
const BAD = 'glpat-e2e-secret-bad1';
const SKILL_BODY = '当用户发送「口令检查」时，只回复一行 `PING-SKILL-947`，不要加别的文字。其他问题不要使用本 Skill。';

let gitlab;
let srv;

test.afterEach(async () => {
  await srv?.kill();
  srv = null;
  gitlab?.close();
  gitlab = null;
});

function watchSecrets(page, secrets) {
  const leaked = [];
  page.on('response', async (res) => {
    const type = res.headers()['content-type'] || '';
    if (!/json|text|xml|javascript/i.test(type)) return;
    let text = '';
    try { text = await res.text(); } catch { return; }
    for (const secret of secrets) {
      if (secret && text.includes(secret)) leaked.push(`${res.url()} :: ${secret}`);
    }
  });
  return leaked;
}

async function boot(page, extraEnv = {}) {
  const prepared = await prepareWorkspaces(['alpha']);
  srv = await startServer({
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root, ...extraEnv },
  });
  await loginNext(page, srv);
  return prepared;
}

async function openSettingsNav(page, id) {
  if (await page.getByTestId('next-settings').count() === 0) {
    await page.getByTestId('next-open-settings').click();
    await expect(page.getByTestId('next-settings')).toBeVisible();
  }
  await page.getByTestId(`next-settings-nav-${id}`).click();
}

async function closeSettings(page) {
  if (await page.getByTestId('next-settings').count() === 0) return;
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('next-settings')).toHaveCount(0);
}

function pluginRow(page, name) {
  return page.getByTestId('next-plugin-row').filter({ hasText: name });
}

function skillRow(page, name) {
  return page.getByTestId('next-skill-row').filter({ hasText: name });
}

function wsNode(page, name) {
  return page.getByTestId('next-ws-node').filter({ hasText: name });
}

test('git connection tests, imports a project, and never echoes the token', async ({ page }) => {
  test.setTimeout(180_000);
  gitlab = await startFakeGitlab({
    token: PAT,
    username: 'zhangsan',
    withGit: true,
    projects: [{
      id: 7,
      path: 'acme/widget',
      description: 'Widget service',
      defaultBranch: 'main',
      branches: [{ name: 'main', default: true }, { name: 'develop', default: false }],
    }],
  });
  await boot(page);
  const leaked = watchSecrets(page, [PAT, BAD]);

  await openSettingsNav(page, 'git');
  await expect(page.getByTestId('next-settings-git')).toBeVisible();
  await expect(page.getByTestId('next-git-empty')).toBeVisible();

  await page.getByTestId('next-git-add').click();
  await expect(page.getByTestId('next-git-drawer')).toBeVisible();
  await page.getByTestId('next-git-name').fill('内网 GitLab');
  await page.getByTestId('next-git-url').fill(gitlab.origin);
  await expect(page.getByTestId('next-git-token')).toHaveAttribute('type', 'password');
  await page.getByTestId('next-git-token').fill(PAT);
  await page.getByTestId('next-git-http').check();
  const link = page.locator('#git-token-link');
  await expect(link).toHaveText('去 GitLab 创建令牌');
  await expect(link).toHaveAttribute('href', `${gitlab.origin}/-/user_settings/personal_access_tokens`);
  const drawerText = await page.getByTestId('next-git-drawer').innerText();
  expect(drawerText).not.toContain('/-/user_settings/personal_access_tokens');
  expect(drawerText).not.toContain(PAT);

  await page.getByTestId('next-git-test').click();
  await expect(page.getByTestId('next-git-test-result')).toContainText('zhangsan');
  await expect(page.getByTestId('next-git-test-result')).toContainText('可以读取项目列表');
  await page.getByTestId('next-git-save').click();
  await expect(page.getByTestId('next-git-drawer')).toHaveCount(0);
  const row = page.getByTestId('next-git-row');
  await expect(row).toContainText('内网 GitLab');
  await expect(row).toContainText('••••');
  await expect(row).not.toContainText(PAT);
  await page.getByTestId('next-git-row-test').click();
  await expect(row).toContainText('已连接');
  await expect(row).toContainText('zhangsan');
  await expect(row).not.toContainText(PAT);
  await closeSettings(page);

  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  await page.getByTestId('next-ws-tab-git').click();
  await expect(page.getByTestId('next-git-project').filter({ hasText: 'acme/widget' })).toBeVisible();
  await page.getByTestId('next-git-search').fill('zzz-none');
  await expect(page.getByTestId('next-ws-dialog')).toContainText('没有匹配的项目');
  await page.getByTestId('next-git-search').fill('widget');
  await expect(page.getByTestId('next-git-project').filter({ hasText: 'acme/widget' })).toBeVisible();
  await page.getByTestId('next-git-project').filter({ hasText: 'acme/widget' }).click();
  await expect(page.getByTestId('next-git-import-name')).toHaveValue('widget');
  await expect(page.getByTestId('next-git-branch')).toContainText('main');
  await expect(page.getByTestId('next-git-branch')).toContainText('默认');
  await page.getByTestId('next-git-branch').click();
  await expect(page.getByTestId('next-git-branch-pop')).toBeVisible();
  await page.getByTestId('next-git-branch-pop').locator('button').filter({ hasText: 'main' }).click();
  await page.getByTestId('next-ws-create').click();
  await expect(wsNode(page, 'widget')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('next-draft-row')).toBeVisible();
  await expect(page).toHaveURL(/\/next\/w\/[^/]+\/new/);
  await expect(page.getByTestId('next-ws-dialog')).toHaveCount(0);

  await openSettingsNav(page, 'git');
  await page.getByTestId('next-git-edit').click();
  await expect(page.getByTestId('next-git-token')).toHaveValue('');
  await expect(page.getByTestId('next-git-token')).toHaveAttribute('type', 'password');
  await page.getByTestId('next-git-token').fill(BAD);
  await page.getByTestId('next-git-save').click();
  await expect(page.getByTestId('next-git-drawer')).toHaveCount(0);
  await closeSettings(page);

  await page.getByTestId('next-ws-new').click();
  await page.getByTestId('next-ws-tab-git').click();
  await expect(page.getByTestId('next-ws-dialog')).toContainText('认证失败');
  await expect(page.getByTestId('next-ws-dialog')).not.toContainText(BAD);
  await expect(page.getByTestId('next-ws-dialog')).not.toContainText(PAT);
  await page.getByTestId('next-ws-cancel').click();

  const html = await page.content();
  expect(html.includes(PAT), 'page html has no PAT').toBe(false);
  expect(html.includes(BAD), 'page html has no bad token').toBe(false);
  expect(leaked, 'network responses never include the git token').toEqual([]);
});

test('local folder browser creates a workspace and refuses out-of-range paths', async ({ page }) => {
  test.setTimeout(90_000);
  const prepared = await boot(page);
  fs.writeFileSync(path.join(prepared.dirs[0], 'hello.txt'), 'hello-ws\n');

  await page.getByTestId('next-ws-new').click();
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  await expect(page.getByTestId('next-ws-tab-local')).toHaveClass(/is-on/);
  await expect(page.getByTestId('next-dir-up')).toHaveCount(0);
  await expect(page.getByTestId('next-ws-path')).toHaveAttribute('readonly', '');
  const alpha = page.getByTestId('next-dir-row').filter({ hasText: 'alpha' });
  await expect(alpha).toBeVisible();
  await alpha.getByTestId('next-dir-choose').click();
  await expect(page.getByTestId('next-ws-path')).toHaveValue(prepared.dirs[0]);
  await expect(page.getByTestId('next-ws-name')).toHaveValue('alpha');
  await page.getByTestId('next-ws-name').fill('本地样本');

  await alpha.click();
  await expect(page.getByTestId('next-dir-up')).toBeVisible();
  await page.getByTestId('next-dir-up').click();
  await expect(page.getByTestId('next-dir-up')).toHaveCount(0);
  await expect(page.getByTestId('next-dir-row').filter({ hasText: 'alpha' })).toBeVisible();

  await page.getByTestId('next-ws-create').click();
  await expect(wsNode(page, '本地样本')).toBeVisible();
  await expect(page.getByTestId('next-draft-row')).toBeVisible();
  await expect(page).toHaveURL(/\/next\/w\/[^/]+\/new/);

  await page.getByTestId('next-ws-new').click();
  await page.getByTestId('next-ws-tab-git').click();
  await page.getByTestId('next-ws-source-address').click();
  await page.getByTestId('next-ws-name').fill('坏仓库');
  await page.getByTestId('next-ws-create').click();
  await expect(page.getByTestId('next-ws-error')).toHaveText('请填写 Git 仓库地址');
  await expect(page.getByTestId('next-ws-dialog')).toBeVisible();
  await expect(wsNode(page, '坏仓库')).toHaveCount(0);
});

test('plugins import, fail with server copy, and toggle', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page);
  await openSettingsNav(page, 'plugins');
  await expect(page.getByTestId('next-settings-plugins')).toBeVisible();
  const echo = pluginRow(page, 'Echo');
  await expect(echo).toBeVisible();
  await expect(echo).toContainText('返回传入的文本');
  await expect(echo).toContainText('echo');
  await expect(echo).toContainText('内置');
  await expect(echo).toContainText('0.1.0');
  await expect(echo.getByTestId('next-plugin-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(pluginRow(page, 'Word Count')).toHaveCount(0);
  await expect(pluginRow(page, 'Broken')).toHaveCount(0);

  await page.getByTestId('next-plugin-import').click();
  await expect(page.getByTestId('next-plugin-error')).toHaveText('请填写本机插件目录');

  await page.getByTestId('next-plugin-path').fill('examples/plugins/word-count');
  await page.getByTestId('next-plugin-import').click();
  await expect(pluginRow(page, 'Word Count')).toBeVisible();
  const word = pluginRow(page, 'Word Count');
  await expect(word).toContainText('统计工作区文本文件里的单词数');
  await expect(word).toContainText('word_count');
  await expect(word).toContainText('本地导入');
  await expect(word).toContainText('0.1.0');
  await expect(echo).toBeVisible();
  await expect(page.getByTestId('next-toast')).toContainText('Word Count');

  await page.getByTestId('next-plugin-path').fill('examples/plugins/broken');
  await page.getByTestId('next-plugin-import').click();
  await expect(page.getByTestId('next-plugin-error')).toHaveText('插件模块没有导出工具 broken_tool');
  await expect(pluginRow(page, 'Broken')).toHaveCount(0);
  await expect(word).toBeVisible();

  await echo.getByTestId('next-plugin-toggle').click();
  await expect(echo.getByTestId('next-plugin-toggle')).toHaveAttribute('aria-pressed', 'false');
  await echo.getByTestId('next-plugin-toggle').click();
  await expect(echo.getByTestId('next-plugin-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('skills can be created, edited, toggled, and only user skills deleted', async ({ page }) => {
  test.setTimeout(90_000);
  await boot(page);
  await openSettingsNav(page, 'skills');
  await expect(page.getByTestId('next-settings-skills')).toBeVisible();
  const commit = skillRow(page, 'Commit messages');
  const review = skillRow(page, 'Review notes');
  await expect(commit).toBeVisible();
  await expect(review).toBeVisible();
  await expect(commit.getByTestId('next-skill-delete')).toHaveCount(0);
  await expect(review.getByTestId('next-skill-delete')).toHaveCount(0);
  await expect(commit).toContainText('内置');

  await page.getByTestId('next-skill-add').click();
  await expect(page.getByTestId('next-skill-drawer')).toBeVisible();
  await page.getByTestId('next-skill-name').fill('口令');
  await page.getByTestId('next-skill-desc').fill('只在口令检查时使用');
  await page.getByTestId('next-skill-body').fill(SKILL_BODY);
  await page.getByTestId('next-skill-save').click();
  const passphrase = skillRow(page, '口令');
  await expect(passphrase).toBeVisible();
  await expect(passphrase).toContainText('只在口令检查时使用');
  await expect(passphrase).toContainText('用户');
  await expect(passphrase.getByTestId('next-skill-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(passphrase.getByTestId('next-skill-delete')).toBeVisible();

  await passphrase.getByTestId('next-skill-toggle').click();
  await expect(passphrase.getByTestId('next-skill-toggle')).toHaveAttribute('aria-pressed', 'false');
  await passphrase.getByTestId('next-skill-toggle').click();
  await expect(passphrase.getByTestId('next-skill-toggle')).toHaveAttribute('aria-pressed', 'true');

  await passphrase.getByTestId('next-skill-edit').click();
  await expect(page.getByTestId('next-skill-drawer')).toBeVisible();
  await page.getByTestId('next-skill-desc').fill('已改简介');
  await page.getByTestId('next-skill-save').click();
  await expect(passphrase).toContainText('已改简介');

  await passphrase.getByTestId('next-skill-delete').click();
  await expect(page.getByTestId('next-confirm')).toBeVisible();
  await expect(page.getByTestId('next-confirm')).toContainText('确认删除');
  await expect(page.getByTestId('next-confirm-message')).toHaveText('删除 Skill「口令」？');
  await page.getByTestId('next-confirm-cancel').click();
  await expect(page.getByTestId('next-confirm')).toHaveCount(0);
  await expect(passphrase).toBeVisible();

  await passphrase.getByTestId('next-skill-delete').click();
  await page.getByTestId('next-confirm-ok').click();
  await expect(skillRow(page, '口令')).toHaveCount(0);
  await expect(commit).toBeVisible();
  await expect(review).toBeVisible();
});
