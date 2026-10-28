import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendsView } from '../../src/v2/views/conversation.ts';

test('sendsView copies mode and text for inbox rows', () => {
  assert.deepEqual(sendsView([
    { requestId: 'r1', entryId: null, dropped: false, mode: 'queue', text: '稍后改主题' },
    { requestId: 'r2', entryId: 'e2', dropped: false, mode: 'steer', text: '插一句' },
  ]), [
    { requestId: 'r1', entryId: null, dropped: false, mode: 'queue', text: '稍后改主题' },
    { requestId: 'r2', entryId: 'e2', dropped: false, mode: 'steer', text: '插一句' },
  ]);
});

test('sendsView drops rows without requestId and defaults missing mode/text', () => {
  assert.deepEqual(sendsView([
    { entryId: 'x', dropped: false },
    { requestId: 'r3', entryId: null, dropped: true },
  ]), [
    { requestId: 'r3', entryId: null, dropped: true },
  ]);
});
