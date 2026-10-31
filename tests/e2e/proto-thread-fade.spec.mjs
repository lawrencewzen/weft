import { expect, test } from '@playwright/test';
import { expectClean, openProto } from './helpers/proto.mjs';

test.use({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

test('thread bottom fade: 64px mask gradient, last item clear at bottom, scrollbar strip unmasked', async ({ page }) => {
  const state = await openProto(page);

  const thread = page.locator('.center-thread');
  await expect(thread).toBeVisible();
  await expect(page.getByTestId('next-item-assistant').first()).toBeVisible();

  const mask = await thread.evaluate((el) => {
    const cs = getComputedStyle(el);
    const maskImage = cs.maskImage && cs.maskImage !== 'none'
      ? cs.maskImage
      : (cs.webkitMaskImage || cs.getPropertyValue('-webkit-mask-image'));
    const maskSize = cs.maskSize && cs.maskSize !== 'none'
      ? cs.maskSize
      : (cs.webkitMaskSize || cs.getPropertyValue('-webkit-mask-size'));
    const maskPosition = cs.maskPosition && cs.maskPosition !== 'none'
      ? cs.maskPosition
      : (cs.webkitMaskPosition || cs.getPropertyValue('-webkit-mask-position'));
    return {
      maskImage,
      maskSize,
      maskPosition,
      threadFade: cs.getPropertyValue('--thread-fade').trim(),
      threadSb: cs.getPropertyValue('--thread-sb').trim(),
      offsetWidth: el.offsetWidth,
      clientWidth: el.clientWidth,
      scrollbarGutter: cs.scrollbarGutter,
    };
  });

  expect(mask.threadFade, '--thread-fade is 64px').toBe('64px');
  expect(mask.maskImage, 'mask-image has linear-gradient').toMatch(/linear-gradient/i);
  expect(
    mask.maskImage,
    'fade height is 64px from --thread-fade',
  ).toMatch(/64px|var\(--thread-fade\)/);
  const layerCount = (mask.maskImage.match(/linear-gradient/gi) || []).length;
  expect(layerCount, 'content fade + opaque scrollbar strip').toBeGreaterThanOrEqual(2);
  expect(mask.maskSize, 'mask-size splits content vs scrollbar strip').toMatch(/,/);

  const totalGutter = mask.offsetWidth - mask.clientWidth;
  const expectedSb = /\bboth-edges\b/.test(mask.scrollbarGutter || '')
    ? totalGutter / 2
    : totalGutter;
  const sbPx = Number.parseFloat(mask.threadSb) || 0;
  expect(Math.abs(sbPx - expectedSb), `--thread-sb tracks right scrollbar strip (${mask.threadSb})`).toBeLessThanOrEqual(1);

  await thread.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const gap = await page.evaluate(() => {
    const scroller = document.querySelector('.center-thread');
    const last = scroller?.querySelector('.thread-inner')?.lastElementChild;
    if (!scroller || !last) return null;
    return scroller.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
  });
  expect(gap, 'last item sits above the 64px fade when scrolled to end').not.toBeNull();
  expect(gap, `last item gap ${gap}px`).toBeGreaterThanOrEqual(64);

  expectClean(state);
});
