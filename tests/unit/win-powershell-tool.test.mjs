import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import iconv from 'iconv-lite';
import { PWSH_UTF8_WRAPPER } from '../../src/platform/win/output-transcode.mjs';
import { agentShellKind, powershellCommandPrefix } from '../../src/platform/win/shell.mjs';
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

/** System OEM code page (what `chcp.com $oem` restores). Null off Windows. */
function windowsOemCodePage() {
  if (process.platform !== 'win32') return null;
  for (const program of ['pwsh', 'powershell']) {
    const result = spawnSync(
      program,
      ['-NoProfile', '-NonInteractive', '-Command', '[Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage'],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    );
    const n = Number.parseInt(String(result.stdout || '').trim(), 10);
    if (result.status === 0 && Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** OEM pages that can encode 中文 so `cmd /c echo 中文` is not `?`. */
function oemCanRepresentChinese(oem) {
  if (oem === 936 || oem === 54936 || oem === 65001) return true;
  if (!Number.isInteger(oem) || oem <= 0) return false;
  const name = `cp${oem}`;
  if (!iconv.encodingExists(name)) return false;
  return iconv.decode(iconv.encode('中文', name), name).includes('中文');
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
      // cmd.exe encodes echo with the OEM console CP (`chcp.com $oem` in the prefix).
      // 936 / 54936 (GBK / GB18030) can emit 中文; 437 on windows-latest cannot
      // (WideCharToMultiByte replaces with 0x3F). That is the host, not a product
      // bug. Commander measured OEM 936: `cmd /c echo 中文` is GBK, wrapper → 中文.
      const oem = windowsOemCodePage();
      cases.push({
        command: 'cmd /c echo 中文',
        expect: oemCanRepresentChinese(oem) ? '中文' : undefined,
        oem,
      });
    }

    for (const item of cases) {
      const { ran, text } = await runPowerShell(tool, env, item.command);
      assert.equal(Boolean(ran?.isError), false, `${item.command}: ${JSON.stringify({ text, ran })}`);
      assert.equal(text.includes('\uFFFD'), false, `${item.command} contained U+FFFD: ${JSON.stringify(text)}`);
      if (item.expect !== undefined) {
        assert.equal(text.includes(item.expect), true, `${item.command} missing ${item.expect}: ${JSON.stringify(text)}`);
      }
      if (item.command === 'cmd /c echo 中文') {
        console.log(`cmd /c echo 中文 OEM=${item.oem} text=${JSON.stringify(text)}`);
      }
    }
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('GBK .bat echo and UTF-8 path through wrapper (936 vs windows-latest)', {
  timeout: 60_000,
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-gbk-bat-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  try {
    const emit = path.join(dir, 'emit-mixed.mjs');
    const gbkLine = [...iconv.encode('中文GBK\n', 'gbk')];
    const utf8Line = [...Buffer.from('中文UTF8\n', 'utf8')];
    await writeFile(emit, `
      process.stdout.write(Buffer.from(${JSON.stringify(gbkLine)}));
      process.stdout.write(Buffer.from(${JSON.stringify(utf8Line)}));
    `);
    const streamed = { stdout: '', stderr: '' };
    const wrapped = await env.exec(
      [process.execPath, PWSH_UTF8_WRAPPER, process.execPath, emit],
      {
        onOutput: (text, _ctx, info) => {
          streamed[info.stream] += text;
        },
      },
      BACKGROUND_CONTEXT,
    );
    assert.equal(wrapped.ok, true, wrapped.ok ? '' : wrapped.error.message);
    assert.equal(wrapped.value.exitCode, 0);
    assert.equal(streamed.stdout.includes('中文GBK'), true, streamed.stdout);
    assert.equal(streamed.stdout.includes('中文UTF8'), true, streamed.stdout);
    assert.equal(streamed.stdout.includes('\uFFFD'), false, streamed.stdout);

    // windows-latest is CP 437/1252: cmd.exe will not parse a GBK .bat as Chinese.
    // On ACP/OEMCP 936 the same command's echo is expected to contain 中文 and no U+FFFD.
    if (process.platform === 'win32') {
      const bat = path.join(dir, 'zh.bat');
      await writeFile(bat, iconv.encode('@echo off\r\necho 中文输出测试\r\n', 'gbk'));
      const tool = createAgentShellTool('powershell');
      const utf8 = await runPowerShell(tool, env, "Write-Output '中文输出'");
      assert.equal(Boolean(utf8.ran?.isError), false, JSON.stringify(utf8));
      assert.equal(utf8.text.includes('中文'), true, utf8.text);
      assert.equal(utf8.text.includes('\uFFFD'), false, utf8.text);

      const batRun = await runPowerShell(tool, env, `.\\zh.bat`);
      assert.equal(Boolean(batRun.ran?.isError), false, JSON.stringify(batRun));
      if (batRun.text.includes('中文')) {
        assert.equal(batRun.text.includes('\uFFFD'), false, batRun.text);
      }
    }
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('powershell tool restores console code page via chcp.com to OEMCodePage', {
  timeout: 60_000,
}, async (t) => {
  assert.match(powershellCommandPrefix, /OEMCodePage/);
  assert.match(powershellCommandPrefix, /chcp\.com \$oem/);
  assert.equal(powershellCommandPrefix.includes('Encoding]::Default'), false);
  assert.equal(powershellCommandPrefix.includes('[Console]::OutputEncoding'), false);

  if (process.platform !== 'win32' && !pwshAvailable()) {
    t.skip('pwsh is not installed');
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'weft-pwsh-oemcp-'));
  const env = await createWorkspaceEnv({ cwd: dir });
  const tool = createAgentShellTool('powershell');
  try {
    const { ran, text } = await runPowerShell(tool, env, "Write-Output 'pwsh中文😀表情'");
    assert.equal(Boolean(ran?.isError), false, JSON.stringify({ text, ran }));
    assert.equal(text.includes('\uFFFD'), false, text);
    assert.equal(text.includes('中文'), true, text);
    assert.equal(text.includes('😀'), true, text);

    if (process.platform === 'win32') {
      const chcpRun = await runPowerShell(
        tool,
        env,
        [
          '$chcp = (chcp.com | Out-String)',
          'Write-Output ("CHCP=" + $chcp)',
          'Write-Output ("OEM=" + [Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)',
        ].join('; '),
      );
      assert.equal(Boolean(chcpRun.ran?.isError), false, JSON.stringify(chcpRun));
      const oem = Number((/OEM=(\d+)/.exec(chcpRun.text) || [])[1]);
      const chcpBlock = (/CHCP=([\s\S]*?)OEM=/.exec(chcpRun.text) || [])[1] || '';
      const chcp = Number((/(\d+)/.exec(chcpBlock) || [])[1]);
      assert.equal(Number.isInteger(oem) && oem > 0, true, chcpRun.text);
      assert.equal(Number.isInteger(chcp) && chcp > 0, true, chcpRun.text);
      assert.equal(chcp, oem, chcpRun.text);
    }
  } finally {
    await env.cleanup(BACKGROUND_CONTEXT).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
