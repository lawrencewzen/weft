import { describe, expect, it } from 'vitest';
import type { Change } from './store';
import {
  getShownChanges,
  isChangeSummaryCollapsible,
  remainingHiddenCount,
  sortChanges,
  splitChangePath,
} from './changeSummary';

function makeChange(path: string, added: number, removed: number): Change {
  return { path, added, removed, error: null, by: null };
}

describe('splitChangePath', () => {
  it('splits standard workspace relative path into filename and directory', () => {
    const res = splitChangePath('web/src/components/CenterPane.tsx');
    expect(res).toEqual({
      displayPath: 'web/src/components/CenterPane.tsx',
      name: 'CenterPane.tsx',
      dir: 'web/src/components/',
      outside: false,
    });
  });

  it('handles root-level relative files with empty dir', () => {
    const res = splitChangePath('README.md');
    expect(res).toEqual({
      displayPath: 'README.md',
      name: 'README.md',
      dir: '',
      outside: false,
    });
  });

  it('normalizes Windows backslashes in relative path', () => {
    const res = splitChangePath('web\\src\\styles\\app.css');
    expect(res).toEqual({
      displayPath: 'web/src/styles/app.css',
      name: 'app.css',
      dir: 'web/src/styles/',
      outside: false,
    });
  });

  it('abbreviates macOS /Users/<name> to ~ and flags outside workspace', () => {
    const res = splitChangePath('/Users/lawrence/.config/weft/notes.md');
    expect(res).toEqual({
      displayPath: '~/.config/weft/notes.md',
      name: 'notes.md',
      dir: '~/.config/weft/',
      outside: true,
    });
  });

  it('abbreviates Windows C:\\Users\\<name> to ~ and flags outside workspace', () => {
    const res = splitChangePath('C:\\Users\\alice\\.config\\weft\\notes.md');
    expect(res).toEqual({
      displayPath: '~/.config/weft/notes.md',
      name: 'notes.md',
      dir: '~/.config/weft/',
      outside: true,
    });
  });

  it('flags Windows non-user drive paths as outside workspace without ~', () => {
    const res = splitChangePath('D:\\projects\\secret.txt');
    expect(res).toEqual({
      displayPath: 'D:/projects/secret.txt',
      name: 'secret.txt',
      dir: 'D:/projects/',
      outside: true,
    });
  });

  it('flags non-user Unix absolute paths as outside workspace', () => {
    const res = splitChangePath('/etc/hosts');
    expect(res).toEqual({
      displayPath: '/etc/hosts',
      name: 'hosts',
      dir: '/etc/',
      outside: true,
    });
  });
});

describe('sortChanges', () => {
  it('sorts changes descending by added + removed', () => {
    const input: Change[] = [
      makeChange('low.txt', 1, 0),
      makeChange('huge.txt', 50, 50),
      makeChange('mid.txt', 10, 5),
    ];
    const sorted = sortChanges(input);
    expect(sorted.map((c) => c.path)).toEqual(['huge.txt', 'mid.txt', 'low.txt']);
  });

  it('breaks ties alphabetically by path', () => {
    const input: Change[] = [
      makeChange('b.txt', 2, 2),
      makeChange('a.txt', 3, 1),
      makeChange('c.txt', 4, 0),
    ];
    const sorted = sortChanges(input);
    expect(sorted.map((c) => c.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });
});

describe('collapsing threshold (6 all shown, 7 collapsed into 5 + 2)', () => {
  it('does not collapse 6 or fewer files', () => {
    const six: Change[] = [1, 2, 3, 4, 5, 6].map((i) => makeChange(`f${i}.txt`, i, 0));
    expect(isChangeSummaryCollapsible(six.length)).toBe(false);
    expect(getShownChanges(six, false)).toHaveLength(6);
    expect(getShownChanges(six, true)).toHaveLength(6);
  });

  it('collapses 7 files into 5 + 2', () => {
    const seven: Change[] = [1, 2, 3, 4, 5, 6, 7].map((i) => makeChange(`f${i}.txt`, i, 0));
    expect(isChangeSummaryCollapsible(seven.length)).toBe(true);

    // Collapsed: shows first 5
    const collapsed = getShownChanges(seven, false);
    expect(collapsed).toHaveLength(5);
    expect(remainingHiddenCount(seven.length)).toBe(2);

    // Expanded: shows all 7
    const expanded = getShownChanges(seven, true);
    expect(expanded).toHaveLength(7);
  });

  it('collapses 8 files into 5 + 3', () => {
    const eight: Change[] = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => makeChange(`f${i}.txt`, i, 0));
    expect(isChangeSummaryCollapsible(eight.length)).toBe(true);
    expect(getShownChanges(eight, false)).toHaveLength(5);
    expect(remainingHiddenCount(eight.length)).toBe(3);
    expect(getShownChanges(eight, true)).toHaveLength(8);
  });
});
