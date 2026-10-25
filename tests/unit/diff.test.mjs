import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';
const { diffStats, unifiedDiff, liveDiff, structuredDiff } = await load('src/core/diff.mjs');

function unifiedFromStructured(filePath, structured) {
  const parts = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const hunk of structured.hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.op === 'ctx') parts.push(` ${line.text}`);
      else if (line.op === 'del') parts.push(`-${line.text}`);
      else parts.push(`+${line.text}`);
    }
  }
  return `${parts.join('\n')}\n`;
}

test('new file counts all lines added', () => {
  assert.deepEqual(diffStats(null, 'a\nb\nc\n'), { added: 3, removed: 0 });
  assert.deepEqual(diffStats('', 'a'), { added: 1, removed: 0 });
});
test('deleted content', () => {
  assert.deepEqual(diffStats('a\nb\n', ''), { added: 0, removed: 2 });
});
test('modification counts replaced lines on both sides', () => {
  assert.deepEqual(diffStats('a\nb\nc\n', 'a\nB\nc\nd\n'), { added: 2, removed: 1 });
});
test('identical and trailing-newline-only change is zero', () => {
  assert.deepEqual(diffStats('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 });
  assert.deepEqual(diffStats('a\nb', 'a\nb\n'), { added: 0, removed: 0 });
});
test('CRLF treated same as LF', () => {
  assert.deepEqual(diffStats('a\r\nb\r\n', 'a\nb\n'), { added: 0, removed: 0 });
});
test('unifiedDiff has headers and hunks consistent with stats', () => {
  const u = unifiedDiff('src/x.md', 'a\nb\n', 'a\nc\n');
  assert.match(u, /^--- a\/src\/x\.md$/m);
  assert.match(u, /^\+\+\+ b\/src\/x\.md$/m);
  assert.match(u, /^@@ /m);
  assert.match(u, /^-b$/m);
  assert.match(u, /^\+c$/m);
});

test('live diff prefers the file on disk over the stored snapshot', () => {
  const live = liveDiff({
    path: 'notes/today.md',
    before: '今日\nQA-FILE-1\n',
    storedAfter: '今日\nQA-FILE-1\n',
    diskText: '今日\nQA-FILE-1\nQA-EDIT-2\n',
  });
  assert.equal(live.added, 1);
  assert.equal(live.removed, 0);
  assert.match(live.unified, /\+QA-EDIT-2/);
  assert.equal(live.after.includes('QA-EDIT-2'), true);
  const missing = liveDiff({
    path: 'notes/today.md',
    before: '今日\n',
    storedAfter: '今日\nQA-FILE-1\n',
    diskText: '',
  });
  assert.equal(missing.after, '');
  assert.equal(missing.removed, 1);
  const unread = liveDiff({
    path: 'notes/today.md',
    before: '',
    storedAfter: 'stored\n',
    diskText: undefined,
  });
  assert.equal(unread.after, 'stored\n');
});

test('structuredDiff hunks reconstruct the same unified text', () => {
  const cases = [
    ['new.txt', '', 'a\nb\nc\n'],
    ['del.txt', 'a\nb\n', ''],
    ['edit.txt', 'a\nb\nc\n', 'a\nB\nc\nd\n'],
    ['same.txt', 'a\nb\n', 'a\nb\n'],
    ['ctx.txt', '1\n2\n3\n4\n5\n6\n7\n', '1\n2\n3\nX\n5\n6\n7\n'],
  ];
  for (const [filePath, before, after] of cases) {
    const unified = unifiedDiff(filePath, before, after);
    const structured = structuredDiff(filePath, before, after);
    assert.equal(unifiedFromStructured(filePath, structured), unified, filePath);
    const stats = diffStats(before, after);
    assert.equal(structured.added, stats.added, `${filePath} added`);
    assert.equal(structured.removed, stats.removed, `${filePath} removed`);
  }
});
