import type { Diff, DiffHunk } from './api';

export type DiffOp = 'ctx' | 'add' | 'del';

export type NumberedDiffLine = {
  op: DiffOp;
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type DiffRow =
  | { kind: 'hunk' }
  | { kind: 'line'; op: DiffOp; text: string; oldLine: number | null; newLine: number | null };

/** Assign 1-based old/new line numbers from a hunk start and its ops. */
export function numberDiffLines(
  hunk: { oldStart: number; newStart: number; lines: Array<{ op: DiffOp; text: string }> },
): NumberedDiffLine[] {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map((line) => {
    if (line.op === 'ctx') {
      const numbered: NumberedDiffLine = { op: 'ctx', text: line.text, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return numbered;
    }
    if (line.op === 'del') {
      const numbered: NumberedDiffLine = { op: 'del', text: line.text, oldLine, newLine: null };
      oldLine += 1;
      return numbered;
    }
    const numbered: NumberedDiffLine = { op: 'add', text: line.text, oldLine: null, newLine };
    newLine += 1;
    return numbered;
  });
}

function asOp(value: unknown): DiffOp {
  if (value === 'add' || value === 'del' || value === 'ctx') return value;
  return 'ctx';
}

function numberedFromHunk(hunk: DiffHunk): NumberedDiffLine[] {
  const computed = numberDiffLines({
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    lines: hunk.lines.map((line) => ({ op: asOp(line.op), text: line.text })),
  });
  return hunk.lines.map((line, i) => {
    const fallback = computed[i]!;
    const op = asOp(line.op);
    return {
      op,
      text: line.text,
      oldLine: line.oldLine == null ? fallback.oldLine : line.oldLine,
      newLine: line.newLine == null ? fallback.newLine : line.newLine,
    };
  });
}

export function flattenDiff(diff: Diff | null | undefined): DiffRow[] {
  if (!diff || diff.tooLarge) return [];
  const rows: DiffRow[] = [];
  for (const hunk of diff.hunks) {
    if (rows.length) rows.push({ kind: 'hunk' });
    for (const line of numberedFromHunk(hunk)) {
      rows.push({ kind: 'line', ...line });
    }
  }
  return rows;
}

export function changeHasDiff(change: { added: number; removed: number; error?: string | null }): boolean {
  if (change.error) return true;
  return (Number(change.added) || 0) !== 0 || (Number(change.removed) || 0) !== 0;
}

export function diffTotals(list: Array<{ added: number; removed: number }>): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const item of list) {
    added += Number(item.added) || 0;
    removed += Number(item.removed) || 0;
  }
  return { added, removed };
}

export function changeSignature(change: { path: string; added: number; removed: number; error?: string | null }): string {
  return `${change.path}\t${change.added}\t${change.removed}\t${change.error ?? ''}`;
}
