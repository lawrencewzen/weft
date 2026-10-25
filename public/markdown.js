import { Marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.25"/>' +
  '<rect x="2.5" y="2.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.25"/>' +
  '</svg>';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function copyCodeLabel() {
  return typeof globalThis.t === 'function' ? globalThis.t('copy_code') : '复制';
}

function renderFencedBody(text, lang) {
  const body = String(text ?? '').replace(/\n$/, '');
  if (!SHELL_LANGS.has(lang.toLowerCase())) return escapeHtml(body);
  return body.split('\n').map((line) => {
    const prompt = line.trim() !== '' && !line.startsWith('$ ');
    const cls = prompt ? 'code-line has-prompt' : 'code-line';
    return `<span class="${cls}">${escapeHtml(line)}</span>`;
  }).join('\n');
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    code({ text, lang }) {
      const language = String(lang || '').trim().split(/\s+/)[0] || 'text';
      const label = escapeHtml(copyCodeLabel());
      return (
        `<div class="code-block-card">` +
        `<div class="code-block-bar">` +
        `<span>${escapeHtml(language)}</span>` +
        `<button type="button" class="code-copy-btn" data-action="copy-code">` +
        COPY_ICON +
        `<span data-copy-label>${label}</span>` +
        `</button>` +
        `</div>` +
        `<pre class="code-block-pre"><code>${renderFencedBody(text, language)}</code></pre>` +
        `</div>\n`
      );
    },
    table(token) {
      let header = '';
      for (const cell of token.header) header += this.tablecell(cell);
      let body = '';
      for (const row of token.rows) {
        let cells = '';
        for (const cell of row) cells += this.tablecell(cell);
        body += this.tablerow({ text: cells });
      }
      return (
        `<div class="md-table"><table>\n` +
        `<thead>${this.tablerow({ text: header })}</thead>\n` +
        (body ? `<tbody>${body}</tbody>` : '') +
        `</table></div>\n`
      );
    },
    list(token) {
      const ordered = token.ordered;
      const start = token.start;
      let items = '';
      for (const item of token.items) items += this.listitem(item);
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      const cls = token.items.some((item) => item.task) ? ' class="contains-task-list"' : '';
      return `<${tag}${startAttr}${cls}>\n${items}</${tag}>\n`;
    },
    listitem(item) {
      const body = this.parser.parse(item.tokens);
      if (item.task) {
        const done = item.checked ? ' is-done' : '';
        return `<li class="task-list-item${done}">${body}</li>\n`;
      }
      return `<li>${body}</li>\n`;
    },
  },
});

const PURIFY_CONFIG = {
  ADD_TAGS: ['input', 'button', 'svg', 'rect'],
  ADD_ATTR: [
    'target', 'rel', 'checked', 'disabled', 'type', 'class', 'start',
    'data-action', 'data-copy-label',
    'viewBox', 'fill', 'stroke', 'stroke-width', 'rx', 'width', 'height', 'x', 'y',
    'aria-hidden',
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
};

let purifyInstance = null;

function getPurify() {
  if (purifyInstance?.isSupported) return purifyInstance;
  let impl = DOMPurify;
  if (!impl.isSupported) {
    const root = globalThis.window;
    if (root?.document) impl = DOMPurify(root);
  }
  if (!impl?.isSupported) {
    throw new Error('DOMPurify requires a DOM');
  }
  impl.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (!node.getAttribute) return;
    const action = node.getAttribute('data-action');
    if (action == null) return;
    const allowed = node.tagName === 'BUTTON'
      && action === 'copy-code'
      && node.classList?.contains('code-copy-btn');
    if (!allowed) node.removeAttribute('data-action');
  });
  impl.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'input') return;
    const type = String(node.getAttribute?.('type') || '').toLowerCase();
    if (type !== 'checkbox') node.parentNode?.removeChild(node);
  });
  purifyInstance = impl;
  return impl;
}

export function renderMarkdown(src = '') {
  if (!src) return '';
  const html = marked.parse(String(src), { async: false });
  return getPurify().sanitize(html, PURIFY_CONFIG);
}
