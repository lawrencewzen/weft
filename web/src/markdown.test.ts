/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { pathResolver, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('strips img onerror and javascript links', () => {
    const html = renderMarkdown(
      '<img src=x onerror="window.__xss=1">\n\n[bad](javascript:alert(1))',
    );
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toContain('<script');
  });

  it('strips data-action from untrusted HTML', () => {
    const html = renderMarkdown('<button data-action="git-delete">x</button>\n\n`ok`');
    expect(html).not.toContain('data-action');
    expect(html).toContain('<code>ok</code>');
  });

  it('turns pathRefs into file chips without data-action', () => {
    const html = renderMarkdown('see `src/app.ts:12` and `nope`', {
      resolvePath: pathResolver([{ text: 'src/app.ts:12', path: 'src/app.ts', line: 12 }]),
    });
    expect(html).toContain('class="md-path"');
    expect(html).toContain('data-path="src/app.ts"');
    expect(html).toContain('data-line="12"');
    expect(html).toContain('class="md-path-line"');
    expect(html).not.toContain('data-action');
    expect(html).toContain('nope');
  });

  it('renders GFM tables, task lists, and fenced code with a copy control', () => {
    const html = renderMarkdown([
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '```bash',
      'npm test',
      '```',
    ].join('\n'));
    expect(html).toContain('class="md-table"');
    expect(html).toContain('<thead>');
    expect(html).toContain('class="task-list-item is-done"');
    expect(html).toContain('class="task-list-item"');
    expect(html).toMatch(/<input type="checkbox"[^>]*checked/);
    expect(html).toMatch(/<input type="checkbox"[^>]*>/);
    expect(html).toContain('>done</span>');
    expect(html).toContain('>todo</span>');
    expect(html).toContain('class="code-block-card"');
    expect(html).toContain('class="code-copy-btn"');
    expect(html).toContain('>bash<');
    expect(html).toContain('class="code-line has-prompt"');
    expect(html).toContain('npm test');
  });

  describe('markdown file links', () => {
    it('category a: renders resolved file links as clickable chips without target=_blank and respects line range', () => {
      const fileUrl = 'file:///Users/lawrence/Projects/weft/workspaces/ws1/calc.py#L1-L3';
      const html = renderMarkdown(
        `在 [calc.py](${fileUrl}) 中发现了 Bug，另外参考 [app.css](web/src/styles/app.css) 和 [入口](/src/main.ts:15)`,
        {
          resolvePath: pathResolver([
            { text: fileUrl, path: 'calc.py', line: 1 },
            { text: 'web/src/styles/app.css', path: 'web/src/styles/app.css' },
            { text: '/src/main.ts:15', path: 'src/main.ts', line: 15 },
          ]),
        },
      );

      // file:// link with #L1-L3
      expect(html).toContain('<a class="md-path" data-path="calc.py" data-line="1" title="calc.py">');
      expect(html).toContain('calc.py</a>');
      expect(html).not.toMatch(/<a[^>]*data-path="calc\.py"[^>]*target="_blank"/);
      expect(html).not.toMatch(/<a[^>]*data-path="calc\.py"[^>]*rel=/);

      // relative path link
      expect(html).toContain('<a class="md-path" data-path="web/src/styles/app.css" title="web/src/styles/app.css">');
      expect(html).toContain('app.css</a>');
      expect(html).not.toMatch(/<a[^>]*data-path="web\/src\/styles\/app\.css"[^>]*data-line/);
      expect(html).not.toMatch(/<a[^>]*data-path="web\/src\/styles\/app\.css"[^>]*target="_blank"/);

      // absolute path link with :line
      expect(html).toContain('<a class="md-path" data-path="src/main.ts" data-line="15" title="src/main.ts">');
      expect(html).toContain('入口</a>');

      // None of the file links have target=_blank
      expect(html).not.toContain('target="_blank"');
    });

    it('category b: outputs plain text with title for unresolvable local and file links (no dead <a>)', () => {
      const html = renderMarkdown([
        '[missing file](file:///Users/lawrence/Projects/weft/missing.py#L5-L10)',
        '[missing abs](/abs/path/missing.ts)',
        '[missing win](C:\\repo\\missing.ts)',
        '[missing win slash](C:/repo/missing.ts)',
        '[missing rel](src/not-found.ts)',
      ].join('\n'));

      // No <a> tags generated for dead local/file paths
      expect(html).not.toContain('<a');
      expect(html).toContain('<span title="file:///Users/lawrence/Projects/weft/missing.py#L5-L10">missing file</span>');
      expect(html).toContain('<span title="/abs/path/missing.ts">missing abs</span>');
      expect(html).toContain('<span title="C:\\repo\\missing.ts">missing win</span>');
      expect(html).toContain('<span title="C:/repo/missing.ts">missing win slash</span>');
      expect(html).toContain('<span title="src/not-found.ts">missing rel</span>');
    });

    it('category c: keeps http, https and mailto links opening in a new tab with target=_blank', () => {
      const html = renderMarkdown(
        '访问 [GitHub](https://github.com) 和 [HTTP](http://example.com/api) 或 [联系](mailto:dev@example.com)',
      );
      expect(html).toContain('<a href="https://github.com" target="_blank" rel="noopener noreferrer">GitHub</a>');
      expect(html).toContain('<a href="http://example.com/api" target="_blank" rel="noopener noreferrer">HTTP</a>');
      expect(html).toContain('<a href="mailto:dev@example.com" target="_blank" rel="noopener noreferrer">联系</a>');
      expect(html).not.toContain('class="md-path"');
    });

    it('prevents nested chips when code span is inside a file link', () => {
      const fileUrl = 'file:///Users/lawrence/calc.py#L1-L3';
      const html = renderMarkdown(`在 [\`calc.py\`](${fileUrl}) 中`, {
        resolvePath: pathResolver([
          { text: fileUrl, path: 'calc.py', line: 1 },
          { text: 'calc.py', path: 'calc.py' },
        ]),
      });
      // Outer is <a class="md-path">, inside is <code>calc.py</code> without class="md-path"
      expect(html).toContain('<a class="md-path" data-path="calc.py" data-line="1" title="calc.py">');
      expect(html).toContain('<code>calc.py</code>');
      expect(html).not.toContain('<code class="md-path"');
    });
  });
});
