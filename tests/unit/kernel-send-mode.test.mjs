import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenBusyForMode } from '../../src/kernel/conversations.mjs';

test('mode maps onto Pi Durable whenBusy', () => {
  assert.equal(whenBusyForMode('queue'), 'followUp');
  assert.equal(whenBusyForMode('steer'), 'steer');
  assert.equal(whenBusyForMode(undefined), 'steer');
  assert.equal(whenBusyForMode('reject'), 'steer');
  assert.equal(whenBusyForMode(''), 'steer');
});
