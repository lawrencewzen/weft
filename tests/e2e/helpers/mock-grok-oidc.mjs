/**
 * Test double for Grok device-code OIDC. Loaded with NODE_OPTIONS --import
 * so server.mjs's createGrokAuth() captures the patched fetch.
 */
import { GROK_DEVICE_CODE_URL, GROK_TOKEN_URL } from '../../../src/core/grok-auth.mjs';

const originalFetch = globalThis.fetch.bind(globalThis);
let polls = 0;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.signature1`;
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object' && 'url' in input) return String(input.url);
  return '';
}

globalThis.fetch = async function mockGrokFetch(input, init) {
  const url = urlOf(input);
  if (url === GROK_DEVICE_CODE_URL) {
    polls = 0;
    return json(200, {
      device_code: 'device-e2e-secret',
      user_code: 'WXYZ-1234',
      verification_uri: 'https://auth.x.ai/device',
      verification_uri_complete: 'https://auth.x.ai/device?user_code=WXYZ-1234',
      expires_in: 600,
      interval: 1,
    });
  }
  if (url === GROK_TOKEN_URL) {
    polls += 1;
    if (polls === 1) return json(400, { error: 'authorization_pending' });
    return json(200, {
      access_token: jwt({ sub: 'e2e-user', email: 'e2e@example.com', exp: 4_000_000_000 }),
      refresh_token: 'refresh-e2e-token',
      expires_in: 3600,
    });
  }
  return originalFetch(input, init);
};
