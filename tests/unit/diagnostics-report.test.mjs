import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import unzipper from 'unzipper';
import { createZip } from '../../src/core/zip.mjs';
import { buildReport, collectLogs, conversationJson, reportFileName, safeSettings } from '../../src/core/diagnostics-report.mjs';
import { registerDoctor, unregisterDoctor, runDoctor } from '../../src/core/doctor.mjs';

async function unzip(buffer) {
  const dir = await unzipper.Open.buffer(buffer);
  const out = {};
  for (const f of dir.files) out[f.path] = (await f.buffer()).toString('utf8');
  return out;
}

const FAKE_KEY = 'sk-testfake1234567890abcdef';
const FAKE_BEARER = 'abcDEF0123456789tokenvalue';

async function dataDirWithLogs(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-report-'));
  await mkdir(path.join(dir, 'logs'));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, 'logs', name), text);
  return dir;
}

test('createZip round-trips through unzipper, including UTF-8 names and empty and stored entries', async () => {
  const zip = createZip([
    { name: '说明/报告.txt', data: '你好，世界\n'.repeat(50) },
    { name: 'empty.txt', data: '' },
    { name: 'tiny.txt', data: 'x' },
  ]);
  const files = await unzip(zip);
  assert.equal(files['说明/报告.txt'], '你好，世界\n'.repeat(50));
  assert.equal(files['empty.txt'], '');
  assert.equal(files['tiny.txt'], 'x');
});

test('reportFileName is weft-report-YYYYMMDD-HHmmss.zip', () => {
  assert.equal(reportFileName(new Date(2026, 10, 3, 4, 5, 6)), 'weft-report-20261103-040506.zip');
});

test('safeSettings keeps only allow-listed fields and strips userinfo from baseUrl', () => {
  const out = safeSettings({
    version: 3,
    language: 'zh',
    apiKey: FAKE_KEY,
    token: FAKE_BEARER,
    headers: { authorization: `Bearer ${FAKE_BEARER}` },
    gitConnections: [{ token: FAKE_BEARER }],
    defaultModel: { providerId: 'p', modelId: 'm', apiKey: FAKE_KEY },
    providers: [{
      id: 'custom-1234abcd',
      kind: 'custom',
      name: '内网',
      api: 'openai-completions',
      baseUrl: `https://user:${FAKE_BEARER}@example.com/v1?key=${FAKE_KEY}`,
      apiKey: FAKE_KEY,
      headers: { 'x-api-key': FAKE_KEY },
      oauth: { access: FAKE_BEARER, refresh: FAKE_BEARER },
      overrides: { m1: { contextWindow: 1000, apiKey: FAKE_KEY } },
      enabled: true,
    }],
  });
  const text = JSON.stringify(out);
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!text.includes(FAKE_BEARER));
  assert.equal(out.providers[0].baseUrl, 'https://example.com/v1');
  assert.deepEqual(out.providers[0].overrides, { m1: { contextWindow: 1000 } });
  assert.equal(out.gitConnectionCount, 1);
  assert.deepEqual(out.defaultModel, { providerId: 'p', modelId: 'm' });
});

test('buildReport: selections control the files and secrets never appear', async () => {
  const dataDir = await dataDirWithLogs({
    'service.log': `2026-11-10 10:00:00.000 INFO  [X] Authorization: Bearer ${FAKE_BEARER} key ${FAKE_KEY} 中文日志\n`,
    'service.log.1': 'older\n',
    'service-stdio.log': `stdio apiKey=${FAKE_KEY}\n`,
  });
  const host = {
    version: '9.9.9',
    commit: 'abc1234',
    dataDir,
    startedAt: Date.now() - 5000,
    level: 'info',
    settings: { language: 'zh', apiKey: FAKE_KEY, providers: [] },
  };
  const full = await buildReport({ description: `坏了 token=${FAKE_BEARER}`, includeLogs: true, includeDoctor: true }, host);
  assert.deepEqual(full.files, ['report.txt', 'system.txt', 'doctor.txt', 'logs/service.log', 'logs/service.log.1', 'logs/service-stdio.log', 'settings.json']);
  const files = await unzip(full.buffer);
  assert.match(files['report.txt'], /坏了/);
  assert.match(files['system.txt'], /Weft version: 9\.9\.9/);
  assert.match(files['system.txt'], /git commit: abc1234/);
  assert.match(files['system.txt'], /Log level: info/);
  assert.match(files['doctor.txt'], /data directory\]\n.*writable/);
  assert.match(files['logs/service.log'], /中文日志/);
  for (const text of Object.values(files)) {
    assert.ok(!text.includes(FAKE_KEY), 'api key leaked');
    assert.ok(!text.includes(FAKE_BEARER), 'bearer leaked');
  }

  const bare = await buildReport({ description: '', includeLogs: false, includeDoctor: false }, host);
  assert.deepEqual(bare.files, ['report.txt', 'system.txt', 'settings.json']);
});

test('buildReport: conversation file is added only with a conversation', async () => {
  const dataDir = await dataDirWithLogs({});
  const host = { version: '1', dataDir, startedAt: Date.now(), level: 'info', settings: {} };
  const out = await buildReport({
    description: 'x', includeLogs: false, includeDoctor: false, conversationId: 'c-1',
    conversation: { id: 'c-1', title: '对话', messages: [{ role: 'user', content: 'hi' }] },
  }, host);
  assert.ok(out.files.includes('conversation-c-1.json'));
  const files = await unzip(out.buffer);
  assert.equal(JSON.parse(files['conversation-c-1.json']).messages[0].content, 'hi');
});

test('conversationJson clips long tool output, masks secret fields and redacts text', () => {
  const big = 'a'.repeat(50_000);
  const text = conversationJson({
    id: 'c', live: { x: 1 },
    messages: [{ role: 'tool', output: big, args: { apiKey: FAKE_KEY, note: `Bearer ${FAKE_BEARER}` }, maxTokens: 5 }],
  });
  const parsed = JSON.parse(text);
  assert.ok(parsed.messages[0].output.length < 21_000);
  assert.match(parsed.messages[0].output, /truncated 29520 characters/);
  assert.equal(parsed.live, undefined);
  assert.ok(!text.includes(FAKE_KEY));
  assert.ok(!text.includes(FAKE_BEARER));
  assert.equal(parsed.messages[0].maxTokens, 5);
});

test('conversationJson drops the oldest messages when over the size cap', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ i, text: 'z'.repeat(1000) }));
  const parsed = JSON.parse(conversationJson({ id: 'c', messages }, { maxBytes: 10_000 }));
  assert.ok(parsed.truncatedMessages > 0);
  assert.equal(parsed.messages.at(-1).i, 39);
});

test('collectLogs cuts the oldest content first and keeps the stdio tail', async () => {
  const line = (n) => `line-${String(n).padStart(4, '0')} ${'x'.repeat(90)}\n`;
  const cur = Array.from({ length: 50 }, (_, i) => line(1000 + i)).join('');
  const older = Array.from({ length: 50 }, (_, i) => line(i)).join('');
  const stdio = Array.from({ length: 100 }, (_, i) => line(5000 + i)).join('');
  const dataDir = await dataDirWithLogs({ 'service.log': cur, 'service.log.1': older, 'service.log.2': 'oldest\n', 'service-stdio.log': stdio });
  const entries = await collectLogs(dataDir, { budget: Buffer.byteLength(cur) + 1500, stdioBytes: 1000 });
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, ['logs/service.log', 'logs/service.log.1', 'logs/service-stdio.log']);
  assert.equal(entries[0].data, cur);
  const trimmed = entries[1].data;
  assert.match(trimmed, /older lines cut/);
  assert.ok(trimmed.includes('line-0049'));
  assert.ok(!trimmed.includes('line-0000'));
  const tail = entries[2].data;
  assert.ok(tail.includes('line-5099'));
  assert.ok(!tail.includes('line-5000'));
  assert.ok(tail.split('\n').filter((l) => l.startsWith('line-')).every((l) => l.length === 100), 'no partial line');
});

test('doctor: registered sections are appended and failures do not throw', async () => {
  const off = registerDoctor('unit', () => 'custom ok');
  registerDoctor('boom', () => { throw new Error('nope'); });
  try {
    const text = await runDoctor({ dataDir: tmpdir() });
    assert.match(text, /== base ==/);
    assert.match(text, /\[proxy\]/);
    assert.match(text, /== unit ==\ncustom ok/);
    assert.match(text, /== boom ==\ncheck failed: nope/);
  } finally {
    off();
    unregisterDoctor('boom');
  }
});
