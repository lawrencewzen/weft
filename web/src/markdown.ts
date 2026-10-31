import { Marked, type Renderer, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import type { components } from '../../src/v2/contract.gen';

type PathRef = components['schemas']['PathRef'];

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console']);

const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/>' +
  '<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.8"/>' +
  '</svg>';

const FILE_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M14 3v5h5" stroke="currentColor" stroke-width="2"/>' +
  '</svg>';

const LINE_HASH_RE = /#L(\d+)(?:-L?\d+)?$/;
const LINE_COLON_RE = /:(\d+)(?::(\d+))?$/;

export type PathResolve = { path: string; line?: number };

let currentResolvePath: ((raw: string) => PathResolve | null) | null = null;
let currentCopyLabel = '';
let inLink = false;

function isLocalOrFilePath(href: string): boolean {
  if (!href) return false;
  if (/^file:\/\//i.test(href)) return true;
  if (href.startsWith('/')) return true;
  if (/^[a-zA-Z]:[/\\]/.test(href)) return true;
  if (href.startsWith('#')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return true;
}

function parseLineSuffix(text: string): { path: string; line?: number; suffix: string } {
  const raw = String(text ?? '');
  let match = raw.match(LINE_HASH_RE);
  if (match && match.index != null) {
    return { path: raw.slice(0, match.index), line: Number(match[1]), suffix: match[0] };
  }
  match = raw.match(LINE_COLON_RE);
  if (match && match.index != null) {
    return { path: raw.slice(0, match.index), line: Number(match[1]), suffix: match[0] };
  }
  return { path: raw, suffix: '' };
}

function escapeHtml(str: unknown): string {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pathChipHtml(rawText: string, resolved: PathResolve): string {
  const parsed = parseLineSuffix(rawText);
  const main = escapeHtml(parsed.path);
  const lineHtml = parsed.suffix
    ? `<span class="md-path-line">${escapeHtml(parsed.suffix)}</span>`
    : '';
  const lineAttr = Number.isFinite(resolved.line) && (resolved.line ?? 0) >= 1
    ? ` data-line="${resolved.line}"`
    : '';
  return (
    `<code class="md-path" data-path="${escapeHtml(resolved.path)}"${lineAttr} title="${escapeHtml(resolved.path)}">` +
    FILE_ICON +
    `${main}${lineHtml}` +
    `</code>`
  );
}

function filePathLinkHtml(resolved: PathResolve, contentHtml: string, title?: string | null): string {
  const lineAttr = Number.isFinite(resolved.line) && (resolved.line ?? 0) >= 1
    ? ` data-line="${resolved.line}"`
    : '';
  const titleAttr = title
    ? ` title="${escapeHtml(title)}"`
    : ` title="${escapeHtml(resolved.path)}"`;
  return (
    `<a class="md-path" data-path="${escapeHtml(resolved.path)}"${lineAttr}${titleAttr}>` +
    FILE_ICON +
    contentHtml +
    `</a>`
  );
}

function renderFencedBody(text: string, lang: string): string {
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
    code({ text, lang }: Tokens.Code) {
      const language = String(lang || '').trim().split(/\s+/)[0] || 'text';
      const label = escapeHtml(currentCopyLabel);
      return (
        `<div class="code-block-card">` +
        `<div class="code-block-bar">` +
        `<span>${escapeHtml(language)}</span>` +
        `<button type="button" class="code-copy-btn">` +
        COPY_ICON +
        `<span data-copy-label>${label}</span>` +
        `</button>` +
        `</div>` +
        `<pre class="code-block-pre"><code>${renderFencedBody(text, language)}</code></pre>` +
        `</div>\n`
      );
    },
    table(this: Renderer, token: Tokens.Table) {
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
    list(this: Renderer, token: Tokens.List) {
      const ordered = token.ordered;
      const start = token.start;
      let items = '';
      for (const item of token.items) items += this.listitem(item as unknown as Tokens.ListItem);
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      const cls = token.items.some((item) => item.task) ? ' class="contains-task-list"' : '';
      return `<${tag}${startAttr}${cls}>\n${items}</${tag}>\n`;
    },
    listitem(this: Renderer, item: Tokens.ListItem) {
      let body = this.parser.parse(item.tokens);
      if (item.task) {
        body = body.replace(/^\s*<input[^>]*type="checkbox"[^>]*>\s*/i, '');
        body = body.replace(/^<p>([\s\S]*)<\/p>\n?$/, '$1');
        const done = item.checked ? ' is-done' : '';
        const checked = item.checked ? ' checked' : '';
        return (
          `<li class="task-list-item${done}">` +
          `<input type="checkbox" disabled${checked} aria-hidden="true">` +
          `<span>${body}</span>` +
          `</li>\n`
        );
      }
      return `<li>${body}</li>\n`;
    },
    codespan({ text }: Tokens.Codespan) {
      const raw = String(text ?? '');
      if (!inLink && typeof currentResolvePath === 'function') {
        const resolved = currentResolvePath(raw);
        if (resolved?.path) return pathChipHtml(raw, resolved);
      }
      return `<code>${escapeHtml(raw)}</code>`;
    },
    link(this: Renderer, token: Tokens.Link) {
      const rawHref = String(token.href ?? '');
      inLink = true;
      let content = '';
      try {
        content = token.autolink
          ? escapeHtml(token.text ?? '')
          : (token.tokens && token.tokens.length > 0
              ? this.parser.parseInline(token.tokens)
              : escapeHtml(token.text ?? ''));
      } finally {
        inLink = false;
      }
      if (typeof currentResolvePath === 'function') {
        const resolved = currentResolvePath(rawHref);
        if (resolved?.path) {
          return filePathLinkHtml(resolved, content || escapeHtml(resolved.path), token.title);
        }
      }
      if (isLocalOrFilePath(rawHref)) {
        const titleAttr = rawHref ? ` title="${escapeHtml(token.title || rawHref)}"` : '';
        return `<span${titleAttr}>${content || escapeHtml(rawHref)}</span>`;
      }
      const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(rawHref)}"${titleAttr}>${content}</a>`;
    },
  },
});

const PURIFY_CONFIG = {
  ADD_TAGS: ['input', 'button', 'svg', 'rect', 'path'],
  ADD_ATTR: [
    'target', 'rel', 'checked', 'disabled', 'type', 'class', 'start',
    'data-copy-label', 'data-path', 'data-line',
    'viewBox', 'fill', 'stroke', 'stroke-width', 'rx', 'width', 'height', 'x', 'y', 'd',
    'aria-hidden', 'tabindex',
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style'],
};

let purifyInstance: ReturnType<typeof DOMPurify> | typeof DOMPurify | null = null;

function asElement(node: Node): Element | null {
  if (node.nodeType !== 1) return null;
  return node as Element;
}

function getPurify() {
  if (purifyInstance && 'isSupported' in purifyInstance && purifyInstance.isSupported) return purifyInstance;
  const root = globalThis.window;
  let impl: typeof DOMPurify | ReturnType<typeof DOMPurify> = DOMPurify;
  if (root?.document) impl = typeof DOMPurify === 'function' ? DOMPurify(root) : DOMPurify;
  if (!impl?.isSupported) {
    throw new Error('DOMPurify requires a DOM');
  }
  impl.addHook('afterSanitizeAttributes', (node) => {
    const el = asElement(node);
    if (!el?.getAttribute) return;
    if (el.tagName === 'A') {
      if (el.hasAttribute('data-path') || el.classList.contains('md-path')) {
        el.removeAttribute('target');
        el.removeAttribute('rel');
      } else {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      const href = el.getAttribute('href') || '';
      if (/^\s*javascript:/i.test(href)) el.removeAttribute('href');
    }
    for (const attr of [...el.getAttributeNames()]) {
      if (/^on/i.test(attr) || attr === 'data-action') el.removeAttribute(attr);
    }
  });
  impl.addHook('uponSanitizeElement', (node, data) => {
    const el = asElement(node);
    if (data.tagName !== 'input' || !el) return;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type !== 'checkbox') el.parentNode?.removeChild(el);
  });
  purifyInstance = impl;
  return impl;
}

export function pathResolver(refs: PathRef[] | undefined): (raw: string) => PathResolve | null {
  const map = new Map<string, PathRef>();
  for (const ref of refs || []) {
    if (ref?.text) map.set(ref.text, ref);
  }
  return (raw: string) => {
    const hit = map.get(raw);
    if (!hit) return null;
    return { path: hit.path, line: hit.line };
  };
}

/** Strip handlers before DOMPurify parses, so CSP does not log blocked inline events. */
function scrubInlineHandlers(html: string): string {
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(?:href|src)\s*=\s*(['"])\s*javascript:[^'"]*\1/gi, '');
}

export function renderMarkdown(
  src = '',
  opts: { resolvePath?: (raw: string) => PathResolve | null; copyLabel?: string } = {},
): string {
  if (!src) return '';
  currentResolvePath = typeof opts.resolvePath === 'function' ? opts.resolvePath : null;
  currentCopyLabel = opts.copyLabel || '';
  try {
    const html = marked.parse(String(src), { async: false });
    return getPurify().sanitize(scrubInlineHandlers(String(html)), PURIFY_CONFIG);
  } finally {
    currentResolvePath = null;
    inLink = false;
  }
}
