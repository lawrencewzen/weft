import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBashEnvAllowlist,
  bashChildEnv,
  parseBashEnvAllow,
  sensitiveEnvReason,
} from '../../src/kernel/bash-env.mjs';

function collect(source, extra, options = {}) {
  const warnings = [];
  const env = bashChildEnv(source, extra, {
    ...options,
    log: (message) => warnings.push(message),
    warned: new Set(),
  });
  return { env, warnings };
}

function unixBase() {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/home/weft',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    USER: 'weft',
    SHELL: '/bin/bash',
    HTTPS_PROXY: 'http://weft-test-proxy.example:8080',
    https_proxy: 'http://weft-test-proxy-lower.example:8080',
    WEFT_TEST_SECRET: 'weft-test-secret-value',
    OPENAI_API_KEY: 'sk-weft-test-openai-key',
    MY_BASH_CUSTOM: 'weft-allow-custom-ok',
    NOT_ALLOWED_CUSTOM: 'should-not-leak',
    GIT_ASKPASS: 'weft-askpass',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    TERM: 'xterm-256color',
  };
}

test('parseBashEnvAllow splits names and trailing wildcards', () => {
  assert.deepEqual(parseBashEnvAllow(' MY_APP_* , CI, '), ['MY_APP_*', 'CI']);
  assert.deepEqual(parseBashEnvAllow(''), []);
});

test('sensitive names include prefixes, exact denials, and KEY/TOKEN/SECRET/PASSWORD', () => {
  assert.equal(sensitiveEnvReason('WEFT_TOKEN') != null, true);
  assert.equal(sensitiveEnvReason('OPENAI_API_KEY') != null, true);
  assert.equal(sensitiveEnvReason('github_token') != null, true);
  assert.equal(sensitiveEnvReason('MY_APP_PASSWORD') != null, true);
  assert.equal(sensitiveEnvReason('GIT_ASKPASS') != null, true);
  assert.equal(sensitiveEnvReason('HTTPS_PROXY'), null);
  assert.equal(sensitiveEnvReason('PATH'), null);
  assert.equal(sensitiveEnvReason('MY_BASH_CUSTOM'), null);
});

test('bashChildEnv copies the allow-list and drops secrets, even with WEFT_BASH_ENV_ALLOW', () => {
  const { env, warnings } = collect({
    ...unixBase(),
    WEFT_BASH_ENV_ALLOW: 'MY_BASH_CUSTOM,OPENAI_API_KEY',
  });

  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/weft');
  assert.equal(env.LC_ALL, 'C.UTF-8');
  assert.equal(env.HTTPS_PROXY, 'http://weft-test-proxy.example:8080');
  assert.equal(env.https_proxy, 'http://weft-test-proxy-lower.example:8080');
  assert.equal(env.SSH_AUTH_SOCK, '/tmp/ssh.sock');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.MY_BASH_CUSTOM, 'weft-allow-custom-ok');
  assert.equal(env.NOT_ALLOWED_CUSTOM, undefined);
  assert.equal(env.WEFT_TEST_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GIT_ASKPASS, undefined);
  assert.equal(env.WEFT_BASH_ENV_ALLOW, undefined);
  assert.equal(warnings.some((line) => line.includes('OPENAI_API_KEY') && line.includes('WEFT_BASH_ENV')), true);
  assert.equal(warnings.some((line) => line.includes('weft-test-secret-value') || line.includes('sk-weft-test-openai-key')), false);
});

test('WEFT_BASH_ENV_ALLOW trailing * adds non-sensitive names', () => {
  const { env } = collect({
    PATH: '/bin',
    MY_BASH_CUSTOM: 'ok',
    MY_BASH_OTHER: 'also',
    MY_OTHER: 'nope',
    WEFT_BASH_ENV_ALLOW: 'MY_BASH_*',
  });
  assert.equal(env.MY_BASH_CUSTOM, 'ok');
  assert.equal(env.MY_BASH_OTHER, 'also');
  assert.equal(env.MY_OTHER, undefined);
});

test('TERM defaults to dumb when the host has none', () => {
  const { env } = collect({ PATH: '/bin' });
  assert.equal(env.TERM, 'dumb');
});

test('Windows matching is case-insensitive and keeps Path', () => {
  const { env, warnings } = collect({
    Path: 'C:\\Windows\\System32',
    HTTPS_PROXY: 'http://weft-test-proxy.example:8080',
    OpenAI_API_KEY: 'sk-weft-test-openai-key',
    Weft_Test_Secret: 'weft-test-secret-value',
    My_Bash_Custom: 'weft-allow-custom-ok',
    WEFT_BASH_ENV_ALLOW: 'my_bash_custom,openai_api_key',
  }, undefined, { platform: 'win32' });

  assert.equal(env.Path, 'C:\\Windows\\System32');
  assert.equal(env.PATH, undefined);
  assert.equal(env.HTTPS_PROXY, 'http://weft-test-proxy.example:8080');
  assert.equal(env.https_proxy, 'http://weft-test-proxy.example:8080');
  assert.equal(env.My_Bash_Custom, 'weft-allow-custom-ok');
  assert.equal(env.OpenAI_API_KEY, undefined);
  assert.equal(env.Weft_Test_Secret, undefined);
  assert.equal(warnings.some((line) => /openai_api_key/i.test(line)), true);
});

test('proxy names keep both casings on Windows, including when the host only set one', () => {
  const both = collect({
    PATH: 'C:\\Windows\\System32',
    HTTPS_PROXY: 'http://weft-test-proxy.example:8080',
    https_proxy: 'http://weft-test-proxy-lower.example:8080',
  }, undefined, { platform: 'win32' });
  assert.equal(both.env.HTTPS_PROXY, 'http://weft-test-proxy.example:8080');
  assert.equal(both.env.https_proxy, 'http://weft-test-proxy-lower.example:8080');

  const one = collect({
    HTTPS_PROXY: 'http://weft-test-proxy.example:8080',
  }, undefined, { platform: 'win32' });
  assert.equal(one.env.HTTPS_PROXY, 'http://weft-test-proxy.example:8080');
  assert.equal(one.env.https_proxy, 'http://weft-test-proxy.example:8080');
});

test('applyBashEnvAllowlist uses the official inheritEnv: false + env options', () => {
  const execution = { command: 'env', cwd: '/tmp', env: {}, inheritEnv: true };
  applyBashEnvAllowlist(execution, {
    PATH: '/bin',
    OPENAI_API_KEY: 'sk-weft-test-openai-key',
  }, { log() {}, warned: new Set() });
  assert.equal(execution.inheritEnv, false);
  assert.equal(execution.env.PATH, '/bin');
  assert.equal(execution.env.OPENAI_API_KEY, undefined);
  assert.equal(execution.env.TERM, 'dumb');
});
