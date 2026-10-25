/** Split into lines; trailing newline and CRLF are not counted as extra lines.
 * A file that is only a newline (what an emptied editor often saves) matches an empty baseline. */
export function splitLines(text) {
  if (text == null || text === '') return [];
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 1 && lines[0] === '') return [];
  return lines;
}

function lcsLengths(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function diffOps(a, b) {
  const dp = lcsLengths(a, b);
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: 'equal', line: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: 'remove', line: a[i - 1] });
      i--;
    } else {
      ops.push({ type: 'add', line: b[j - 1] });
      j--;
    }
  }
  while (i > 0) ops.push({ type: 'remove', line: a[--i] });
  while (j > 0) ops.push({ type: 'add', line: b[--j] });
  ops.reverse();
  return ops;
}

export function diffStats(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'remove') removed++;
  }
  return { added, removed };
}

function hunkHeader(oldStart, oldCount, newStart, newCount) {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/** Shared hunks for unified and structured diffs (3 lines of context). */
export function diffHunks(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const { added, removed } = diffStats(oldText, newText);
  const ops = diffOps(a, b);
  if (!ops.some((op) => op.type !== 'equal')) return { added, removed, hunks: [] };

  const indexed = [];
  let oi = 0;
  let ni = 0;
  for (const op of ops) {
    if (op.type === 'equal') {
      oi++;
      ni++;
      indexed.push({ ...op, oldLine: oi, newLine: ni });
    } else if (op.type === 'remove') {
      oi++;
      indexed.push({ ...op, oldLine: oi, newLine: ni });
    } else {
      ni++;
      indexed.push({ ...op, oldLine: oi, newLine: ni });
    }
  }

  const context = 3;
  const changeIdx = [];
  for (let i = 0; i < indexed.length; i++) if (indexed[i].type !== 'equal') changeIdx.push(i);
  if (changeIdx.length === 0) return { added, removed, hunks: [] };

  const ranges = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(indexed.length - 1, changeIdx[0] + context);
  for (let k = 1; k < changeIdx.length; k++) {
    const ci = changeIdx[k];
    if (ci - context <= end + 1) {
      end = Math.min(indexed.length - 1, ci + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, ci - context);
      end = Math.min(indexed.length - 1, ci + context);
    }
  }
  ranges.push([start, end]);

  const hunks = [];
  for (const [hs, he] of ranges) {
    const slice = indexed.slice(hs, he + 1);
    let oldLines = 0;
    let newLines = 0;
    for (const op of slice) {
      if (op.type === 'equal' || op.type === 'remove') oldLines++;
      if (op.type === 'equal' || op.type === 'add') newLines++;
    }
    let oldStart;
    let newStart;
    const firstOld = slice.find((op) => op.type === 'equal' || op.type === 'remove');
    const firstNew = slice.find((op) => op.type === 'equal' || op.type === 'add');
    if (oldLines === 0) oldStart = slice[0]?.oldLine ?? 0;
    else oldStart = firstOld.oldLine;
    if (newLines === 0) newStart = slice[0]?.newLine ?? 0;
    else newStart = firstNew.newLine;
    if (oldLines === 0 && a.length === 0) oldStart = 0;
    if (newLines === 0 && b.length === 0) newStart = 0;
    const lines = [];
    for (const op of slice) {
      if (op.type === 'equal') {
        lines.push({ op: 'ctx', text: op.line, oldLine: op.oldLine, newLine: op.newLine });
      } else if (op.type === 'remove') {
        lines.push({ op: 'del', text: op.line, oldLine: op.oldLine, newLine: null });
      } else {
        lines.push({ op: 'add', text: op.line, oldLine: null, newLine: op.newLine });
      }
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, lines });
  }
  return { added, removed, hunks };
}

/**
 * Diff the stored baseline against the file's current text.
 * `diskText === undefined` means the disk read failed and the stored snapshot is used.
 * `diskText === null` or `''` means the file is missing or empty.
 */
export function liveDiff({ path: filePath, before, storedAfter, diskText }) {
  const oldText = before ?? '';
  const after = diskText === undefined ? (storedAfter ?? '') : (diskText ?? '');
  const { added, removed } = diffStats(oldText, after);
  return {
    path: filePath,
    before: oldText,
    after,
    unified: unifiedDiff(filePath, oldText, after),
    added,
    removed,
  };
}

/** Unified diff with 3 lines of context. */
export function unifiedDiff(filePath, oldText, newText) {
  const { hunks } = diffHunks(oldText, newText);
  const parts = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of hunks) {
    parts.push(hunkHeader(hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines));
    for (const line of hunk.lines) {
      if (line.op === 'ctx') parts.push(` ${line.text}`);
      else if (line.op === 'del') parts.push(`-${line.text}`);
      else parts.push(`+${line.text}`);
    }
  }
  return `${parts.join('\n')}\n`;
}

/** Structured hunks that match unifiedDiff line-for-line. */
export function structuredDiff(filePath, oldText, newText) {
  const { added, removed, hunks } = diffHunks(oldText, newText);
  return { path: filePath, added, removed, hunks };
}
