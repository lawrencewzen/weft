import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { compileSchema } from '../../src/v2/validate.ts';
import {
  en,
  lookupPhraseFrom,
  phrase,
  zh,
} from '../../src/v2/phrases/index.ts';
import {
  TOOL_KINDS,
  clipOutputText,
  isProbeFailure,
  outputLineCount,
  relativizePath,
  relativizeText,
  summarizeToolGroup,
  toolCallView,
  toolDiffCounts,
  toolFileLabel,
  toolGroupKey,
  toolGroupPreview,
  toolGroupSummaryView,
  toolResultHint,
  toolRowHeading,
  unwrapHarnessDiagnostics,
} from '../../src/v2/views/tools.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validateToolCall = compileSchema(structuredClone(spec.components.schemas.ToolCall));
const validateToolGroupSummary = compileSchema(structuredClone(spec.components.schemas.ToolGroupSummary));

function tool(name, extra = {}) {
  return { id: extra.id || name, name, status: extra.status || 'completed', ...extra };
}

function assertValidToolCall(view, label) {
  const ok = validateToolCall(view);
  assert.equal(ok, true, `${label}: ${JSON.stringify(validateToolCall.errors)}`);
}

test('six reads and one listing name the first files instead of counting only', () => {
  const tools = [
    ...['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'].map((p, i) => tool('read', { id: `r${i}`, path: p })),
    tool('ls', { id: 'ls1', path: 'src' }),
  ];
  const summary = summarizeToolGroup(tools, 'zh');
  assert.equal(summary.text, '读了 a.js、b.js 等 6 个文件 · 列出 src');
  assert.equal(summary.failed, 0);
  assert.equal(summary.running, false);
});

test('changed files outrank failures, commands, and counts', () => {
  const summary = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'a.js' }),
    tool('read', { id: 'r2', path: 'b.js' }),
    tool('bash', { id: 'b1', input: { command: 'npm test' } }),
    tool('bash', { id: 'b2', input: { command: 'npm run check --silent --extra-long-flag-name' } }),
    tool('edit', { id: 'e1', path: 'src/api/auth.ts' }),
    tool('write', { id: 'w1', path: 'src/store/redis.ts' }),
    tool('read', { id: 'r3', path: 'prompts', status: 'error' }),
  ], 'zh');
  assert.equal(
    summary.text,
    '改了 auth.ts、redis.ts · 读取 prompts 失败 · 运行 npm test、npm run check --silent --extra-long-fla… · 读了 a.js、b.js',
  );
  assert.equal(summary.failed, 1);
});

test('more than three changed files add an etc count', () => {
  const summary = summarizeToolGroup([
    tool('write', { id: 'w1', path: 'a.ts' }),
    tool('edit', { id: 'e1', path: 'b.ts' }),
    tool('write', { id: 'w2', path: 'c.ts' }),
    tool('edit', { id: 'e2', path: 'd.ts' }),
    tool('write', { id: 'w3', path: 'e.ts' }),
  ], 'zh');
  assert.equal(summary.text, '改了 a.ts、b.ts、c.ts 等 2 个');
});

test('commands are truncated to two, reads only count', () => {
  const summary = summarizeToolGroup([
    tool('bash', { id: 'b1', input: { command: 'npm test' } }),
    tool('bash', { id: 'b2', input: { command: 'npm run check' } }),
    tool('bash', { id: 'b3', input: { command: 'npm start' } }),
    tool('grep', { id: 'g1', input: { pattern: 'foo' } }),
    tool('ls', { id: 'ls1', path: 'src' }),
  ], 'zh');
  assert.equal(summary.text, '运行 npm test、npm run check · 搜索 foo · 列出 src');
});

test('a single call names the file or command', () => {
  assert.equal(summarizeToolGroup([tool('read', { path: 'package.json' })], 'zh').text, '读取了 package.json');
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' } })], 'zh').text,
    '运行 npm test',
  );
  assert.equal(summarizeToolGroup([tool('write', { path: 'src/api/auth.ts' })], 'zh').text, '改了 auth.ts');
  assert.equal(summarizeToolGroup([tool('ls', { path: '.' })], 'zh').text, '列出 1 个目录');
});

test('a description is the single-call summary, running action, and row title', () => {
  const bash = tool('bash', { input: { command: 'npm test', description: '跑单元测试' } });
  assert.equal(summarizeToolGroup([bash], 'zh').text, '跑单元测试');
  assert.equal(
    summarizeToolGroup([tool('bash', { id: 'b1', input: bash.input, status: 'running' })], 'zh').text,
    '跑单元测试',
  );
  assert.deepEqual(toolRowHeading(bash), { title: '跑单元测试', detail: 'npm test', intent: true });
  assert.equal(
    summarizeToolGroup([tool('read', { path: 'src/login.js', input: { path: 'src/login.js', description: '看登录逻辑' } })], 'zh').text,
    '看登录逻辑',
  );
  assert.deepEqual(
    toolRowHeading(tool('read', { path: 'src/login.js', input: { path: 'src/login.js', description: '看登录逻辑' } })),
    { title: '看登录逻辑', detail: 'src/login.js', intent: true },
  );
  const runningGroup = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'a.js' }),
    tool('bash', { id: 'b1', input: { command: 'npm test', description: '跑单元测试' }, status: 'running' }),
  ], 'zh');
  assert.equal(runningGroup.text, '跑单元测试');
  assert.equal(runningGroup.running, true);
});

test('without a description, summaries and row titles stay on the command or path', () => {
  const bash = tool('bash', { input: { command: 'npm test' } });
  assert.equal(summarizeToolGroup([bash], 'zh').text, '运行 npm test');
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' }, status: 'running' })], 'zh').text,
    '正在运行 `npm test`…',
  );
  assert.deepEqual(toolRowHeading(bash), { title: 'npm test', detail: '', intent: false });
  assert.deepEqual(
    toolRowHeading(tool('read', { path: 'app.js' })),
    { title: 'app.js', detail: '', intent: false },
  );
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test', description: '  ' } })], 'zh').text,
    '运行 npm test',
  );
});

test('a group of several calls does not concatenate descriptions', () => {
  const summary = summarizeToolGroup([
    tool('bash', { id: 'b1', input: { command: 'npm test', description: '跑单元测试' } }),
    tool('bash', { id: 'b2', input: { command: 'npm run check', description: '做语法检查' } }),
  ], 'zh');
  assert.equal(summary.text, '运行 npm test、npm run check');
});

test('a running call names the current step with ticks; failures stay counted', () => {
  const tools = [
    tool('read', { id: 'r1', path: 'a.js', status: 'completed' }),
    tool('read', { id: 'r2', path: 'missing.js', status: 'error' }),
    tool('read', { id: 'r3', path: 'src/cli/index.ts', status: 'running' }),
  ];
  const summary = summarizeToolGroup(tools, 'zh');
  assert.equal(summary.text, '正在读取 `src/cli/index.ts`…');
  assert.equal(summary.running, true);
  assert.equal(summary.failed, 1);
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' }, status: 'running' })], 'zh').text,
    '正在运行 `npm test`…',
  );
});

test('a lone failure names the call', () => {
  const summary = summarizeToolGroup([
    tool('read', { path: 'prompts/system.md', status: 'error' }),
  ], 'zh');
  assert.equal(summary.text, '读取 system.md 失败');
  assert.equal(summary.failed, 1);
});

test('a failed read or ls is a probe when a later call succeeded', () => {
  const probe = tool('ls', { id: 'ls1', path: 'src/commands', status: 'error' });
  const ok = tool('ls', { id: 'ls2', path: 'src/cli/commands' });
  const tools = [probe, ok];
  assert.equal(isProbeFailure(probe, tools), true);
  assert.equal(isProbeFailure(ok, tools), false);
  const summary = summarizeToolGroup(tools, 'zh');
  assert.equal(summary.failed, 0);
  assert.equal(summary.text, '列出 commands');
  assert.equal(isProbeFailure(tool('read', { id: 'r1', path: 'missing.js', status: 'error' }), [
    tool('read', { id: 'r1', path: 'missing.js', status: 'error' }),
    tool('read', { id: 'r2', path: 'index.ts' }),
  ]), true);
});

test('the last failed call in a group is a real failure', () => {
  const first = tool('read', { id: 'r1', path: 'a.ts' });
  const last = tool('read', { id: 'r2', path: 'missing.ts', status: 'error' });
  const tools = [first, last];
  assert.equal(isProbeFailure(last, tools), false);
  const summary = summarizeToolGroup(tools, 'zh');
  assert.equal(summary.failed, 1);
  assert.equal(summary.text, '读取 missing.ts 失败 · 读了 a.ts');
});

test('a failed write is a real failure even when a later call succeeded', () => {
  const write = tool('write', { id: 'w1', path: 'out.ts', status: 'error' });
  const read = tool('read', { id: 'r1', path: 'out.ts' });
  const tools = [write, read];
  assert.equal(isProbeFailure(write, tools), false);
  const summary = summarizeToolGroup(tools, 'zh');
  assert.equal(summary.failed, 1);
  assert.match(summary.text, /写入 out\.ts 失败/);
});

test('a bash non-zero exit is a real failure', () => {
  const bash = tool('bash', {
    id: 'b1',
    input: { command: 'npm test' },
    output: '{"stdout":"","stderr":"failed","code":1}',
  });
  const read = tool('read', { id: 'r1', path: 'a.ts' });
  const tools = [bash, read];
  assert.equal(isProbeFailure(bash, tools), false);
  const summary = summarizeToolGroup(tools, 'zh');
  assert.equal(summary.failed, 1);
  assert.match(summary.text, /执行 npm test 失败|执行失败/);
  const lastOnly = [tool('read', { id: 'r1', path: 'a.ts' }), bash];
  lastOnly[1] = tool('bash', {
    id: 'b1',
    input: { command: 'npm test' },
    status: 'error',
    output: '{"stdout":"","stderr":"failed","code":1}',
  });
  assert.equal(isProbeFailure(lastOnly[1], lastOnly), false);
  assert.equal(summarizeToolGroup(lastOnly, 'zh').failed, 1);
});

test('two extra reads add an etc count; grep uses the first search term', () => {
  const summary = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'src/index.ts' }),
    tool('read', { id: 'r2', path: 'src/probe.ts' }),
    tool('read', { id: 'r3', path: 'src/cli.ts' }),
    tool('grep', { id: 'g1', input: { pattern: 'CommandRegistry' } }),
    tool('grep', { id: 'g2', input: { pattern: 'unused' } }),
  ], 'zh');
  assert.equal(summary.text, '读了 index.ts、probe.ts 等 3 个文件 · 搜索 CommandRegistry');
});

test('short file-error hints and workspace-relative paths', () => {
  const root = '/Users/me/proj';
  assert.equal(relativizePath('/Users/me/proj/src/commands', root), 'src/commands');
  assert.equal(relativizePath('src/commands', root), 'src/commands');
  assert.equal(relativizePath('/tmp/outside', root), '/tmp/outside');
  assert.equal(
    relativizeText("ENOENT: no such file or directory, open '/Users/me/proj/src/commands'", root),
    "ENOENT: no such file or directory, open 'src/commands'",
  );
  const opts = { workspacePath: root };
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    path: `${root}/src/commands`,
    output: `ENOENT: no such file or directory, open '${root}/src/commands'`,
  }), 'zh', opts).text, '不存在');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EACCES: permission denied, open \'secret\'',
  }), 'zh').text, '没有权限');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EPERM: operation not permitted',
  }), 'zh').text, '没有权限');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'E_SANDBOX: path outside workspace',
  }), 'zh').text, '超出工作区');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EISDIR: illegal operation on a directory, read',
  }), 'zh').text, '是目录');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'ENOTDIR: not a directory, scandir \'file.ts\'',
  }), 'zh').text, '不是目录');
  assert.equal(toolResultHint(tool('read', {
    status: 'error',
    output: 'EIO: i/o error, read',
  }), 'zh').text, 'EIO: i/o error, read');
});

test('english summary capitalizes the first clause', () => {
  const summary = summarizeToolGroup([
    tool('read', { id: 'r1', path: 'a.js' }),
    tool('read', { id: 'r2', path: 'b.js' }),
    tool('ls', { id: 'ls1', path: 'src' }),
  ], 'en');
  assert.equal(summary.text, 'Read a.js, b.js · listed src');
  assert.equal(
    summarizeToolGroup([
      tool('edit', { id: 'e1', path: 'auth.ts' }),
      tool('write', { id: 'w1', path: 'redis.ts' }),
      tool('bash', { id: 'b1', input: { command: 'npm test' } }),
      tool('read', { id: 'r1', path: 'prompts', status: 'error' }),
    ], 'en').text,
    'Changed auth.ts, redis.ts · Read prompts failed · ran npm test',
  );
});

test('assistant text splits tool runs; the group key stays on the first call', () => {
  const first = [{ id: 'a', name: 'read' }, { id: 'b', name: 'read' }];
  const grown = [...first, { id: 'z', name: 'ls' }];
  assert.equal(toolGroupKey(first), toolGroupKey(grown));
  assert.equal(toolGroupKey(first), 'g:a');
});

test('output clips to 20 lines until show-all', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);
  const clipped = clipOutputText(lines.join('\n'), false);
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.text.split('\n').length, 20);
  assert.equal(clipped.text.includes('L21'), false);
  const full = clipOutputText(lines.join('\n'), true);
  assert.equal(full.clipped, false);
  assert.equal(full.text.includes('L25'), true);
  assert.equal(clipOutputText('one\ntwo', false).clipped, false);
  const err = clipOutputText(lines.join('\n'), false, 8);
  assert.equal(err.text.split('\n').length, 8);
});

test('diff counts fall back to the write output line', () => {
  assert.deepEqual(toolDiffCounts({ added: 3, removed: 0 }), { added: 3, removed: 0 });
  assert.deepEqual(
    toolDiffCounts({ output: 'wrote docs/README.md (+3 −0)' }),
    { added: 3, removed: 0 },
  );
  assert.deepEqual(toolDiffCounts({ output: 'hello' }), { added: null, removed: null });
});

test('row hints report lines, items, matches, last bash line, and failed first line', () => {
  assert.equal(toolResultHint(tool('read', { output: 'a\nb\nc\n' }), 'zh').text, '3 行');
  assert.equal(toolResultHint(tool('ls', { output: 'd src\nf a.js\nf b.js' }), 'zh').text, '3 项');
  assert.equal(toolResultHint(tool('grep', { output: 'a.js:1:foo\nb.js:2:foo' }), 'zh').text, '2 处匹配');
  assert.equal(
    toolResultHint(tool('bash', { output: '{"stdout":"ok\\n","stderr":"","code":0}' }), 'zh').text,
    'ok',
  );
  assert.equal(
    toolResultHint(tool('bash', { output: '{"stdout":"first line of a long build log that should be trimmed a lot","stderr":"","code":null}' }), 'zh').text.length <= 48,
    true,
  );
  const failed = toolResultHint(tool('read', {
    status: 'error',
    output: 'ENOENT: no such file or directory, open \'prompts\'\nmore',
  }), 'zh');
  assert.equal(failed.failed, true);
  assert.equal(failed.text, '不存在');
  assert.equal(outputLineCount('a\nb\nc\n'), 3);
  assert.equal(toolFileLabel('src/api/auth.ts'), 'auth.ts');
});

test('bash hints use the last nonempty line, empty output, and skip the official exit notice', () => {
  assert.equal(
    toolResultHint(tool('bash', { output: '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n' }), 'zh').text,
    '12',
  );
  assert.equal(
    toolResultHint(tool('bash', { output: '{"stdout":"ok\\n# pass 230\\n","stderr":"","code":0}' }), 'zh').text,
    '# pass 230',
  );
  assert.equal(toolResultHint(tool('bash', { output: '' }), 'zh').text, '无输出');
  assert.equal(
    toolResultHint(tool('bash', { output: '{"stdout":"","stderr":"","code":0}' }), 'zh').text,
    '无输出',
  );
  assert.equal(toolResultHint(tool('bash', { output: '' }), 'en').text, 'no output');

  const failed = toolResultHint(tool('bash', {
    status: 'error',
    output: '{"stdout":"","stderr":"failed\\n","code":1}',
  }), 'zh');
  assert.equal(failed.failed, true);
  assert.equal(failed.text, '退出码 1 · failed');

  const official = [
    '1',
    '2',
    'Tests: 12 passed, 1 failed',
    '<harness>',
    '[error] Command exited with code 1',
    '</harness>',
  ].join('\n');
  const skipped = toolResultHint(tool('bash', { status: 'error', output: official }), 'zh');
  assert.equal(skipped.failed, true);
  assert.equal(skipped.text, '退出码 1 · Tests: 12 passed, 1 failed');

  const onlyNotice = toolResultHint(tool('bash', {
    status: 'error',
    output: '<harness>\n[error] Command exited with code 2\n</harness>',
  }), 'zh');
  assert.equal(onlyNotice.failed, true);
  assert.equal(onlyNotice.text, '退出码 2');

  const enFail = toolResultHint(tool('bash', {
    status: 'error',
    output: official,
  }), 'en');
  assert.equal(enFail.text, 'exit 1 · Tests: 12 passed, 1 failed');
});

test('harness diagnostic wrapping is stripped from failed hints; plain output is unchanged', () => {
  const wrapped = '<harness>\n[error] ENOENT: no such file or directory, open \'missing.txt\'\n</harness>';
  const failed = toolResultHint(tool('read', { status: 'error', output: wrapped }), 'zh');
  assert.equal(failed.failed, true);
  assert.equal(failed.text, '不存在');
  assert.equal(
    unwrapHarnessDiagnostics(wrapped),
    'ENOENT: no such file or directory, open \'missing.txt\'',
  );
  assert.equal(
    unwrapHarnessDiagnostics('<harness>\n[warning] timed out\n[info] spilled to /tmp/out\n</harness>'),
    'timed out\nspilled to /tmp/out',
  );
  const plain = 'ENOENT: no such file or directory, open \'prompts\'\nmore';
  assert.equal(unwrapHarnessDiagnostics(plain), plain);
  assert.equal(
    unwrapHarnessDiagnostics('keep [error] in the body\n[error] this stays'),
    'keep [error] in the body\n[error] this stays',
  );
  const unwrappedFail = toolResultHint(tool('read', { status: 'error', output: plain }), 'zh');
  assert.equal(unwrappedFail.text, '不存在');
});

test('long groups keep the last eight rows and hide the rest', () => {
  const tools = Array.from({ length: 11 }, (_, i) => tool('read', { id: `r${i}`, path: `f${i}.js` }));
  const preview = toolGroupPreview(tools, false);
  assert.equal(preview.hidden, 3);
  assert.deepEqual(preview.tools.map((item) => item.id), ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']);
  assert.equal(toolGroupPreview(tools, true).hidden, 0);
  assert.equal(toolGroupPreview(tools.slice(0, 8), false).hidden, 0);
});

test('zh and en phrase catalogs have the same keys', () => {
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys);
});

function collectToolPhraseKeys() {
  const keys = new Set([
    'tool_sum_join',
    'tool_sum_names_join',
    'tool_sum_other',
    'tool_sum_other_one',
    'tool_one_other',
    'tool_one_other_target',
    'tool_run_other',
    'tool_run_other_target',
    'tool_fail_bare',
    'tool_fail_named',
    'tool_sum_changed',
    'tool_sum_changed_more',
    'tool_sum_ran',
    'tool_sum_grep_named',
    'tool_err_enoent',
    'tool_err_eacces',
    'tool_err_sandbox',
    'tool_err_eisdir',
    'tool_err_enotdir',
    'tool_hint_exit_line',
    'tool_hint_exit',
    'tool_hint_no_output',
    'tool_hint_lines',
    'tool_hint_items',
    'tool_hint_matches',
  ]);
  for (const kind of TOOL_KINDS) {
    keys.add(`tool_one_${kind}`);
    keys.add(`tool_run_${kind}`);
    keys.add(`tool_run_${kind}_bare`);
    keys.add(`tool_act_${kind}`);
    keys.add(`tool_sum_${kind}`);
    keys.add(`tool_sum_${kind}_one`);
  }
  for (const kind of ['read', 'ls']) {
    keys.add(`tool_sum_${kind}_named`);
    keys.add(`tool_sum_${kind}_named_more`);
  }
  return [...keys];
}

test('every key tools can request exists in both zh and en catalogs', () => {
  for (const key of collectToolPhraseKeys()) {
    assert.equal(Object.hasOwn(zh, key), true, `zh missing ${key}`);
    assert.equal(Object.hasOwn(en, key), true, `en missing ${key}`);
  }
});

test('pending and auto-continue keys exist in both catalogs', () => {
  for (const key of ['pending_thinking', 'pending_subagents', 'auto_continue_note']) {
    assert.equal(Object.hasOwn(zh, key), true, `zh missing ${key}`);
    assert.equal(Object.hasOwn(en, key), true, `en missing ${key}`);
    assert.notEqual(phrase('zh', key, { n: 2 }), phrase('en', key, { n: 2 }));
  }
});

test('en missing key falls back to zh; both missing throws', () => {
  assert.equal(lookupPhraseFrom({ a: 'en-a' }, { a: 'zh-a', b: 'zh-b' }, 'b'), 'zh-b');
  assert.equal(lookupPhraseFrom({ a: 'en-a' }, { a: 'zh-a' }, 'a'), 'en-a');
  assert.throws(() => lookupPhraseFrom({}, { x: 'zh-x' }, 'nope'), /missing phrase: nope/);
  assert.throws(() => phrase('zh', 'no_such_phrase_key'), /missing phrase: no_such_phrase_key/);
  assert.throws(() => phrase('en', 'no_such_phrase_key'), /missing phrase: no_such_phrase_key/);
});

test('english toolCallView and summaries emit english sentences', () => {
  const read = tool('read', { id: 'r1', path: 'a.js', output: 'a\nb\n' });
  const enView = toolCallView(read, [read], { lang: 'en' });
  const zhView = toolCallView(read, [read], { lang: 'zh' });
  assert.equal(enView.hint.text, '2 lines');
  assert.equal(zhView.hint.text, '2 行');
  assert.equal(toolGroupSummaryView([read], 'en').text, 'Read a.js');
  assert.equal(toolGroupSummaryView([read], 'zh').text, '读取了 a.js');
  assert.equal(
    summarizeToolGroup([tool('bash', { input: { command: 'npm test' }, status: 'running' })], 'en').text,
    'Running `npm test`…',
  );
  assert.equal(
    toolResultHint(tool('read', { status: 'error', output: 'ENOENT: missing' }), 'en').text,
    'does not exist',
  );
});

test('toolCallView success, failure, probe, running, bash exit, and diffs pass the ToolCall schema', () => {
  const root = '/Users/me/proj';
  const success = tool('read', {
    id: 'r-ok',
    path: `${root}/src/a.js`,
    output: Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join('\n'),
  });
  const successView = toolCallView(success, [success], { lang: 'zh', workspacePath: root });
  assert.equal(successView.kind, 'read');
  assert.equal(successView.status, 'done');
  assert.equal(successView.failure, 'none');
  assert.equal(successView.path, 'src/a.js');
  assert.equal(successView.output.truncated, true);
  assert.equal(successView.output.preview.split('\n').length, 20);
  assert.equal(successView.diff, null);
  assert.equal('exitCode' in successView, false);
  assertValidToolCall(successView, 'success');

  const failed = tool('read', {
    id: 'r-fail',
    path: `${root}/missing.ts`,
    status: 'error',
    output: `ENOENT: no such file or directory, open '${root}/missing.ts'\n${Array.from({ length: 12 }, (_, i) => `E${i}`).join('\n')}`,
  });
  const failedView = toolCallView(failed, [failed], { lang: 'zh', workspacePath: root });
  assert.equal(failedView.status, 'failed');
  assert.equal(failedView.failure, 'real');
  assert.equal(failedView.hint.failed, true);
  assert.equal(failedView.hint.text, '不存在');
  assert.equal(failedView.output.truncated, true);
  assert.equal(failedView.output.preview.split('\n').length, 8);
  assert.equal(failedView.path, 'missing.ts');
  assertValidToolCall(failedView, 'failed');

  const probe = tool('ls', { id: 'ls1', path: `${root}/src/commands`, status: 'error', output: 'ENOENT' });
  const later = tool('ls', { id: 'ls2', path: `${root}/src/cli/commands`, output: 'a\nb' });
  const probeView = toolCallView(probe, [probe, later], { lang: 'en', workspacePath: root });
  assert.equal(probeView.failure, 'probe');
  assert.equal(probeView.status, 'failed');
  assert.equal(probeView.groupId, 'g:ls1');
  assertValidToolCall(probeView, 'probe');

  const running = tool('read', { id: 'r-run', path: 'src/cli/index.ts', status: 'running' });
  const runningView = toolCallView(running, [running], { lang: 'zh' });
  assert.equal(runningView.status, 'running');
  assert.equal(runningView.failure, 'none');
  assert.equal(runningView.hint.text, '');
  assert.equal(runningView.heading.title, 'src/cli/index.ts');
  assertValidToolCall(runningView, 'running');

  const bash = tool('bash', {
    id: 'b1',
    input: { command: 'npm test' },
    output: '{"stdout":"","stderr":"failed","code":1}',
  });
  const bashView = toolCallView(bash, [bash], { lang: 'zh' });
  assert.equal(bashView.kind, 'bash');
  assert.equal(bashView.failure, 'real');
  assert.equal(bashView.exitCode, 1);
  assert.equal('path' in bashView, false);
  assertValidToolCall(bashView, 'bash-nonzero');

  const write = tool('write', {
    id: 'w1',
    path: `${root}/docs/README.md`,
    added: 3,
    removed: 0,
    output: `wrote ${root}/docs/README.md (+3 −0)`,
  });
  const writeView = toolCallView(write, [write], { lang: 'zh', workspacePath: root });
  assert.equal(writeView.kind, 'write');
  assert.deepEqual(writeView.diff, { added: 3, removed: 0 });
  assert.equal(writeView.path, 'docs/README.md');
  assertValidToolCall(writeView, 'write-diff');

  const edit = tool('edit', {
    id: 'e1',
    path: 'src/api/auth.ts',
    output: 'updated src/api/auth.ts (+4 −2)',
  });
  const editView = toolCallView(edit, [edit], { lang: 'en' });
  assert.equal(editView.kind, 'edit');
  assert.deepEqual(editView.diff, { added: 4, removed: 2 });
  assert.equal(editView.heading.fromIntent, false);
  assertValidToolCall(editView, 'edit-diff');

  const summary = toolGroupSummaryView([success, failed], 'zh');
  assert.equal(validateToolGroupSummary(summary), true, JSON.stringify(validateToolGroupSummary.errors));
});
