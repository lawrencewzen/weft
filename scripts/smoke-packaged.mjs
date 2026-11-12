#!/usr/bin/env node
// 打包产物冒烟：用包内的 node 起包内的 server.mjs（演示模型 WEFT_LLM=faux），走真实接口验证。
// 用法：node scripts/smoke-packaged.mjs --app <app 目录> [--label <名字>]
//   1. 打印 WEFT_STARTUP（importsMs 等），用来对比打包前后；
//   2. /api/v2/providers、/api/v2/settings 返回 200；
//   3. 新建对话、发一条消息，等回复完成；
//   4. 用 shell 工具（Windows 上是 powershell，走 output-transcode 包装）跑一条命令；
//   5. 用 grep 工具（有 rg 走 rg）搜一个文件，结果正确。
// 只做请求和断言，不改运行逻辑。
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const out = { label: 'packaged' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') out.app = argv[++i];
    else if (argv[i] === '--label') out.label = argv[++i];
    else throw new Error(`未知参数 ${argv[i]}`);
  }
  if (!out.app) throw new Error('用法: node scripts/smoke-packaged.mjs --app <app 目录> [--label <名字>]');
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shellToolName(env = process.env) {
  const raw = String(env.WEFT_AGENT_SHELL || '').trim().toLowerCase();
  if (raw === 'bash' || raw === 'powershell') return raw;
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function assert(cond, message) {
  if (!cond) throw new Error(`冒烟失败：${message}`);
}

export async function runSmoke({ app, label = 'packaged' }) {
  const appDir = path.resolve(app);
  const work = await mkdtemp(path.join(tmpdir(), 'weft-smoke-'));
  const dataDir = path.join(work, 'data');
  await mkdir(dataDir, { recursive: true });
  const shell = shellToolName();
  const shellMarker = 'weft-shell-smoke-ok';
  const grepMarker = 'WEFT_GREP_NEEDLE_731';
  const shellCommand = `echo ${shellMarker}`;
  const script = {
    turns: [
      { when: 'SMOKE_SHELL', tool: shell, args: { command: shellCommand } },
      { when: 'SMOKE_SHELL', text: 'shell 完成' },
      { when: 'SMOKE_GREP', tool: 'grep', args: { pattern: grepMarker, literal: true } },
      { when: 'SMOKE_GREP', text: 'grep 完成' },
      { text: '你好，这是演示模型的回复。' },
    ],
  };
  const scriptPath = path.join(work, 'script.json');
  await writeFile(scriptPath, JSON.stringify(script));

  const env = {
    ...process.env,
    PORT: '0',
    WEFT_DATA_DIR: dataDir,
    WEFT_LOG_CONSOLE: '1',
    WEFT_LLM: 'faux',
    WEFT_FAUX_SCRIPT: scriptPath,
    WEFT_STDIN_EXIT: '1',
    WEFT_FOLDER_PICKER: 'off',
  };
  delete env.WEFT_TOKEN;
  const proc = spawn(process.execPath, [path.join(appDir, 'server.mjs')], {
    cwd: appDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdin.on('error', () => {});
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`服务 60 秒内没就绪：\n${log}`)), 60_000);
    const on = (chunk) => {
      log += chunk;
      const m = log.match(/WEFT_READY (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    proc.stdout.on('data', on);
    proc.stderr.on('data', on);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务提前退出 ${code}：\n${log}`));
    });
  });
  proc.removeAllListeners('exit');

  try {
    // 日志是异步落盘的，给它几秒。
    let startup = '';
    for (let i = 0; i < 50 && !startup; i += 1) {
      const serviceLog = await readFile(path.join(dataDir, 'logs', 'service.log'), 'utf8').catch(() => '');
      startup = `${serviceLog}\n${log}`.split(/\r?\n/).find((line) => line.includes('WEFT_STARTUP')) || '';
      if (!startup) await sleep(200);
    }
    console.log(`[${label}] ${startup.trim() || 'WEFT_STARTUP 日志没出现'}`);
    assert(startup, '服务日志里没有 WEFT_STARTUP');
    const importsMs = Number(/importsMs=(\d+)/.exec(startup)?.[1]);
    assert(Number.isFinite(importsMs), 'WEFT_STARTUP 里没有 importsMs');

    const discovery = JSON.parse(await readFile(path.join(dataDir, 'service.json'), 'utf8'));
    const call = async (method, p, body) => {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${discovery.token}` },
        body: body == null ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    for (const api of ['/api/v2/providers', '/api/v2/settings']) {
      const r = await call('GET', api);
      console.log(`[${label}] GET ${api} -> ${r.status}`);
      assert(r.status === 200, `${api} 返回 ${r.status}`);
    }

    const wsDir = path.join(dataDir, 'workspaces', 'smoke');
    await mkdir(wsDir, { recursive: true });
    await writeFile(path.join(wsDir, 'needle.txt'), `line one\nhere is ${grepMarker} in the file\nline three\n`);
    const ws = await call('POST', '/api/v2/workspaces', { name: 'smoke', source: 'local', path: wsDir });
    assert(ws.status === 201, `新建工作区返回 ${ws.status}：${JSON.stringify(ws.body)}`);

    async function converse(text) {
      const conv = await call('POST', `/api/v2/workspaces/${ws.body.id}/conversations`, { title: text.slice(0, 20) });
      assert(conv.status === 201, `新建对话返回 ${conv.status}：${JSON.stringify(conv.body)}`);
      const sent = await call('POST', `/api/v2/conversations/${conv.body.id}/messages`, { text });
      assert(sent.status === 202, `发消息返回 ${sent.status}：${JSON.stringify(sent.body)}`);
      const deadline = Date.now() + 90_000;
      let snap;
      for (;;) {
        await sleep(300);
        const r = await call('GET', `/api/v2/conversations/${conv.body.id}`);
        assert(r.status === 200, `读对话返回 ${r.status}`);
        snap = r.body;
        const assistant = snap.items.filter((item) => item.kind === 'assistant');
        const running = snap.conversation.status === 'running' || snap.tools.some((t) => t.status === 'running');
        if (!running && assistant.length > 0) break;
        if (Date.now() > deadline) throw new Error(`对话 90 秒内没完成，状态 ${snap.conversation.status}`);
      }
      return { id: conv.body.id, snap };
    }

    const chat = await converse('你好，打个招呼');
    const chatItems = chat.snap.items.filter((item) => item.kind === 'assistant');
    console.log(`[${label}] 对话完成：状态 ${chat.snap.conversation.status}，助手消息 ${chatItems.length} 条`);
    assert(chat.snap.conversation.status !== 'failed', '普通对话失败');
    assert(JSON.stringify(chatItems).includes('演示模型'), '助手回复不是演示模型的剧本回复');

    const sh = await converse('SMOKE_SHELL 跑一条命令');
    const shTool = sh.snap.tools.find((t) => t.kind === 'bash');
    assert(shTool, '没有 shell 工具调用');
    const shOut = await call('GET', `/api/v2/conversations/${sh.id}/tools/${encodeURIComponent(shTool.id)}/output`);
    console.log(`[${label}] ${shell} 工具 -> ${shTool.status}，输出：${JSON.stringify(shOut.body?.text)}`);
    assert(shTool.status === 'done', `${shell} 工具状态 ${shTool.status}`);
    assert(shOut.status === 200 && String(shOut.body.text).includes(shellMarker), `${shell} 输出里没有 ${shellMarker}`);

    const gr = await converse('SMOKE_GREP 搜一下');
    const grTool = gr.snap.tools.find((t) => t.kind === 'grep');
    assert(grTool, '没有 grep 工具调用');
    const grOut = await call('GET', `/api/v2/conversations/${gr.id}/tools/${encodeURIComponent(grTool.id)}/output`);
    console.log(`[${label}] grep 工具 -> ${grTool.status}，输出：${JSON.stringify(grOut.body?.text)}`);
    assert(grTool.status === 'done', `grep 工具状态 ${grTool.status}`);
    assert(String(grOut.body?.text).includes('needle.txt') && String(grOut.body.text).includes(grepMarker), 'grep 结果不对');

    console.log(`[${label}] SMOKE OK importsMs=${importsMs}`);
    return { importsMs, startup: startup.trim() };
  } finally {
    try { proc.stdin.end(); } catch { /* ignore */ }
    await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), sleep(10_000)]);
    if (proc.exitCode === null) proc.kill();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runSmoke(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
