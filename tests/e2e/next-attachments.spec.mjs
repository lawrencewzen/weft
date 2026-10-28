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

test('uploads non-image file, displays tag, sends it, and renders file chip in thread', async ({ page }) => {
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

    const fileInput = page.getByTestId('next-composer-file-input');
    await fileInput.setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello attachment'),
    });

    const uploadTag = page.getByTestId('next-attach-upload');
    await expect(uploadTag).toBeVisible();
    await expect(uploadTag).toContainText('notes.txt');
    await expect(uploadTag).toHaveAttribute('data-status', 'done');

    await expect(page.getByTestId('next-send')).toHaveClass(/is-ready/);
    await page.getByTestId('next-send').click();

    const userMsg = page.getByTestId('next-item-user').first();
    await expect(userMsg).toBeVisible();
    const userFile = userMsg.getByTestId('next-user-file');
    await expect(userFile).toBeVisible();
    await expect(userFile).toContainText('notes.txt');
    const title = await userFile.getAttribute('title');
    expect(title).toContain('.weft/uploads');

    await page.reload();
    await expect(page.getByTestId('next-user-file')).toBeVisible();
    await expect(page.getByTestId('next-user-file')).toContainText('notes.txt');
  } finally {
    await srv.kill();
  }
});

test('pastes long text (128 lines), displays paste tag with peek popup, restore, and expand in thread', async ({ page }) => {
  const prepared = await prepareWorkspaces(['ws']);
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

    const lines128 = Array.from({ length: 128 }, (_, i) => `line ${i + 1}: ${'content'.repeat(5)}`).join('\n');

    // Paste long text
    await input.focus();
    await page.evaluate((val) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', val);
      const el = document.querySelector('[data-testid="next-composer-input"]');
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      el.dispatchEvent(event);
    }, lines128);

    // Should NOT enter textarea, but become a paste tag
    await expect(input).toHaveValue('');
    const pasteTag = page.getByTestId('next-attach-paste');
    await expect(pasteTag).toBeVisible();
    await expect(pasteTag).toContainText('128 行');

    // Click tag to open peek popup
    await pasteTag.click();
    const peek = page.getByTestId('next-paste-peek');
    await expect(peek).toBeVisible();
    await expect(page.getByTestId('next-paste-peek-head')).toContainText('line 1:');

    // Click restore: tag is removed, text is placed back into textarea
    await page.getByTestId('next-paste-peek-restore').click();
    await expect(pasteTag).toHaveCount(0);
    await expect(input).toHaveValue(lines128);

    // Clear input and paste again for sending
    await input.fill('');
    await page.evaluate((val) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', val);
      const el = document.querySelector('[data-testid="next-composer-input"]');
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      el.dispatchEvent(event);
    }, lines128);
    await expect(pasteTag).toBeVisible();

    // Send
    await page.getByTestId('next-send').click();

    // Thread shows user message with paste block
    const userMsg = page.getByTestId('next-item-user').first();
    await expect(userMsg).toBeVisible();
    const pasteBlock = userMsg.getByTestId('next-user-paste');
    await expect(pasteBlock).toBeVisible();
    await expect(pasteBlock).toContainText('128 行');
    const pasteText = pasteBlock.getByTestId('next-user-paste-text');
    await expect(pasteText).toHaveClass(/is-collapsed/);

    // Expand paste block
    await pasteBlock.getByTestId('next-user-paste-toggle').click();
    await expect(pasteText).toHaveClass(/is-expanded/);
    await expect(pasteText).toContainText('line 128:');

    // Collapse paste block
    await pasteBlock.getByTestId('next-user-paste-toggle').click();
    await expect(pasteText).toHaveClass(/is-collapsed/);
  } finally {
    await srv.kill();
  }
});

test('over-limit upload (>20MB) displays error state and blocks send', async ({ page }) => {
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

    // In browser, create a 21MB file and set to file input
    await page.evaluate(() => {
      const bytes = new Uint8Array(21 * 1024 * 1024);
      const file = new File([bytes], 'huge.bin', { type: 'application/octet-stream' });
      const input = document.querySelector('[data-testid="next-composer-file-input"]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const uploadTag = page.getByTestId('next-attach-upload');
    await expect(uploadTag).toBeVisible();
    await expect(uploadTag).toHaveAttribute('data-status', 'error');
    await expect(uploadTag).toContainText('20MB');
    await expect(page.getByTestId('next-send')).not.toHaveClass(/is-ready/);
  } finally {
    await srv.kill();
  }
});

