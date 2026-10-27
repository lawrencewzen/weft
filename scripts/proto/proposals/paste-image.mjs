// 提案：粘贴图片。样式和 DOM 都来自 design/paste（用户已确认的设计），
// 这里只是把效果叠到真实完成的对话上，产品代码还没有这个功能。
import { injectCss } from '../lib/page.mjs';

const DRAFT_TEXT = '按这张设计稿改一下：缩略图排在输入框上方，右上角带删除按钮，底部 chip 那一行别动。';

/** 设计稿里粘贴的两张截图。用确定的小 SVG 代替真实图片，避免提交大文件。 */
function previewSvg({ dark }) {
  const bg = dark ? '#1d1d1d' : '#f7f7f6';
  const bar = dark ? '#262626' : '#ececeb';
  const line = dark ? '#3a3a3a' : '#dcdcda';
  const strong = dark ? '#4a4a4a' : '#c6c6c4';
  const accent = dark ? '#7f9f8a' : '#b9cfc1';
  const rows = [26, 36, 46, 56, 66, 76];
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">',
    `<rect width="96" height="96" fill="${bg}"/>`,
    `<rect width="96" height="12" fill="${bar}"/>`,
    `<circle cx="7" cy="6" r="2" fill="${line}"/>`,
    `<circle cx="14" cy="6" r="2" fill="${line}"/>`,
    `<rect x="0" y="12" width="26" height="84" fill="${bar}"/>`,
    `<rect x="4" y="18" width="18" height="3" rx="1.5" fill="${strong}"/>`,
    `<rect x="4" y="25" width="14" height="3" rx="1.5" fill="${line}"/>`,
    `<rect x="4" y="32" width="16" height="3" rx="1.5" fill="${line}"/>`,
    `<rect x="32" y="20" width="42" height="4" rx="2" fill="${strong}"/>`,
    ...rows.map((y, i) => `<rect x="32" y="${y + 12}" width="${i % 2 ? 34 : 48}" height="3" rx="1.5" fill="${line}"/>`),
    `<rect x="32" y="78" width="22" height="8" rx="4" fill="${accent}"/>`,
    '</svg>',
  ].join('');
}

const IMAGES = [
  { name: '设计稿-列表.png', dark: false },
  { name: '设计稿-深色.png', dark: true },
].map((item) => ({
  name: item.name,
  src: `data:image/svg+xml;base64,${Buffer.from(previewSvg({ dark: item.dark }), 'utf8').toString('base64')}`,
}));

const ATTACH_CSS = String.raw`
/* ===== 粘贴图片（提案，未实现） ===== */
.composer-attachments { display: flex; flex-wrap: wrap; gap: 8px; }
.composer-attach {
  position: relative; width: 64px; height: 64px; border-radius: 12px;
  border: 1px solid var(--line); background: var(--sub); overflow: hidden;
  transition: border-color .15s, box-shadow .15s;
}
.composer-attach img { display: block; width: 100%; height: 100%; object-fit: cover; }
.composer-attach:hover { border-color: var(--bd3); box-shadow: var(--shadow-pop); }
.composer-attach-remove {
  position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  border: 1px solid var(--bd2); border-radius: 50%; background: var(--panel); color: var(--ink3);
  opacity: 0; transition: opacity .12s, color .12s;
}
.composer-attach:hover .composer-attach-remove,
.composer-attach-remove:focus-visible { opacity: 1; }
.composer-attach-remove:hover { color: var(--ink); }
.composer-attach-remove svg {
  width: 9px; height: 9px; fill: none; stroke: currentColor;
  stroke-width: 1.4; stroke-linecap: round;
}
.composer-attach-name {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 9px 5px 3px;
  font-size: 10px; line-height: 1.2; color: #fff; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  background: linear-gradient(to top, rgba(0, 0, 0, .55), rgba(0, 0, 0, 0));
  opacity: 0; transition: opacity .12s;
}
.composer-attach:hover .composer-attach-name { opacity: 1; }

/* 发送后，图片排在用户消息气泡上方 */
.msg-images { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.msg-image {
  display: block; width: 132px; height: 132px; border-radius: 12px; object-fit: cover;
  border: 1px solid var(--line); background: var(--sub);
}
`;

export const proposal = {
  id: 'paste-image',
  title: '粘贴图片（提案）',
  note: '草稿态缩略图排在输入框上方；悬停出现删除按钮和文件名。设计已确认，代码未实现',
  base: 'chat-done',
  css: ATTACH_CSS,
  async apply(ctx) {
    const { page } = ctx;
    await injectCss(page, 'proto-proposal-paste', ATTACH_CSS);
    await page.getByTestId('next-composer-input').fill(DRAFT_TEXT);
    await page.waitForTimeout(200);
    await page.evaluate((images) => {
      const box = document.querySelector('.composer-box');
      if (!box) throw new Error('找不到 .composer-box');
      if (box.querySelector('.composer-attachments')) return;
      const textarea = box.querySelector('textarea');
      const row = document.createElement('div');
      row.className = 'composer-attachments';
      row.setAttribute('data-testid', 'proto-composer-attachments');
      row.innerHTML = images.map((image) => [
        '<div class="composer-attach"',
        ` title="${image.name}">`,
        `<img src="${image.src}" alt="${image.name}">`,
        '<button type="button" class="composer-attach-remove" aria-label="移除图片">',
        '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"></path></svg>',
        '</button>',
        `<span class="composer-attach-name">${image.name}</span>`,
        '</div>',
      ].join('')).join('');
      box.insertBefore(row, textarea);
      if (textarea) textarea.style.height = '46px';
    }, IMAGES);
    await page.waitForTimeout(200);
  },
};
