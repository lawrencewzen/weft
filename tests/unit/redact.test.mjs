import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactAuthText } from '../../src/core/redact.mjs';

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.signature1`;
}

test('redactAuthText masks JWT-shaped strings and sk- keys', () => {
  assert.equal(redactAuthText(`err ${jwt({ a: 1 })} sk-supersecret`), 'err jwt-*** sk-***');
  assert.equal(redactAuthText(null), '');
  assert.equal(redactAuthText('plain error').length <= 500, true);
});
