import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyKernelToolDelta,
  createToolLive,
  deltaFromLive,
  markPublished,
} from '../../src/v2/stream/tool-delta.ts';

test('deltaFromLive appends, trims a prefix, and uses set for a full replacement', () => {
  const live = createToolLive();
  applyKernelToolDelta(live, { append: 'aabb' });
  assert.deepEqual(deltaFromLive(live), { offset: 0, append: 'aabb' });
  markPublished(live);

  applyKernelToolDelta(live, { trimStart: 2, append: 'cc' });
  assert.deepEqual(deltaFromLive(live), { offset: 2, append: 'cc', trimStart: 2 });
  markPublished(live);
  assert.equal(live.text, 'bbcc');

  applyKernelToolDelta(live, { set: 'zz' });
  assert.deepEqual(deltaFromLive(live), { set: 'zz' });
  markPublished(live);
  assert.equal(deltaFromLive(live), null);
});

test('applyKernelToolDelta ignores empty updates', () => {
  const live = createToolLive('keep');
  applyKernelToolDelta(live, {});
  assert.equal(live.text, 'keep');
  applyKernelToolDelta(live, { append: '' });
  assert.equal(live.text, 'keep');
});
