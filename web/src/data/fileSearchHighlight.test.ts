import { describe, expect, it } from 'vitest';
import {
  findMatchIndices,
  highlightFilePath,
  spansFromIndices,
  splitFilePath,
} from './fileSearchHighlight';

describe('splitFilePath', () => {
  it('splits simple filename in root', () => {
    expect(splitFilePath('README.md')).toEqual({ dir: '', name: 'README.md' });
  });

  it('splits nested path', () => {
    expect(splitFilePath('web/src/components/FileBrowser.tsx')).toEqual({
      dir: 'web/src/components',
      name: 'FileBrowser.tsx',
    });
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(splitFilePath('web\\src\\components\\FileBrowser.tsx')).toEqual({
      dir: 'web/src/components',
      name: 'FileBrowser.tsx',
    });
  });
});

describe('findMatchIndices', () => {
  it('returns empty array when query is empty', () => {
    expect(findMatchIndices('hello.txt', '')).toEqual([]);
  });

  it('returns null when text is empty and query is not', () => {
    expect(findMatchIndices('', 'a')).toBeNull();
  });

  it('returns contiguous indices for exact substring match', () => {
    expect(findMatchIndices('foo_filter.ts', 'filter')).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('is case-insensitive for exact matches', () => {
    expect(findMatchIndices('FileBrowser.tsx', 'file')).toEqual([0, 1, 2, 3]);
  });

  it('returns subsequence indices when not contiguous', () => {
    // F(0) i(1) l(2) e(3) B(4)
    expect(findMatchIndices('FileBrowser.tsx', 'fb')).toEqual([0, 4]);
  });

  it('returns null when characters cannot be found in order', () => {
    expect(findMatchIndices('FileBrowser.tsx', 'xyz')).toBeNull();
    expect(findMatchIndices('FileBrowser.tsx', 'bf')).toBeNull();
  });
});

describe('spansFromIndices', () => {
  it('returns single unhighlighted span when indices are empty', () => {
    expect(spansFromIndices('hello.txt', [])).toEqual([
      { text: 'hello.txt', highlight: false },
    ]);
  });

  it('correctly chunks highlights and non-highlights', () => {
    // 'F'(0, hl) + 'ile'(1..3, no) + 'B'(4, hl) + 'rowser.tsx'(5.., no)
    expect(spansFromIndices('FileBrowser.tsx', [0, 4])).toEqual([
      { text: 'F', highlight: true },
      { text: 'ile', highlight: false },
      { text: 'B', highlight: true },
      { text: 'rowser.tsx', highlight: false },
    ]);
  });

  it('handles highlight at end of string', () => {
    expect(spansFromIndices('test.ts', [5, 6])).toEqual([
      { text: 'test.', highlight: false },
      { text: 'ts', highlight: true },
    ]);
  });
});

describe('highlightFilePath', () => {
  it('returns unhighlighted spans when query is empty or spaces', () => {
    const res = highlightFilePath('src/app.ts', '   ');
    expect(res.dir).toBe('src');
    expect(res.name).toBe('app.ts');
    expect(res.dirSpans).toEqual([{ text: 'src', highlight: false }]);
    expect(res.nameSpans).toEqual([{ text: 'app.ts', highlight: false }]);
  });

  it('prefers filename match without highlighting directory', () => {
    const res = highlightFilePath('web/src/components/FileBrowser.tsx', 'file');
    expect(res.dir).toBe('web/src/components');
    expect(res.name).toBe('FileBrowser.tsx');
    expect(res.dirSpans).toEqual([{ text: 'web/src/components', highlight: false }]);
    expect(res.nameSpans).toEqual([
      { text: 'File', highlight: true },
      { text: 'Browser.tsx', highlight: false },
    ]);
  });

  it('highlights across directory and filename when query contains slash', () => {
    const res = highlightFilePath('src/utils/calc.ts', 'utils/calc');
    expect(res.dir).toBe('src/utils');
    expect(res.name).toBe('calc.ts');
    expect(res.dirSpans).toEqual([
      { text: 'src/', highlight: false },
      { text: 'utils', highlight: true },
    ]);
    expect(res.nameSpans).toEqual([
      { text: 'calc', highlight: true },
      { text: '.ts', highlight: false },
    ]);
  });

  it('highlights across directory when characters span both', () => {
    const res = highlightFilePath('src/models/user.ts', 'smu');
    // 's' matches 's' in 'src', 'm' matches 'm' in 'models', 'u' matches 'u' in 'user.ts'
    expect(res.dirSpans.some((s) => s.highlight)).toBe(true);
    expect(res.nameSpans.some((s) => s.highlight)).toBe(true);
  });

  it('returns unhighlighted fallback when query does not match', () => {
    const res = highlightFilePath('src/index.ts', 'zzz');
    expect(res.dirSpans).toEqual([{ text: 'src', highlight: false }]);
    expect(res.nameSpans).toEqual([{ text: 'index.ts', highlight: false }]);
  });
});
