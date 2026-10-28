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
});
