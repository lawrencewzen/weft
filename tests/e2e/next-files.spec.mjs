import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, prepareWorkspaces } from './helpers/server.mjs';
import {
  loginNext,
  openNextChat,
  openWorkspaceConversation,
  sendNext,
  waitRunDone,
} from './helpers/next.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const NOTES = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join('\n');

async function writeScript(root, turns) {
  const scriptPath = path.join(root, 'next-files.json');
  await fs.writeFile(scriptPath, JSON.stringify({ turns }));
  return scriptPath;
}

async function revealFile(page, filePath) {
  const fileNode = page.locator(`[data-testid=next-file-node][data-path="${filePath}"]`);
  if (await fileNode.isVisible().catch(() => false)) return fileNode;
  const parts = filePath.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join('/');
    const dirNode = page.locator(`[data-testid=next-file-node][data-path="${dir}"]`);
    await expect(dirNode).toBeVisible({ timeout: 15000 });
    if (!(await fileNode.isVisible().catch(() => false))) await dirNode.click();
  }
  await expect(fileNode).toBeVisible({ timeout: 15000 });
  return fileNode;
}

async function boot(page, extraEnv = {}, turns) {
  const prepared = await prepareWorkspaces(['ws']);
  const wsDir = prepared.dirs[0];
  const scriptPath = turns
    ? await writeScript(prepared.root, turns)
    : path.join(prepared.root, 'unused.json');
  if (turns) await writeScript(prepared.root, turns);
  const srv = await startServer({
    extraEnv: {
      WEFT_WORKSPACE_ROOT: prepared.root,
      ...(turns ? { WEFT_FAUX_SCRIPT: scriptPath } : {}),
      ...extraEnv,
    },
  });
  const { ws, conv } = await openWorkspaceConversation(srv, 'demo', wsDir);
  await openNextChat(page, srv, conv.id);
  return { srv, ws, conv, wsDir, prepared };
}

test('FL-1 write shows in the changes diff', async ({ page }) => {
  const { srv, wsDir } = await boot(page, {}, [
    { tool: 'write', args: { path: 'notes/today.md', content: '今日\nQA-FILE-1\n' } },
    { text: '写好了。' },
  ]);
  try {
    await sendNext(page, '写 notes/today.md');
    await expect(page.getByTestId('next-item-assistant').filter({ hasText: '写好了。' })).toBeVisible({ timeout: 20000 });
    await waitRunDone(page);
    await expect(page.getByTestId('next-right')).toBeVisible();
    await page.getByTestId('next-right-tab-changes').click();
    const row = page.locator('[data-testid=next-change-row][data-path="notes/today.md"]');
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.locator('.changed-file-pill').click();
    const diff = page.locator('[data-testid=next-diff][data-path="notes/today.md"]');
    await expect(diff).toBeVisible();
    await expect(diff).toContainText('今日');
    await expect(diff).toContainText('QA-FILE-1');
    await expect(await fs.readFile(path.join(wsDir, 'notes/today.md'), 'utf8')).toContain('QA-FILE-1');
  } finally {
    await srv.kill();
  }
});

test('FL-2 files tab opens the written markdown', async ({ page }) => {
  const { srv } = await boot(page, {}, [
    { tool: 'write', args: { path: 'notes/today.md', content: '今日\nQA-FILE-1\n' } },
    { text: '写好了。' },
  ]);
  try {
    await sendNext(page, '写 notes/today.md');
    await waitRunDone(page);
    await page.getByTestId('next-right-tab-files').click();
    await expect(page.getByTestId('next-file-tree')).toBeVisible();
    await expect(page.locator('[data-testid=next-file-node][data-path="notes"]')).toBeVisible({ timeout: 15000 });
    await (await revealFile(page, 'notes/today.md')).click();
    await expect(page.getByTestId('next-file-view')).toContainText('QA-FILE-1');
    await expect(page.getByTestId('next-file-open-editor')).toHaveCount(1);
    await expect(page.locator('.tabs-actions')).not.toContainText(/编辑|Edit/);
  } finally {
    await srv.kill();
  }
});

test('FL-3 markdown edit save survives reload and updates the diff', async ({ page }) => {
  const { srv, wsDir } = await boot(page, {}, [
    { tool: 'write', args: { path: 'notes/today.md', content: '今日\nQA-FILE-1\n' } },
    { text: '写好了。' },
  ]);
  try {
    await sendNext(page, '写 notes/today.md');
    await waitRunDone(page);
    await page.getByTestId('next-right-tab-files').click();
    await (await revealFile(page, 'notes/today.md')).click();
    await expect(page.getByTestId('next-file-view')).toContainText('QA-FILE-1');
    await page.getByTestId('next-file-open-editor').click();
    const editor = page.getByTestId('next-file-editor').locator('textarea');
    await expect(editor).toBeVisible();
    const current = await editor.inputValue();
    await editor.fill(`${current.replace(/\n$/, '')}\nQA-EDIT-2\n`);
    await page.getByTestId('next-file-save').click();
    await expect(page.getByTestId('next-toast')).toContainText(/已保存|Saved/);
    await expect(editor).toHaveValue(/QA-EDIT-2/);
    await expect(await fs.readFile(path.join(wsDir, 'notes/today.md'), 'utf8')).toContain('QA-EDIT-2');

    await page.reload();
    await expect(page.getByTestId('next-thread')).toBeVisible();
    await page.getByTestId('next-right-tab-files').click();
    await (await revealFile(page, 'notes/today.md')).click();
    await expect(page.getByTestId('next-file-view')).toContainText('QA-EDIT-2');

    await page.getByTestId('next-right-tab-changes').click();
    const row = page.locator('[data-testid=next-change-row][data-path="notes/today.md"]');
    await expect(row).toBeVisible();
    await row.locator('.changed-file-pill').click();
    await expect(page.getByTestId('next-diff')).toContainText('QA-EDIT-2');
    await expect(row.locator('.stat-add')).not.toHaveText('+0');
  } finally {
    await srv.kill();
  }
});

test('FL-4 tool results refresh the file tree while still running', async ({ page }) => {
  const { srv, wsDir } = await boot(page, {}, [
    { tool: 'write', args: { path: 'live/qa-file-live.txt', content: 'QA-LIVE-1\n' } },
    { text: '写好了。' },
    { tool: 'bash', args: { command: "printf 'QA-LIVE-BASH\\n' > live/qa-file-bash.txt" } },
    { text: 'bash 写好了。' },
  ]);
  try {
    await page.getByTestId('next-right-tab-files').click();
    await expect(page.getByTestId('next-file-tree')).toBeVisible();
    await sendNext(page, '写 live/qa-file-live.txt');
    const writeGroup = page.getByTestId('next-tool-group').first();
    await expect(writeGroup).toBeVisible({ timeout: 20000 });
    await writeGroup.getByTestId('next-tool-group-summary').click();
    await expect(page.locator('[data-testid=next-tool-row][data-tool=write][data-path="live/qa-file-live.txt"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[data-testid=next-file-node][data-path="live"]')).toBeVisible({ timeout: 15000 });
    await revealFile(page, 'live/qa-file-live.txt');
    await waitRunDone(page);
    await expect(page.locator('[data-testid=next-file-node][data-path="live/qa-file-live.txt"]')).toBeVisible();

    await sendNext(page, '用 bash 写 live/qa-file-bash.txt');
    await expect(page.getByTestId('next-tool-group')).toHaveCount(2, { timeout: 20000 });
    const bashGroup = page.getByTestId('next-tool-group').nth(1);
    await bashGroup.getByTestId('next-tool-group-summary').click();
    await expect(bashGroup.locator('[data-testid=next-tool-row][data-tool=bash]')).toBeVisible({ timeout: 20000 });
    await revealFile(page, 'live/qa-file-bash.txt');
    await waitRunDone(page);
    await (await revealFile(page, 'live/qa-file-live.txt')).click();
    await expect(page.getByTestId('next-file-view')).toContainText('QA-LIVE-1');
    await page.getByTestId('next-right-tab-changes').click();
    await page.getByTestId('next-right-tab-files').click();
    await expect(page.locator('[data-testid=next-file-node][data-path="live/qa-file-live.txt"]')).toBeVisible();
    await expect(page.locator('[data-testid=next-file-node][data-path="live/qa-file-bash.txt"]')).toBeVisible();
    await expect(await fs.readFile(path.join(wsDir, 'live/qa-file-live.txt'), 'utf8')).toContain('QA-LIVE-1');
    await expect(await fs.readFile(path.join(wsDir, 'live/qa-file-bash.txt'), 'utf8')).toContain('QA-LIVE-BASH');
  } finally {
    await srv.kill();
  }
});

test('FL-5 reverting a new file to the empty baseline drops it from the changes list', async ({ page }) => {
  const { srv } = await boot(page, {}, [
    { tool: 'write', args: { path: 'notes/today.md', content: '今日\nQA-FILE-1\n' } },
    { text: '写好了。' },
  ]);
  try {
    await sendNext(page, '写 notes/today.md');
    await waitRunDone(page);
    await page.getByTestId('next-right-tab-changes').click();
    const row = page.locator('[data-testid=next-change-row][data-path="notes/today.md"]');
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row.locator('.stat-add')).not.toHaveText('+0');

    await page.getByTestId('next-right-tab-files').click();
    await (await revealFile(page, 'notes/today.md')).click();
    await page.getByTestId('next-file-open-editor').click();
    const editor = page.getByTestId('next-file-editor').locator('textarea');
    await expect(editor).toBeVisible();
    await editor.fill('');
    await page.getByTestId('next-file-save').click();
    await expect(page.getByTestId('next-toast')).toContainText(/已保存|Saved/);

    await page.getByTestId('next-right-tab-changes').click();
    await expect(row).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId('next-right-tab-changes').locator('.tab-stat')).toHaveCount(0);
    await expect(page.getByTestId('next-right')).toContainText(/暂无变更|No changes yet|无变更|No changes/);
  } finally {
    await srv.kill();
  }
});

async function ellipsisBox(locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      textOverflow: style.textOverflow,
      overflow: style.overflow,
      whiteSpace: style.whiteSpace,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    };
  });
}

test('FL-6 long filenames truncate with a full-path title in changes and the file tree', async ({ page }) => {
  const longName = 'test_long_filename_confirmation.py';
  const { srv } = await boot(page, {}, [
    { tool: 'write', args: { path: longName, content: 'print("ok")\n' } },
    { text: '写好了。' },
  ]);
  try {
    await sendNext(page, `写 ${longName}`);
    await waitRunDone(page);
    await page.locator('.col-right').evaluate((el) => {
      el.style.width = '240px';
      el.style.setProperty('--panel-w', '240px');
    });

    await page.getByTestId('next-right-tab-changes').click();
    const changeRow = page.locator(`[data-testid=next-change-row][data-path="${longName}"]`);
    await expect(changeRow).toBeVisible({ timeout: 15000 });
    await expect(changeRow.locator('.changed-file-pill')).toHaveAttribute('title', longName);
    const changeName = changeRow.locator('.changed-file-path');
    const changeBox = await ellipsisBox(changeName);
    expect(changeBox.textOverflow).toBe('ellipsis');
    expect(changeBox.whiteSpace).toBe('nowrap');
    expect(changeBox.scrollWidth).toBeGreaterThan(changeBox.clientWidth);

    await page.getByTestId('next-right-tab-files').click();
    const fileNode = await revealFile(page, longName);
    await expect(fileNode).toHaveAttribute('title', longName);
    const treeName = fileNode.locator('.file-tree-name');
    const treeBox = await ellipsisBox(treeName);
    expect(treeBox.textOverflow).toBe('ellipsis');
    expect(treeBox.whiteSpace).toBe('nowrap');
    expect(treeBox.scrollWidth).toBeGreaterThan(treeBox.clientWidth);

    const treeScroll = await page.getByTestId('next-file-tree').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(treeScroll.scrollWidth).toBeLessThanOrEqual(treeScroll.clientWidth + 1);
  } finally {
    await srv.kill();
  }
});

test('an edit row opens the file diff in the right pane', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({ script: 'tool-edit.json', extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '改');
    await expect(page.getByTestId('next-item-assistant').filter({ hasText: '改好了。' })).toBeVisible({ timeout: 20000 });
    const summaries = page.getByTestId('next-tool-group-summary');
    const n = await summaries.count();
    for (let i = 0; i < n; i += 1) await summaries.nth(i).click();
    const row = page.locator('[data-testid=next-tool-row][data-tool=edit]');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('next-tool-row-detail')).toHaveCount(0);
    await row.click();
    const diff = page.locator('[data-testid=next-diff][data-path="note.txt"]');
    await expect(diff).toBeVisible();
    await expect(diff).toContainText('hello world');
  } finally {
    await srv.kill();
  }
});

test('clicking a path chip opens the file at that line', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const wsDir = prepared.dirs[0];
  await fs.writeFile(path.join(wsDir, 'notes.txt'), `${NOTES}\n`);
  const scriptPath = await writeScript(prepared.root, [
    { text: '请看 `notes.txt:3` 和 `missing.nope:1`。' },
  ]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: scriptPath, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', wsDir);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '看这两个路径');
    await waitRunDone(page);
    const chip = page.locator('code.md-path[data-path="notes.txt"]');
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toHaveAttribute('data-line', '3');
    await chip.click();
    await expect(page.getByTestId('next-right-tab-files')).toHaveClass(/active/);
    const preview = page.getByTestId('next-file-view');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('line-3');
    const target = preview.locator('.file-line.is-target');
    await expect(target).toHaveCount(1);
    await expect(target.locator('.n')).toHaveText('3');
    await expect(target.locator('.code')).toHaveText('line-3');
  } finally {
    await srv.kill();
  }
});

test('a forged ../../etc/passwd chip only hits the files API and toasts', async ({ page }) => {
  const prepared = await prepareWorkspaces(['repo']);
  const wsDir = prepared.dirs[0];
  await fs.writeFile(path.join(wsDir, 'notes.txt'), `${NOTES}\n`);
  const scriptPath = await writeScript(prepared.root, [{
    text: '请看 `notes.txt`。\n\n'
      + '<code class="md-path" data-path="../../etc/passwd">../../etc/passwd</code>',
  }]);
  const srv = await startServer({
    extraEnv: { WEFT_FAUX_SCRIPT: scriptPath, WEFT_WORKSPACE_ROOT: prepared.root },
  });
  const bad = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('etc/passwd')) return;
    if (!/\/api\/v2\/workspaces\/[^/]+\/files\?/.test(url)) bad.push(url);
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', wsDir);
    await openNextChat(page, srv, conv.id);
    await sendNext(page, '看路径');
    await waitRunDone(page);
    const forged = page.locator('code.md-path[data-path="../../etc/passwd"]');
    await expect(forged).toBeVisible({ timeout: 15000 });
    await forged.click();
    await expect(page.getByTestId('next-toast')).toContainText(/无法打开|cannot be opened/i);
    expect(bad, 'no request besides the workspace files API').toEqual([]);
  } finally {
    await srv.kill();
  }
});

test('saving an edited file updates the changes tab counts', async ({ page }) => {
  const { srv } = await boot(page, {}, [
    { tool: 'write', args: { path: 'notes/today.md', content: '今日\nQA-FILE-1\n' } },
    { text: '写好了。' },
  ]);
  try {
    await sendNext(page, '写 notes/today.md');
    await waitRunDone(page);
    const stat = page.getByTestId('next-right-tab-changes').locator('.tab-stat');
    await expect(stat.locator('.add')).toBeVisible();
    const beforeAdd = await stat.locator('.add').textContent();
    await page.getByTestId('next-right-tab-files').click();
    await (await revealFile(page, 'notes/today.md')).click();
    await page.getByTestId('next-file-open-editor').click();
    const editor = page.getByTestId('next-file-editor').locator('textarea');
    const current = await editor.inputValue();
    await editor.fill(`${current}extra-line\n`);
    await page.getByTestId('next-file-save').click();
    await expect(page.getByTestId('next-toast')).toContainText(/已保存|Saved/);
    await page.getByTestId('next-right-tab-changes').click();
    await expect(stat.locator('.add')).not.toHaveText(beforeAdd || '+0', { timeout: 10000 });
    await expect(stat.locator('.del')).toHaveText(/−\d+/);
  } finally {
    await srv.kill();
  }
});

test('a 409 conflict offers overwrite and reload', async ({ page }) => {
  const { srv, wsDir } = await boot(page, {}, [
    { tool: 'write', args: { path: 'notes/today.md', content: '今日\nQA-FILE-1\n' } },
    { text: '写好了。' },
  ]);
  try {
    await sendNext(page, '写 notes/today.md');
    await waitRunDone(page);
    await page.getByTestId('next-right-tab-files').click();
    await (await revealFile(page, 'notes/today.md')).click();
    await page.getByTestId('next-file-open-editor').click();
    const editor = page.getByTestId('next-file-editor').locator('textarea');
    await editor.fill('mine-overwrite\n');
    await fs.writeFile(path.join(wsDir, 'notes/today.md'), 'disk-changed\n');
    await page.getByTestId('next-file-save').click();
    await expect(page.getByTestId('next-file-conflict')).toBeVisible();
    await page.getByTestId('next-file-overwrite').click();
    await expect(page.getByTestId('next-file-conflict')).toHaveCount(0, { timeout: 10000 });
    // The conflict box goes away on click, before the PUT finishes: poll instead of
    // reading once, which raced with the server's truncate-then-write (empty file).
    await expect
      .poll(() => fs.readFile(path.join(wsDir, 'notes/today.md'), 'utf8'))
      .toBe('mine-overwrite\n');

    await editor.fill('mine-reload\n');
    await fs.writeFile(path.join(wsDir, 'notes/today.md'), 'disk-again\n');
    await page.getByTestId('next-file-save').click();
    await expect(page.getByTestId('next-file-conflict')).toBeVisible();
    await page.getByTestId('next-file-reload').click();
    await expect(page.getByTestId('next-file-conflict')).toHaveCount(0, { timeout: 10000 });
    await expect(editor).toHaveValue('disk-again\n');
  } finally {
    await srv.kill();
  }
});

test('below 1180px the right pane starts collapsed without horizontal scroll', async ({ page }) => {
  const prepared = await prepareWorkspaces(['narrow']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root } });
  try {
    await page.setViewportSize({ width: 1179, height: 800 });
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await expect(page.getByTestId('next-thread')).toBeVisible();
    // Closed overlay panels stay in the tree (no display:none); assert they are not visible.
    await expect(page.getByTestId('next-right')).toBeHidden();
    await expect(page.getByTestId('next-right-toggle')).toBeVisible();
    const box = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScroll: document.body.scrollWidth,
    }));
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.bodyScroll).toBeLessThanOrEqual(box.clientWidth + 1);
  } finally {
    await srv.kill();
  }
});
