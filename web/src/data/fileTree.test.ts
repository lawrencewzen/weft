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
});
