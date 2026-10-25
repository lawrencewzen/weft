import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from './_root.mjs';
import { resolvePathRef } from '../../public/path-ref.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
globalThis.window = dom.window;

const { renderMarkdown } = await import('../../public/markdown.js');

const PATH_TREE = [
  { path: 'public/app.css', type: 'file' },
  { path: 'src/x.mjs', type: 'file' },
  { path: 'package.json', type: 'file' },
  { path: 'secret.txt', type: 'file' },
];
const resolvePath = (text) => resolvePathRef(text, {
  tree: PATH_TREE,
  workspacePath: '/home/me/proj',
});

function parse(md) {
  const html = renderMarkdown(md);
  return { html, body: new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body };
}

test('empty input is empty html', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(), '');
});

test('renders a GFM table', () => {
  const { body } = parse('| 列 | 值 |\n| --- | --- |\n| a | b |');
  const cells = [...body.querySelectorAll('table th, table td')].map((el) => el.textContent);
  assert.deepEqual(cells, ['列', '值', 'a', 'b']);
  assert.equal(body.querySelectorAll('p').length, 0);
});

test('tables are wrapped in md-table and keep column alignment', () => {
  const { body } = parse('| left | mid | right |\n| --- | :---: | ---: |\n| a | b | c |');
  const wrap = body.querySelector('.md-table');
  assert.ok(wrap);
  assert.equal(wrap.querySelector('table')?.parentElement, wrap);
  const ths = [...wrap.querySelectorAll('th')];
  assert.equal(ths[0].getAttribute('align'), null);
  assert.equal(ths[1].getAttribute('align'), 'center');
  assert.equal(ths[2].getAttribute('align'), 'right');
  const tds = [...wrap.querySelectorAll('td')];
  assert.equal(tds[2].getAttribute('align'), 'right');
});

test('renders a thematic break', () => {
  const { body } = parse('hello\n\n---\n\nworld');
  assert.equal(body.querySelectorAll('hr').length, 1);
  assert.match(body.textContent, /hello/);
  assert.match(body.textContent, /world/);
});

test('renders a blockquote', () => {
  const { body } = parse('> 引用 **说明**');
  const quote = body.querySelector('blockquote');
  assert.ok(quote);
  assert.equal(quote.querySelector('strong')?.textContent, '说明');
  assert.match(quote.textContent, /引用/);
});

test('renders nested lists', () => {
  const { body } = parse('- a\n  - b\n    - c');
  const top = body.querySelector('ul');
  assert.equal(top?.children[0]?.childNodes[0]?.textContent.trim(), 'a');
  assert.equal(body.querySelectorAll('ul').length, 3);
  assert.equal(body.querySelector('ul ul ul li')?.textContent.trim(), 'c');
});

test('renders a fenced code block with the language bar', () => {
  const { body } = parse('```js\nconsole.log(1)\n```');
  const card = body.querySelector('.code-block-card');
  assert.ok(card);
  assert.equal(card.querySelector('.code-block-bar span')?.textContent, 'js');
  assert.equal(card.querySelector('pre.code-block-pre code')?.textContent, 'console.log(1)');
});

test('code block includes a copy-code button', () => {
  const { body } = parse('```js\nconsole.log(1)\n```');
  const btn = body.querySelector('button[data-action="copy-code"]');
  assert.ok(btn);
  assert.equal(btn.getAttribute('type'), 'button');
  assert.ok(btn.querySelector('[data-copy-label]'));
});

test('bash code block wraps lines with has-prompt and textContent has no dollar prompt', () => {
  const { body } = parse('```bash\necho hi\nls\n```');
  const lines = [...body.querySelectorAll('pre.code-block-pre .code-line')];
  assert.equal(lines.length, 2);
  assert.ok(lines.every((el) => el.classList.contains('has-prompt')));
  assert.equal(body.querySelector('pre.code-block-pre code')?.textContent, 'echo hi\nls');
  assert.doesNotMatch(body.querySelector('pre.code-block-pre code')?.textContent || '', /\$ /);
});

test('python code block has no shell prompt', () => {
  const { body } = parse('```python\nprint(1)\n```');
  assert.equal(body.querySelectorAll('.code-line').length, 0);
  assert.equal(body.querySelectorAll('.has-prompt').length, 0);
  assert.equal(body.querySelector('pre.code-block-pre code')?.textContent, 'print(1)');
});

test('bash line already starting with "$ " does not get has-prompt', () => {
  const { body } = parse('```shell\n$ echo hi\n\nls\n```');
  const lines = [...body.querySelectorAll('pre.code-block-pre .code-line')];
  assert.equal(lines.length, 3);
  assert.equal(lines[0].className, 'code-line');
  assert.equal(lines[0].textContent, '$ echo hi');
  assert.equal(lines[1].className, 'code-line');
  assert.equal(lines[1].textContent, '');
  assert.ok(lines[2].classList.contains('has-prompt'));
  assert.equal(lines[2].textContent, 'ls');
});

test('renders a link with target and rel', () => {
  const { body } = parse('see [docs](https://example.com/path)');
  const a = body.querySelector('a');
  assert.equal(a?.getAttribute('href'), 'https://example.com/path');
  assert.equal(a?.getAttribute('target'), '_blank');
  assert.equal(a?.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a?.textContent, 'docs');
});

test('renders task lists', () => {
  const { body } = parse('- [ ] todo\n- [x] done');
  const items = body.querySelectorAll('ul.contains-task-list > li.task-list-item');
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('input[type="checkbox"]')?.hasAttribute('checked'), false);
  assert.equal(items[1].querySelector('input[type="checkbox"]')?.hasAttribute('checked'), true);
  assert.ok(items[0].querySelector('input')?.disabled);
});

test('checked task items get is-done', () => {
  const { body } = parse('- [ ] todo\n- [x] done');
  const items = body.querySelectorAll('ul.contains-task-list > li.task-list-item');
  assert.equal(items[0].classList.contains('is-done'), false);
  assert.ok(items[1].classList.contains('is-done'));
});

test('DOMPurify keeps copy button and svg', () => {
  const { html, body } = parse('```js\nconsole.log(1)\n```');
  const btn = body.querySelector('button[data-action="copy-code"]');
  const svg = btn?.querySelector('svg');
  const rects = svg ? svg.querySelectorAll('rect') : [];
  assert.ok(btn);
  assert.ok(svg);
  assert.equal(rects.length, 2);
  assert.match(html, /data-action="copy-code"/);
  assert.match(html, /<svg/i);
});

test('strips forged data-action and extra data attributes from raw HTML', () => {
  const { body } = parse(
    '<button data-action="git-delete">x</button>\n\n'
    + '<span data-action="delete-skill" data-foo="1">y</span>\n\n'
    + '```js\nconsole.log(1)\n```'
  );
  assert.equal(body.querySelectorAll('[data-action="git-delete"]').length, 0);
  assert.equal(body.querySelectorAll('[data-action="delete-skill"]').length, 0);
  assert.equal(body.querySelectorAll('[data-foo]').length, 0);
  assert.ok(body.querySelector('button.code-copy-btn[data-action="copy-code"]'));
  assert.ok(body.querySelector('[data-copy-label]'));
});

test('without resolvePath, inline code matches the previous renderer', () => {
  assert.equal(
    renderMarkdown('see `package.json` and `a&b` and `x<y`'),
    '<p>see <code>package.json</code> and <code>a&amp;b</code> and <code>x&lt;y</code></p>\n',
  );
  const { body } = parse('see `public/app.css:446`');
  assert.equal(body.querySelectorAll('code.md-path').length, 0);
  assert.equal(body.querySelector('code')?.textContent, 'public/app.css:446');
});

test('resolvePath turns existing files into path chips and leaves others as code', () => {
  const html = renderMarkdown(
    'see `public/app.css` `public/app.css:446` `./src/x.mjs` `nope.missing` `https://ex.com/x.js` `has space.css` `npm`',
    { resolvePath },
  );
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  const chips = [...body.querySelectorAll('code.md-path')];
  assert.equal(chips.length, 3);
  assert.equal(chips[0].getAttribute('data-action'), 'open-path');
  assert.equal(chips[0].getAttribute('data-path'), 'public/app.css');
  assert.equal(chips[0].getAttribute('data-line'), null);
  assert.equal(chips[1].getAttribute('data-path'), 'public/app.css');
  assert.equal(chips[1].getAttribute('data-line'), '446');
  assert.equal(chips[1].querySelector('.md-path-line')?.textContent, ':446');
  assert.equal(chips[2].getAttribute('data-path'), 'src/x.mjs');
  assert.match(chips[2].textContent, /\.\/src\/x\.mjs/);
  const plain = [...body.querySelectorAll('code:not(.md-path)')].map((el) => el.textContent);
  assert.deepEqual(plain, ['nope.missing', 'https://ex.com/x.js', 'has space.css', 'npm']);
});

test('fenced code is not turned into path chips', () => {
  const html = renderMarkdown('```\npublic/app.css:1\n```', { resolvePath });
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  assert.equal(body.querySelectorAll('code.md-path').length, 0);
  assert.equal(body.querySelector('pre.code-block-pre code')?.textContent, 'public/app.css:1');
});

test('DOMPurify keeps open-path on code.md-path and strips other data-action', () => {
  const html = renderMarkdown(
    '<code class="md-path" data-action="open-path" data-path="public/app.css">ok</code>\n\n'
    + '<code class="md-path" data-action="git-delete" data-path="public/app.css">nope</code>\n\n'
    + '<button data-action="open-path">x</button>\n\n'
    + '<span data-action="open-path">y</span>\n\n'
    + '```js\nconsole.log(1)\n```',
    { resolvePath },
  );
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  const kept = body.querySelector('code.md-path[data-action="open-path"]');
  assert.ok(kept);
  assert.equal(kept.getAttribute('data-path'), 'public/app.css');
  assert.equal(body.querySelectorAll('[data-action="git-delete"]').length, 0);
  assert.equal(body.querySelectorAll('button[data-action="open-path"]').length, 0);
  assert.equal(body.querySelectorAll('span[data-action="open-path"]').length, 0);
  assert.ok(body.querySelector('button.code-copy-btn[data-action="copy-code"]'));
});

test('forged open-path data-path outside the workspace does not resolve', () => {
  const html = renderMarkdown(
    '<code class="md-path" data-action="open-path" data-path="../secret.txt">x</code>',
    { resolvePath },
  );
  const body = new JSDOM(`<!doctype html><body>${html}</body>`).window.document.body;
  const chip = body.querySelector('code.md-path');
  assert.equal(chip?.getAttribute('data-action'), 'open-path');
  assert.equal(chip?.getAttribute('data-path'), '../secret.txt');
  assert.equal(resolvePathRef(chip.getAttribute('data-path'), {
    tree: PATH_TREE,
    workspacePath: '/home/me/proj',
  }), null);
});

test('strips script tags', () => {
  const { html, body } = parse('hello <script>alert(1)</script> world');
  assert.equal(body.querySelectorAll('script').length, 0);
  assert.doesNotMatch(html, /<script/i);
  assert.match(body.textContent, /hello/);
  assert.match(body.textContent, /world/);
});

test('strips onerror handlers', () => {
  const { html, body } = parse('<img src=x onerror="alert(1)">');
  const img = body.querySelector('img');
  assert.equal(img?.hasAttribute('onerror'), false);
  assert.doesNotMatch(html, /onerror/i);
});

test('strips javascript: links', () => {
  const { html, body } = parse('[click](javascript:alert(1))');
  const a = body.querySelector('a');
  const href = a?.getAttribute('href') || '';
  assert.doesNotMatch(href, /javascript:/i);
  assert.doesNotMatch(html, /javascript:/i);
});

const STRIP = [
  'WEFT_LLM',
  'WEFT_FAUX_SCRIPT',
  'WEFT_FAUX_TEXT',
  'LLM_API',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'WEFT_GROK_AUTH',
  'GROK_HOME',
  'WEFT_TOKEN',
];

function childEnv(dataDir) {
  const env = { ...process.env };
  for (const key of STRIP) delete env[key];
  return {
    ...env,
    PORT: '0',
    WEFT_DATA_DIR: dataDir,
    WEFT_GROK_AUTH: path.join(dataDir, 'grok-auth.json'),
    WEFT_RETRY_BASE_MS: '20',
    WEFT_RETRY_MAX: '5',
  };
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

test('vendor ESM files are served locally and node_modules is not exposed', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-md-'));
  await writeFile(path.join(dataDir, 'grok-auth.json'), '{}\n', { mode: 0o600 });
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: childEnv(dataDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 20000);
      const onData = (buf) => {
        log += buf;
        const match = log.match(/WEFT_READY (http:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}:\n${log}`));
      });
    });
    proc.removeAllListeners('exit');

    const markedRes = await fetch(`${base}/vendor/marked.esm.js`);
    assert.equal(markedRes.status, 200);
    assert.match(markedRes.headers.get('content-type') || '', /javascript/);
    const markedText = await markedRes.text();
    assert.match(markedText, /marked v18/);
    assert.doesNotMatch(markedText, /cdn\.jsdelivr|unpkg\.com|cdnjs/i);

    const purifyRes = await fetch(`${base}/vendor/purify.es.mjs`);
    assert.equal(purifyRes.status, 200);
    assert.match(purifyRes.headers.get('content-type') || '', /javascript/);
    const purifyText = await purifyRes.text();
    assert.match(purifyText, /DOMPurify 3\.4\.17/);
    assert.doesNotMatch(purifyText, /cdn\.jsdelivr|unpkg\.com|cdnjs/i);

    const missing = await fetch(`${base}/vendor/not-allowed.js`);
    const missingText = await missing.text();
    assert.doesNotMatch(missingText, /marked v18|DOMPurify/);

    const leaked = await fetch(`${base}/node_modules/marked/lib/marked.esm.js`);
    const leakedText = await leaked.text();
    assert.doesNotMatch(leakedText, /a markdown parser built for speed/i);
    assert.match(leakedText, /<html/i);
  } finally {
    await stopProcess(proc);
    await rm(dataDir, { recursive: true, force: true });
  }
});
