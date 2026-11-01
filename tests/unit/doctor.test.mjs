import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CODE_PAGE_KEY,
  NA,
  ROUNDTRIP_CMD_LABEL,
  ROUNDTRIP_GBK_BAT_LABEL,
  ROUNDTRIP_PWSH_LABEL,
  ROUNDTRIP_TEXT,
  buildGbkBatRoundtripArgs,
  buildPwshRoundtripArgs,
  gbkBatEchoBytes,
  chooseShellPwshFirst,
  envPresenceLines,
  findOnPath,
  gbkDecoderAvailable,
  interpretShellModule,
  judgeRoundtrip,
  normalizeRoundtripText,
  parseCodePageRegistry,
  parseRegValues,
  quotePwshLiteral,
  reportContainsSecrets,
  runDoctor,
} from '../../src/platform/win/doctor.mjs';
import { parseArgs } from '../../src/v2/cli.ts';

const GBK_ZH = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xd4, 0xbc, 0xec]);

test('parseArgs accepts doctor and rejects --print with it', () => {
  assert.deepEqual(parseArgs(['doctor']), { command: 'doctor', dataDir: undefined, print: false });
  assert.deepEqual(parseArgs(['--data-dir', '/tmp/weft-doc', 'doctor']), {
    command: 'doctor',
    dataDir: '/tmp/weft-doc',
    print: false,
  });
  assert.throws(() => parseArgs(['doctor', '--print']), /--print 只能和 open 一起用/);
});

test('parseCodePageRegistry reads ACP and OEMCP from reg query text', () => {
  const sample = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage
    ACP    REG_SZ    936
    OEMCP    REG_SZ    936
    MACCP    REG_SZ    10008
`;
  assert.deepEqual(parseCodePageRegistry(sample), { acp: '936', oemcp: '936' });
  assert.equal(parseRegValues(sample).MACCP, '10008');
});

test('parseRegValues decodes UTF-16LE registry output', () => {
  const text = '    ACP    REG_SZ    1252\r\n';
  const utf16 = Buffer.from(`\ufeff${text}`, 'utf16le');
  assert.equal(parseRegValues(utf16).ACP, '1252');
});

test('findOnPath walks PATH and PATHEXT', () => {
  const files = new Set(['C:\\bin\\pwsh.exe', 'C:\\bin\\git.EXE']);
  const found = findOnPath('pwsh', {
    platform: 'win32',
    pathEnv: 'C:\\missing;C:\\bin',
    pathext: '.EXE;.CMD',
    pathSep: ';',
    join: path.win32.join,
    existsSync: (file) => files.has(file),
  });
  assert.equal(found, 'C:\\bin\\pwsh.exe');
  assert.equal(findOnPath('missing', {
    platform: 'linux',
    pathEnv: '/usr/bin',
    pathSep: ':',
    existsSync: () => false,
  }), null);
});

test('judgeRoundtrip distinguishes UTF-8 正常 from constructed GBK 乱码', () => {
  assert.equal(new TextDecoder('gbk').decode(GBK_ZH), ROUNDTRIP_TEXT);
  assert.equal(judgeRoundtrip(Buffer.from(ROUNDTRIP_TEXT, 'utf8')).verdict, '正常');
  assert.equal(judgeRoundtrip(Buffer.from(ROUNDTRIP_TEXT, 'utf8')).encoding, 'utf-8');
  assert.equal(judgeRoundtrip(GBK_ZH).verdict, '乱码');
  assert.equal(judgeRoundtrip(GBK_ZH).encoding, 'gbk');
  assert.equal(normalizeRoundtripText(`\r\n"${ROUNDTRIP_TEXT}"\r\n`), ROUNDTRIP_TEXT);
});

test('buildPwshRoundtripArgs uses Agent prefix, Bypass, and NoProfile', () => {
  const args = buildPwshRoundtripArgs();
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.match(args[5], /\$OutputEncoding/);
  assert.match(args[5], /OutputEncoding=\[System\.Text\.Encoding\]::UTF8/);
  assert.match(args[5], /OEMCodePage/);
  assert.match(args[5], /chcp\.com \$oem/);
  assert.equal(args[5].includes('Encoding]::Default'), false);
  assert.equal(args[5].includes('chcp 65001'), false);
  assert.match(args[5], /Write-Output/);
  assert.match(args[5], /中文自检/);
  assert.ok(args[5].indexOf('OEMCodePage') > args[5].indexOf('Encoding]::UTF8'));
  assert.equal(quotePwshLiteral("it's"), "'it''s'");
  const batArgs = buildGbkBatRoundtripArgs('C:\\tmp\\zh.bat');
  assert.deepEqual(batArgs.slice(0, 5), args.slice(0, 5));
  assert.match(batArgs[5], /cmd \/d \/s \/c 'C:\\tmp\\zh\.bat'/);
  assert.match(batArgs[5], /OutputEncoding=\[System\.Text\.Encoding\]::UTF8/);
  assert.match(batArgs[5], /OEMCodePage/);
  assert.match(batArgs[5], /chcp\.com \$oem/);
  assert.ok(batArgs[5].indexOf('OEMCodePage') > batArgs[5].indexOf('Encoding]::UTF8'));
  assert.equal(new TextDecoder('gbk').decode(gbkBatEchoBytes()).includes(ROUNDTRIP_TEXT), true);
});

test('envPresenceLines never includes values', () => {
  const env = {
    OPENAI_API_KEY: 'sk-secret-must-not-appear',
    ANTHROPIC_API_KEY: '',
    WEFT_LLM: 'faux',
    MY_APP_TOKEN: 'tok-hidden-value',
    PATH: '/usr/bin',
    WEFT_DATA_DIR: '/tmp/weft-data',
  };
  const lines = envPresenceLines(env).join('\n');
  assert.match(lines, /OPENAI_API_KEY: 已设置/);
  assert.match(lines, /ANTHROPIC_API_KEY: 未设置/);
  assert.match(lines, /WEFT_LLM: 已设置/);
  assert.match(lines, /MY_APP_TOKEN: 已设置/);
  assert.equal(lines.includes('sk-secret-must-not-appear'), false);
  assert.equal(lines.includes('tok-hidden-value'), false);
  assert.equal(lines.includes('faux'), false);
  assert.equal(lines.includes('/tmp/weft-data'), false);
  assert.equal(lines.includes('/usr/bin'), false);
});

test('chooseShellPwshFirst prefers pwsh on Windows and is NA elsewhere', () => {
  assert.equal(chooseShellPwshFirst({ platform: 'linux' }).label, NA);
  assert.equal(
    chooseShellPwshFirst({
      platform: 'win32',
      pwsh: { path: 'C:\\pwsh.exe', version: '7.4.6' },
      powershell: { path: 'C:\\powershell.exe' },
    }).program,
    'pwsh',
  );
  assert.equal(
    chooseShellPwshFirst({
      platform: 'win32',
      powershell: { path: 'C:\\powershell.exe' },
    }).program,
    'Windows PowerShell',
  );
});

test('interpretShellModule picks known exports', () => {
  const fn = () => ({ program: 'pwsh' });
  assert.equal(interpretShellModule({ resolveAgentShell: fn }).name, 'resolveAgentShell');
  assert.equal(interpretShellModule({ program: 'bash', path: '/bin/bash' }).kind, 'value');
  assert.equal(interpretShellModule({ foo: 1 }), null);
});

test('runDoctor on non-Windows prints 不适用, roundtrip, and hides secrets', async () => {
  const env = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'sk-doctor-secret-aaaa',
    WEFT_LLM: 'faux',
  };
  const bins = {
    git: '/usr/bin/git',
    bash: '/bin/bash',
  };
  const text = await runDoctor({
    platform: 'linux',
    env,
    dataDir: '/tmp/weft-doctor-data',
    nodeVersion: 'v22.23.4',
    execPath: '/usr/bin/node',
    os: { type: () => 'Linux', release: () => '6.12.0', arch: () => 'x64', version: () => '6.12.0' },
    locale: () => 'zh-CN',
    gbk: true,
    which: (name) => bins[name] || null,
    inspectService: async () => ({ running: false }),
    loadShellModule: async () => null,
    exec: async (command, args) => {
      if (String(command).includes('git') && args[0] === '--version') {
        return { code: 0, stdout: Buffer.from('git version 2.47.0\n', 'utf8'), stderr: Buffer.alloc(0) };
      }
      if (String(command).includes('git') && args.includes('core.quotepath')) {
        return { code: 0, stdout: Buffer.from('false\n', 'utf8'), stderr: Buffer.alloc(0) };
      }
      if (String(command).includes('bash')) {
        return { code: 0, stdout: Buffer.from('GNU bash, version 5.2\n', 'utf8'), stderr: Buffer.alloc(0) };
      }
      return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  assert.match(text, /\[系统\]/);
  assert.match(text, /ACP: 不适用/);
  assert.match(text, /OEMCP: 不适用/);
  assert.match(text, /系统区域: zh-CN/);
  assert.match(text, /\[Node\]/);
  assert.match(text, /v22\.23\.4/);
  assert.match(text, /TextDecoder\('gbk'\): 可用/);
  assert.match(text, /\[PowerShell\]/);
  assert.match(text, /Windows PowerShell: 不适用/);
  assert.match(text, /Agent 命令将使用: 不适用/);
  assert.match(text, /\[Git\]/);
  assert.match(text, /core\.quotepath: false/);
  assert.match(text, /\[Weft\]/);
  assert.match(text, /数据目录: \/tmp\/weft-doctor-data/);
  assert.match(text, /服务: 未运行/);
  assert.match(text, /\[往返\]/);
  assert.match(text, new RegExp(`${ROUNDTRIP_PWSH_LABEL}: 未安装 pwsh`));
  assert.match(text, new RegExp(`${ROUNDTRIP_GBK_BAT_LABEL}: ${NA}`));
  assert.match(text, new RegExp(`${ROUNDTRIP_CMD_LABEL}: ${NA}`));
  assert.match(text, /OPENAI_API_KEY: 已设置/);
  assert.equal(text.includes('sk-doctor-secret-aaaa'), false);
  assert.equal(text.includes('faux'), false);
  assert.equal(reportContainsSecrets(text, env).length, 0);
  assert.equal(text.includes('HKLM'), false);
});

test('runDoctor on Windows uses registry, shell.mjs, and roundtrip verdicts', async () => {
  const env = {
    PATH: 'C:\\bin',
    PATHEXT: '.EXE',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    OPENAI_API_KEY: 'sk-win-secret-bbbb',
  };
  const text = await runDoctor({
    platform: 'win32',
    env,
    dataDir: 'C:\\Users\\weft\\AppData\\Roaming\\Weft',
    nodeVersion: 'v22.23.4',
    execPath: 'C:\\node\\node.exe',
    os: { type: () => 'Windows_NT', release: () => '10.0.19045', arch: () => 'x64', version: () => 'Windows 10 Pro' },
    locale: () => 'en-US',
    gbk: true,
    which: (name) => ({
      pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      git: 'C:\\Program Files\\Git\\cmd\\git.exe',
      cmd: 'C:\\Windows\\System32\\cmd.exe',
    }[name] || null),
    inspectService: async () => ({ running: true, port: 3456, pid: 4242 }),
    loadShellModule: async () => ({
      describeAgentShell: () => ({ program: 'pwsh', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }),
    }),
    readRegistry: async (key) => {
      if (key === CODE_PAGE_KEY) {
        return Buffer.from('    ACP    REG_SZ    936\r\n    OEMCP    REG_SZ    936\r\n', 'utf8');
      }
      if (key.includes('International')) {
        return Buffer.from('    LocaleName    REG_SZ    zh-CN\r\n', 'utf8');
      }
      if (key.includes('CurrentVersion')) {
        return Buffer.from('    ProductName    REG_SZ    Windows 10 Pro\r\n    DisplayVersion    REG_SZ    22H2\r\n    CurrentBuild    REG_SZ    19045\r\n', 'utf8');
      }
      return Buffer.alloc(0);
    },
    writeFileSync() {},
    rmSync() {},
    tmpdir: () => 'C:\\tmp',
    exec: async (command, args) => {
      const joined = `${command} ${args.join(' ')}`;
      if (joined.includes('Write-Output') || joined.includes('gbk.bat')) {
        return { code: 0, stdout: Buffer.from(`${ROUNDTRIP_TEXT}\n`, 'utf8'), stderr: Buffer.alloc(0) };
      }
      if (args.includes('echo') || args.some((a) => String(a).startsWith('echo '))) {
        return { code: 0, stdout: GBK_ZH, stderr: Buffer.alloc(0) };
      }
      if (joined.includes('PSVersion')) {
        return { code: 0, stdout: Buffer.from(String(command).includes('pwsh') ? '7.4.6' : '5.1.19041', 'utf8'), stderr: Buffer.alloc(0) };
      }
      if (args[0] === '--version' && String(command).includes('git')) {
        return { code: 0, stdout: Buffer.from('git version 2.45.1.windows.1\n', 'utf8'), stderr: Buffer.alloc(0) };
      }
      if (args.includes('core.quotepath')) {
        return { code: 0, stdout: Buffer.from('false\n', 'utf8'), stderr: Buffer.alloc(0) };
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });
  assert.match(text, /ACP: 936/);
  assert.match(text, /OEMCP: 936/);
  assert.match(text, /系统区域: zh-CN/);
  assert.match(text, /Windows 10 Pro/);
  assert.match(text, /Agent 命令将使用: pwsh，C:\\Program Files\\PowerShell\\7\\pwsh.exe/);
  assert.match(text, /端口: 3456/);
  assert.match(text, /服务: 正在运行（pid 4242）/);
  assert.match(text, new RegExp(`${ROUNDTRIP_PWSH_LABEL}: 正常`));
  assert.match(text, new RegExp(`${ROUNDTRIP_GBK_BAT_LABEL}: 正常`));
  assert.match(text, new RegExp(`${ROUNDTRIP_CMD_LABEL}: 乱码`));
  assert.equal(text.includes('sk-win-secret-bbbb'), false);
});

test('runDoctor does not throw when shell.mjs is missing', async () => {
  const text = await runDoctor({
    platform: 'win32',
    env: { PATH: 'C:\\bin' },
    dataDir: 'D:\\data',
    which: () => null,
    inspectService: async () => ({ running: false }),
    loadShellModule: async () => {
      const err = new Error("Cannot find module 'shell.mjs'");
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    },
    readRegistry: async () => Buffer.alloc(0),
    exec: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    os: { type: () => 'Windows_NT', release: () => '10.0', arch: () => 'x64', version: () => '10.0' },
  });
  assert.match(text, /pwsh 优先规则/);
});

test('gbkDecoderAvailable matches this Node ICU build', () => {
  assert.equal(typeof gbkDecoderAvailable(), 'boolean');
  assert.equal(gbkDecoderAvailable(), true);
});

test('default inspectService hides discovery token', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'weft-doctor-disc-'));
  try {
    await writeFile(path.join(dir, 'service.json'), JSON.stringify({
      protocolVersion: '2.0.0',
      serviceVersion: '0.1.0',
      pid: process.pid,
      port: 9999,
      startedAt: 1,
      token: 'live-token-must-not-leak-zzzzzzzz',
    }), 'utf8');
    const text = await runDoctor({
      platform: 'linux',
      env: { PATH: '/usr/bin' },
      dataDir: dir,
      which: () => null,
      loadShellModule: async () => null,
      exec: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      os: { type: () => 'Linux', release: () => '1', arch: () => 'x64', version: () => '1' },
    });
    assert.match(text, /端口: 9999/);
    assert.match(text, /正在运行/);
    assert.equal(text.includes('live-token-must-not-leak-zzzzzzzz'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
