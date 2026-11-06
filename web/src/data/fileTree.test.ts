import { describe, expect, it } from 'vitest';
import {
  defaultExpanded,
  expandAncestors,
  isMarkdownPath,
  toggleDir,
  visibleTreeRows,
} from './fileTree';

const entries = [
  { path: 'notes', type: 'dir' as const },
  { path: 'notes/today.md', type: 'file' as const },
  { path: 'live', type: 'dir' as const },
  { path: 'live/qa-file-live.txt', type: 'file' as const },
];

describe('file tree expand state', () => {
  it('shows every row when all directories start expanded', () => {
    const expanded = defaultExpanded(entries);
    expect([...expanded].sort()).toEqual(['live', 'notes']);
    const rows = visibleTreeRows(entries, expanded);
    expect(rows.map((row) => row.path)).toEqual([
      'notes',
      'notes/today.md',
      'live',
      'live/qa-file-live.txt',
    ]);
    expect(rows.find((row) => row.path === 'notes')?.expanded).toBe(true);
    expect(rows.find((row) => row.path === 'notes/today.md')?.depth).toBe(1);
  });

  it('hides children when a directory is collapsed', () => {
    let expanded = defaultExpanded(entries);
    expanded = toggleDir(expanded, 'notes');
    const rows = visibleTreeRows(entries, expanded);
    expect(rows.map((row) => row.path)).toEqual(['notes', 'live', 'live/qa-file-live.txt']);
    expect(rows.find((row) => row.path === 'notes')?.expanded).toBe(false);
  });

  it('re-expands ancestors so an opened file is visible', () => {
    let expanded = toggleDir(defaultExpanded(entries), 'notes');
    expanded = expandAncestors(expanded, 'notes/today.md');
    const rows = visibleTreeRows(entries, expanded);
    expect(rows.some((row) => row.path === 'notes/today.md')).toBe(true);
  });

  it('treats .md as markdown regardless of case', () => {
    expect(isMarkdownPath('notes/today.md')).toBe(true);
    expect(isMarkdownPath('README.MD')).toBe(true);
    expect(isMarkdownPath('live/qa-file-live.txt')).toBe(false);
  });

  it('marks ignored files and directories and propagates ignored to child items', () => {
    const treeWithIgnored = [
      { path: 'package.json', type: 'file' as const },
      { path: 'secret.log', type: 'file' as const, ignored: true },
      { path: 'dist', type: 'dir' as const, ignored: true },
      { path: 'dist/bundle.js', type: 'file' as const },
      { path: 'node_modules', type: 'dir' as const, ignored: true },
      { path: 'node_modules/pkg', type: 'dir' as const },
      { path: 'node_modules/pkg/index.js', type: 'file' as const },
      { path: 'src', type: 'dir' as const },
      { path: 'src/main.ts', type: 'file' as const },
    ];
    const expanded = new Set(['dist', 'node_modules', 'node_modules/pkg', 'src']);
    const rows = visibleTreeRows(treeWithIgnored, expanded);

    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get('package.json')?.ignored).toBeUndefined();
    expect(byPath.get('src')?.ignored).toBeUndefined();
    expect(byPath.get('src/main.ts')?.ignored).toBeUndefined();

    expect(byPath.get('secret.log')?.ignored).toBe(true);
    expect(byPath.get('dist')?.ignored).toBe(true);
    expect(byPath.get('dist/bundle.js')?.ignored).toBe(true);
    expect(byPath.get('node_modules')?.ignored).toBe(true);
    expect(byPath.get('node_modules/pkg')?.ignored).toBe(true);
    expect(byPath.get('node_modules/pkg/index.js')?.ignored).toBe(true);
  });
});
