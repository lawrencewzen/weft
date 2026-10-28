import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { loginNext, openWorkspaceConversation } from './helpers/next.mjs';
import { prepareWorkspaces, startServer } from './helpers/server.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 90_000 });

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function pasteImage(page, name = 'screenshot.png') {
  await page.getByTestId('next-composer-input').focus();
  await page.evaluate(async ({ name, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const file = new File([bytes], name, { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector('[data-testid="next-composer-input"]');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: dt });
    el.dispatchEvent(event);
  }, { name, b64: PNG_B64 });
}

test('pastes an image, sends it, and keeps the thumbnail after reload', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await expect(page.getByTestId('next-composer-input')).toBeVisible();
    await pasteImage(page);
    await expect(page.getByTestId('next-attach-image')).toBeVisible();
    await expect(page.getByTestId('next-attach-image')).toContainText('screenshot.png');
    await page.getByTestId('next-composer-input').fill('看这张图');
    await page.getByTestId('next-send').click();
    await expect(page.getByTestId('next-item-user').first()).toContainText('看这张图');
    await expect(page.getByTestId('next-user-image')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('next-user-image')).toBeVisible();
    await page.getByTestId('next-user-image').click();
    await expect(page.getByTestId('next-image-lightbox')).toBeVisible();
  } finally {
    await srv.kill();
  }
});

test('image-only send is allowed', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await pasteImage(page, 'only.png');
    await expect(page.getByTestId('next-attach-image')).toContainText('only.png');
    await expect(page.getByTestId('next-send')).toHaveClass(/is-ready/);
    await page.getByTestId('next-send').click();
    await expect(page.getByTestId('next-user-image')).toBeVisible();
    await expect(page.getByTestId('next-item-user').first()).toBeVisible();
  } finally {
    await srv.kill();
  }
});

test('over-limit paste stays in the composer as a hint', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    await page.getByTestId('next-composer-input').focus();
    await page.evaluate(() => {
      const file = new File([new Uint8Array(5 * 1024 * 1024 + 8)], 'huge.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector('[data-testid="next-composer-input"]');
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      el.dispatchEvent(event);
    });
    await expect(page.getByTestId('next-composer-hint')).toContainText('5MB');
    await expect(page.getByTestId('next-attach-image')).toHaveCount(0);
    await expect(page.getByTestId('next-send')).not.toHaveClass(/is-ready/);
  } finally {
    await srv.kill();
  }
});

test('composer @ file selection and sending with @path', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
  const dir = prepared.dirs[0];
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# test project\n');
  writeFileSync(join(dir, 'src', 'app.ts'), 'console.log("hello");\n');

  const srv = await startServer({
    script: 'no-usage.json',
    extraEnv: { WEFT_WORKSPACE_ROOT: prepared.root },
  });
  try {
    const { conv } = await openWorkspaceConversation(srv, 'demo', prepared.dirs[0]);
    await loginNext(page, srv);
    await page.goto(`${srv.url}/c/${encodeURIComponent(conv.id)}`);
    const input = page.getByTestId('next-composer-input');
    await expect(input).toBeVisible();

    // 1. When there is no match (e.g. @zzzz), pressing Enter should NOT send a message
    await input.focus();
    await input.pressSequentially('@zzzz');
    const atMenu = page.getByTestId('next-composer-at-menu');
    await expect(atMenu).toBeVisible();
    await expect(page.getByTestId('next-composer-at-empty')).toBeVisible();
    const userMsgsBefore = await page.getByTestId('next-item-user').count();
    await input.press('Enter');
    // Popup stays open, message count remains unchanged
    await expect(atMenu).toBeVisible();
    await expect(page.getByTestId('next-item-user')).toHaveCount(userMsgsBefore);

    // 2. Clear input and trigger file popup
    await input.fill('');
    await expect(atMenu).toHaveCount(0);

    await input.focus();
    await input.pressSequentially('@');
    await expect(atMenu).toBeVisible();
    const firstItem = page.getByTestId('next-composer-at-item').first();
    await expect(firstItem).toBeVisible();

    // Select the first file with Enter
    await input.press('Enter');
    await expect(page.getByTestId('next-attach-file')).toBeVisible();

    // Send the message
    await page.getByTestId('next-send').click();
    const userMsg = page.getByTestId('next-item-user').first();
    await expect(userMsg).toBeVisible();
    await expect(userMsg).toContainText('@');
  } finally {
    await srv.kill();
  }
});
