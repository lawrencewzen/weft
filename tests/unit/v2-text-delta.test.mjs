import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTextLive,
  publishedText,
  takeTextDelta,
  unpublishedText,
} from '../../src/v2/stream/text-delta.ts';

test('takeTextDelta appends from the published offset and is a no-op when caught up', () => {
  const live = createTextLive();
  live.text += 'ab';
  assert.equal(publishedText(live), '');
  assert.equal(unpublishedText(live), 'ab');
  assert.deepEqual(takeTextDelta(live), { offset: 0, append: 'ab' });
  assert.equal(live.published, 2);
  assert.equal(publishedText(live), 'ab');
  assert.equal(takeTextDelta(live), null);

  live.text += 'cd';
  assert.deepEqual(takeTextDelta(live), { offset: 2, append: 'cd' });
  assert.equal(live.published, 4);
  assert.equal(unpublishedText(live), '');
});

test('createTextLive seeds both text and published length', () => {
  const live = createTextLive('hi');
  assert.equal(live.text, 'hi');
  assert.equal(live.published, 2);
  assert.equal(takeTextDelta(live), null);
});
