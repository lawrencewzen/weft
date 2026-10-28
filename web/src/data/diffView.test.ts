import { describe, expect, it } from 'vitest';
import {
  changeByTitle,
  changeHasDiff,
  changeSignature,
  diffTotals,
  flattenDiff,
  formatChangeBy,
  numberDiffLines,
  subagentDisplayName,
} from './diffView';
import type { Diff } from './api';

describe('numberDiffLines', () => {
  it('assigns old/new line numbers from hunk starts', () => {
    const numbered = numberDiffLines({
      oldStart: 10,
      newStart: 10,
      lines: [
        { op: 'ctx', text: 'keep' },
        { op: 'del', text: 'gone' },
        { op: 'add', text: 'new' },
        { op: 'ctx', text: 'after' },
      ],
    });
    expect(numbered).toEqual([
      { op: 'ctx', text: 'keep', oldLine: 10, newLine: 10 },
      { op: 'del', text: 'gone', oldLine: 11, newLine: null },
      { op: 'add', text: 'new', oldLine: null, newLine: 11 },
      { op: 'ctx', text: 'after', oldLine: 12, newLine: 12 },
    ]);
  });

  it('numbers an add-only hunk that starts at line 1', () => {
    const numbered = numberDiffLines({
      oldStart: 0,
      newStart: 1,
      lines: [
        { op: 'add', text: '今日' },
        { op: 'add', text: 'QA-FILE-1' },
      ],
    });
    expect(numbered).toEqual([
      { op: 'add', text: '今日', oldLine: null, newLine: 1 },
      { op: 'add', text: 'QA-FILE-1', oldLine: null, newLine: 2 },
    ]);
  });
});

describe('flattenDiff', () => {
  it('inserts hunk separators and keeps line numbers', () => {
    const diff: Diff = {
      path: 'a.ts',
      added: 1,
      removed: 1,
      tooLarge: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            { op: 'ctx', text: 'a', oldLine: 1, newLine: 1 },
            { op: 'del', text: 'b', oldLine: 2, newLine: null },
          ],
        },
        {
          oldStart: 8,
          oldLines: 1,
          newStart: 8,
          newLines: 2,
          lines: [
            { op: 'ctx', text: 'c', oldLine: 8, newLine: 8 },
            { op: 'add', text: 'd', oldLine: null, newLine: 9 },
          ],
        },
      ],
    };
    const rows = flattenDiff(diff);
    expect(rows.filter((row) => row.kind === 'hunk')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'line')).toHaveLength(4);
    const add = rows.find((row) => row.kind === 'line' && row.op === 'add');
    expect(add).toMatchObject({ kind: 'line', newLine: 9, oldLine: null, text: 'd' });
  });

  it('returns no rows when tooLarge', () => {
    expect(flattenDiff({
      path: 'big.ts',
      added: 0,
      removed: 0,
      hunks: [],
      tooLarge: true,
    })).toEqual([]);
  });
});

describe('change list helpers', () => {
  it('hides +0 −0 files unless they have an error', () => {
    expect(changeHasDiff({ added: 0, removed: 0 })).toBe(false);
    expect(changeHasDiff({ added: 1, removed: 0 })).toBe(true);
    expect(changeHasDiff({ added: 0, removed: 0, error: 'too large' })).toBe(true);
  });

  it('sums added/removed and fingerprints a change for refetch', () => {
    expect(diffTotals([{ added: 2, removed: 1 }, { added: 3, removed: 4 }])).toEqual({ added: 5, removed: 5 });
    expect(changeSignature({ path: 'a.md', added: 1, removed: 0, error: null }))
      .not.toBe(changeSignature({ path: 'a.md', added: 2, removed: 0, error: null }));
  });
});

describe('formatChangeBy', () => {
  it('formats main agent attribution in zh and en', () => {
    expect(formatChangeBy({ kind: 'main' }, 'zh')).toBe('主 Agent');
    expect(formatChangeBy({ kind: 'main' }, 'en')).toBe('Main agent');
  });

  it('formats subagent attribution with name in zh and en', () => {
    const sub = { kind: 'subagent' as const, agentId: 'c1:sub:sa-1', name: 'sub-load-order' };
    expect(formatChangeBy(sub, 'zh')).toBe('子 · sub-load-order');
    expect(formatChangeBy(sub, 'en')).toBe('Sub · sub-load-order');
  });

  it('falls back to the last segment of agentId when subagent name is empty or whitespace', () => {
    const emptyName = { kind: 'subagent' as const, agentId: 'c1:sub:sa-2', name: '' };
    expect(formatChangeBy(emptyName, 'zh')).toBe('子 · sa-2');
    expect(formatChangeBy(emptyName, 'en')).toBe('Sub · sa-2');

    const spacesName = { kind: 'subagent' as const, agentId: 'c1:sub:worker-1', name: '   ' };
    expect(formatChangeBy(spacesName, 'zh')).toBe('子 · worker-1');

    const bareId = { kind: 'subagent' as const, agentId: 'standalone-agent', name: '' };
    expect(formatChangeBy(bareId, 'zh')).toBe('子 · standalone-agent');
    expect(subagentDisplayName('standalone-agent', '')).toBe('standalone-agent');
  });

  it('returns null when by is null, undefined, or missing kind', () => {
    expect(formatChangeBy(null, 'zh')).toBeNull();
    expect(formatChangeBy(undefined, 'zh')).toBeNull();
    expect(formatChangeBy({ kind: 'other' } as unknown as { kind: 'main' }, 'zh')).toBeNull();
  });

  it('provides hover title for subagent (full name) and undefined for main/null', () => {
    expect(changeByTitle({ kind: 'subagent', agentId: 'c1:sub:sa-1', name: 'sub-load-order' })).toBe('sub-load-order');
    expect(changeByTitle({ kind: 'subagent', agentId: 'c1:sub:sa-2', name: '' })).toBe('sa-2');
    expect(changeByTitle({ kind: 'main' })).toBeUndefined();
    expect(changeByTitle(null)).toBeUndefined();
  });
});
