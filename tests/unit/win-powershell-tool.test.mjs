import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { agentShellKind } from '../../src/platform/win/shell.mjs';
import { createAgentShellTool, workspaceTools } from '../../src/kernel/tools.mjs';
import { createWorkspaceEnv } from '../../src/kernel/workspace-env.mjs';

function pwshAvailable() {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  return result.status === 0;
}

function resultText(chunks, ran) {
  return `${chunks.join('')}${ran?.structuredOutput?.output || ''}`;
}

async function runPowerShell(tool, env, command) {
  const chunks = [];
  const ran = await tool.execute(
    { command, timeout: 30 },
    {
      env,
      output(text) { chunks.push(String(text ?? '')); },
      retainedOutput() { return { text: chunks.join(''), truncated: false }; },
      diagnostic() {},
    },
    BACKGROUND_CONTEXT,
  );
  return { ran, text: resultText(chunks, ran) };
}

test('Windows offers powershell instead of bash; elsewhere bash unless overridden', () => {
  const names = workspaceTools().map((tool) => tool.name);
  assert.deepEqual(names.slice(0, 5), ['read', 'write', 'edit', 'ls', 'grep']);
  assert.equal(names.at(-1), agentShellKind());
  assert.equal(names.includes('bash') && names.includes('powershell'), false);
  if (process.platform === 'win32') {
    assert.equal(names.includes('powershell'), true);
    assert.equal(names.includes('bash'), false);
  } else {
    assert.equal(names.includes('bash'), true);
    assert.equal(names.includes('powershell'), false);
  }
});

test('createAgentShellTool(powershell) is named powershell and is unsafe to replay', () => {
  const tool = createAgentShellTool('powershell');
  assert.equal(tool.name, 'powershell');
  assert.equal(tool.replay, 'unsafe');
  assert.equal(createAgentShellTool('bash').name, 'bash');
});

test('powershell tool prints Chinese from Write-Output, node, and cmd without U+FFFD', {
  timeout: 60_000,
}, async (t) => {
  if (process.platform !== 'win32' && !pwshAvailable()) {
    t.skip('pwsh is not installed');
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'weft-pwsh-utf8-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  const tool = createAgentShellTool('powershell');
  try {
    await writeFile(path.join(dir, 'zh.cjs'), "process.stdout.write('中文');\n");

    const cases = [
      { command: "Write-Output '中文输出'", expect: '中文' },
      { command: 'node zh.cjs', expect: '中文' },
    ];
    if (process.platform === 'win32') {
      cases.push({ command: 'cmd /c echo 中文', expect: '中文' });
    }

    for (const item of cases) {
      const { ran, text } = await runPowerShell(tool, env, item.command);
      assert.equal(Boolean(ran?.isError), false, `${item.command}: ${JSON.stringify({ text, ran })}`);
      assert.equal(text.includes('\uFFFD'), false, `${item.command} contained U+FFFD: ${JSON.stringify(text)}`);
      assert.equal(text.includes(item.expect), true, `${item.command} missing ${item.expect}: ${JSON.stringify(text)}`);
    }
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
