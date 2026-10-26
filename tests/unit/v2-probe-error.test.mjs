import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProbeFailure,
  formatProbeFailure,
  formatProbeFailureForLang,
  sourceProbeStatus,
  sourceProbeStatusForLang,
  phraseTranslate,
} from '../../src/v2/views/probe-error.ts';

function say(lang, input) {
  return formatProbeFailureForLang(input, lang);
}

test('classifies probe failures from code first, then from the error text', () => {
  assert.equal(classifyProbeFailure({ code: 'timeout', error: 'fetch failed' }).kind, 'timeout');
  assert.equal(classifyProbeFailure({ error: 'fetch failed' }).kind, 'network');
  assert.equal(classifyProbeFailure({ error: 'connect ECONNREFUSED 127.0.0.1:9' }).kind, 'network');
  assert.equal(classifyProbeFailure({ error: 'timeout' }).kind, 'timeout');
  assert.equal(classifyProbeFailure({ error: 'invalid JSON' }).kind, 'bad_json');
  assert.equal(classifyProbeFailure({ error: 'HTTP 401' }).kind, 'auth');
  assert.equal(classifyProbeFailure({ error: 'HTTP 403' }).kind, 'auth');
  assert.equal(classifyProbeFailure({ error: 'HTTP 404' }).kind, 'not_found');
  assert.equal(classifyProbeFailure({ code: 'http', status: 502, error: 'overloaded' }).kind, 'http');
  assert.equal(classifyProbeFailure({ error: 'model is warming up' }).kind, '');
  assert.equal(classifyProbeFailure({ error: 'model is warming up' }).detail, 'model is warming up');
  assert.equal(classifyProbeFailure({ code: 'auth', error: 'HTTP 401' }).detail, '');
  assert.equal(classifyProbeFailure({ code: 'auth', error: 'Incorrect API key provided' }).detail, 'Incorrect API key provided');
});

test('localizes the five probe failures in Chinese and English', () => {
  const cases = [
    [{ code: 'network', error: 'fetch failed' }, '连不上', 'Unreachable'],
    [{ code: 'network', error: 'connect ECONNREFUSED 127.0.0.1:9' }, '连不上', 'Unreachable'],
    [{ code: 'timeout', error: 'timeout' }, '超时', 'Timed out'],
    [{ code: 'bad_json', error: 'invalid JSON' }, '返回格式不对', 'Invalid response format'],
    [{ code: 'auth', status: 401, error: 'HTTP 401' }, '鉴权失败', 'Authentication failed'],
    [{ code: 'not_found', status: 404, error: 'HTTP 404' }, '找不到接口', 'Endpoint not found'],
  ];
  for (const [input, zh, en] of cases) {
    assert.equal(say('zh', input), zh);
    assert.equal(say('en', input), en);
  }
});

test('keeps an unrecognized vendor message after the localized label', () => {
  const auth = { code: 'auth', status: 401, error: 'Incorrect API key provided' };
  assert.equal(say('zh', auth), '鉴权失败：Incorrect API key provided');
  assert.equal(say('en', auth), 'Authentication failed: Incorrect API key provided');

  const http = { code: 'http', status: 502, error: 'upstream overloaded' };
  assert.equal(say('zh', http), '其他 HTTP 错误（502）：upstream overloaded');
  assert.equal(say('en', http), 'Other HTTP error (502): upstream overloaded');

  const unknown = { error: 'model is warming up' };
  assert.equal(say('zh', unknown), '请求失败：model is warming up');
  assert.equal(say('en', unknown), 'Request failed: model is warming up');

  assert.equal(say('zh', { code: 'http', error: 'HTTP 500' }), '其他 HTTP 错误（500）');
  assert.equal(say('zh', { error: 'HTTP 403' }), '鉴权失败');
});

test('source rows use the same mapping, and Ollama keeps its network status', () => {
  const offline = { lastTest: { ok: false, error: 'fetch failed', code: 'network' } };
  assert.equal(sourceProbeStatusForLang({ ...offline, vendor: 'openai' }, 'offline', 'zh'), '连不上');
  assert.equal(sourceProbeStatusForLang({ ...offline, vendor: 'ollama' }, 'offline', 'zh'), 'Ollama 没启动');
  assert.equal(sourceProbeStatusForLang({
    vendor: 'openai',
    lastTest: { ok: false, error: 'timeout', code: 'timeout' },
  }, 'offline', 'zh'), '超时');
  assert.equal(sourceProbeStatusForLang({
    vendor: 'ollama',
    lastTest: { ok: false, error: 'HTTP 404', code: 'not_found', status: 404 },
  }, 'offline', 'zh'), '找不到接口');
  assert.equal(sourceProbeStatusForLang({ vendor: 'openai' }, 'no_key', 'zh'), '缺 Key');
  assert.equal(sourceProbeStatusForLang({ ...offline, vendor: 'openai' }, 'offline', 'en'), 'Unreachable');
  assert.equal(sourceProbeStatusForLang({ ...offline, vendor: 'ollama' }, 'offline', 'en'), 'Ollama is not running');

  assert.equal(
    sourceProbeStatus({ ...offline, vendor: 'ollama' }, 'offline', phraseTranslate('zh')),
    'Ollama 没启动',
  );
});

test('formatProbeFailure accepts a phrase translate', () => {
  const input = { code: 'auth', status: 401, error: 'Incorrect API key provided' };
  assert.equal(
    formatProbeFailure(input, phraseTranslate('en')),
    'Authentication failed: Incorrect API key provided',
  );
});
