// Vendored hashline core (src/vendor/hashline): hash, format, parse, apply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyHashlineEdits } from '../../src/vendor/hashline/apply.mjs';
import { formatHashlineRegion, splitVisibleLines } from '../../src/vendor/hashline/format.mjs';
import { NIBBLE_STR, computeLineHash, xxh32 } from '../../src/vendor/hashline/hash.mjs';
import { resolveEditAnchors } from '../../src/vendor/hashline/parse.mjs';

const anchorOf = (lines, n) => `${n}#${computeLineHash(lines, n - 1)}`;
const apply = (text, edits) => applyHashlineEdits(text, resolveEditAnchors(edits));

test('xxh32 matches the reference vectors (seed 0)', () => {
  assert.equal(xxh32(Buffer.from(''), 0), 0x02cc5d05);
  assert.equal(xxh32(Buffer.from('a'), 0), 0x550d7456);
  assert.equal(xxh32(Buffer.from('abc'), 0), 0x32d153ff);
  assert.equal(xxh32(Buffer.from('Nobody inspects the spammish repetition'), 0), 0xe2293b2f);
});

test('line hashes are three alphabet characters, stable, and depend on neighbours', () => {
  const lines = ['alpha', 'beta', 'gamma'];
  const hash = computeLineHash(lines, 1);
  assert.match(hash, new RegExp(`^[${NIBBLE_STR}]{3}$`));
  assert.equal(computeLineHash(lines, 1), hash);
  assert.notEqual(computeLineHash(['alpha', 'beta', 'delta'], 1), hash);
  assert.equal(computeLineHash(['alpha\r', 'beta  ', 'gamma'], 1), hash, 'CR and trailing blanks are ignored');
});

test('formatHashlineRegion renders padded LINE#HASH:content', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  const out = formatHashlineRegion(lines, 9, 11).split('\n');
  assert.equal(out[0], ` 9#${computeLineHash(lines, 8)}:line 9`);
  assert.equal(out[2], `11#${computeLineHash(lines, 10)}:line 11`);
  assert.deepEqual(splitVisibleLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitVisibleLines(''), []);
});

test('replace: single line, range, and delete', () => {
  const text = 'a\nb\nc\nd\n';
  const lines = splitVisibleLines(text);
  assert.equal(apply(text, [{ op: 'replace', pos: anchorOf(lines, 2), lines: ['B'] }]).content, 'a\nB\nc\nd\n');
  assert.equal(
    apply(text, [{ op: 'replace', pos: anchorOf(lines, 2), end: anchorOf(lines, 3), lines: ['X', 'Y', 'Z'] }]).content,
    'a\nX\nY\nZ\nd\n',
  );
  assert.equal(apply(text, [{ op: 'replace', pos: anchorOf(lines, 2), end: anchorOf(lines, 3), lines: [] }]).content, 'a\nd\n');
  assert.equal(apply(text, [{ op: 'replace', pos: anchorOf(lines, 4), lines: [] }]).content, 'a\nb\nc\n');
});

test('append and prepend: at an anchor and at the file boundaries', () => {
  const text = 'a\nb\n';
  const lines = splitVisibleLines(text);
  assert.equal(apply(text, [{ op: 'append', pos: anchorOf(lines, 1), lines: ['x'] }]).content, 'a\nx\nb\n');
  assert.equal(apply(text, [{ op: 'prepend', pos: anchorOf(lines, 2), lines: ['x'] }]).content, 'a\nx\nb\n');
  assert.equal(apply(text, [{ op: 'append', lines: ['end'] }]).content, 'a\nb\nend\n');
  assert.equal(apply(text, [{ op: 'prepend', lines: ['top'] }]).content, 'top\na\nb\n');
  assert.equal(apply('', [{ op: 'append', lines: ['first'] }]).content, 'first');
});

test('several edits are checked against one snapshot and applied together', () => {
  const text = 'a\nb\nc\nd\ne\n';
  const lines = splitVisibleLines(text);
  const out = apply(text, [
    { op: 'replace', pos: anchorOf(lines, 1), lines: ['A', 'A2'] },
    { op: 'replace', pos: anchorOf(lines, 5), lines: ['E'] },
  ]);
  assert.equal(out.content, 'A\nA2\nb\nc\nd\nE\n');
});

test('a stale hash is refused with E_STALE_ANCHOR and a content-matched candidate', () => {
  const text = 'a\nb\nc\n';
  const lines = splitVisibleLines(text);
  const stale = anchorOf(lines, 2);
  const moved = 'new\na\nb\nc\n';
  assert.throws(() => apply(moved, [{ op: 'replace', pos: stale, lines: ['x'] }]), /E_STALE_ANCHOR.*2#/);
  const hinted = `${stale}:b`;
  assert.throws(() => apply(moved, [{ op: 'replace', pos: hinted, lines: ['x'] }]), /Did you mean[\s\S]*3#/);
});

test('bad references, out-of-range lines, overlapping edits and rendered prefixes are rejected', () => {
  const text = 'a\nb\nc\n';
  const lines = splitVisibleLines(text);
  assert.throws(() => resolveEditAnchors([{ op: 'replace', pos: '2', lines: [] }]), /E_BAD_REF/);
  assert.throws(() => resolveEditAnchors([{ op: 'nope', lines: [] }]), /E_BAD_OP/);
  assert.throws(() => resolveEditAnchors([{ op: 'replace', pos: anchorOf(lines, 1), lines: [`2#${computeLineHash(lines, 1)}:b`] }]), /E_INVALID_PATCH/);
  assert.throws(() => apply(text, [{ op: 'replace', pos: `9#${computeLineHash(lines, 1)}`, lines: ['x'] }]), /E_RANGE_OOB/);
  assert.throws(
    () => apply(text, [
      { op: 'replace', pos: anchorOf(lines, 1), end: anchorOf(lines, 2), lines: ['x'] },
      { op: 'replace', pos: anchorOf(lines, 2), lines: ['y'] },
    ]),
    /E_EDIT_CONFLICT/,
  );
  assert.throws(() => apply(text, [{ op: 'replace', pos: anchorOf(lines, 1), end: anchorOf(lines, 3), lines: [] }]), /E_WOULD_EMPTY/);
});

test('an identical replacement is reported as a no-op', () => {
  const text = 'a\nb\n';
  const lines = splitVisibleLines(text);
  const out = apply(text, [{ op: 'replace', pos: anchorOf(lines, 1), lines: ['a'] }]);
  assert.equal(out.content, text);
  assert.equal(out.noopEdits.length, 1);
});
