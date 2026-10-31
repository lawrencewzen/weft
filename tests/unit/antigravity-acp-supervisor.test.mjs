import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AntigravityAcpConnection,
  AntigravityRuntime,
  resolveSupervisorEntry,
} from '../../src/vendor/antigravity-acp.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const VENDOR_PATH = fileURLToPath(new URL('../../src/vendor/antigravity-acp.mjs', import.meta.url));

const MODEL = {
  id: 'gemini-3.8-flash',
  name: 'Gemini 3.8 Flash',
  provider: 'antigravity-acp',
  api: 'antigravity-acp',
  reasoning: false,
};

// Speaks newline-delimited JSON-RPC on stdin/stdout. The real supervisor
// execs this file; it only has to answer the three ACP calls a turn makes.
const FAKE_ACP_SERVER = `#!/usr/bin/env node
import { appendFileSync, writeSync } from 'node:fs';

const logPath = process.env.FAKE_ACP_LOG;
const session = {
  sessionId: 'fake-session',
  modes: {
    currentModeId: 'yolo',
    availableModes: [{ id: 'yolo', name: 'Yolo' }],
  },
  configOptions: [{
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-3.8-flash',
    options: [{ value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }],
  }],
};

function note(method) {
  if (logPath) appendFileSync(logPath, method + '\\n');
}

function resultFor(method) {
  if (method === 'initialize') {
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    };
  }
  if (method === 'session/new' || method === 'session/load' || method === 'session/resume') return session;
  if (method === 'session/prompt') return { stopReason: 'end_turn' };
  if (method === 'session/set_config_option') return { configOptions: session.configOptions };
  return {};
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).replace(/\\r$/, '');
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      process.stderr.write('fake acp bad json: ' + (err instanceof Error ? err.message : String(err)) + '\\n');
      continue;
    }
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) {
      continue;
    }
    note(msg.method);
    writeSync(1, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: resultFor(msg.method) }) + '\\n');
  }
});
process.stdin.on('end', () => {
  setTimeout(() => process.exit(0), 20);
});
`;

test('resolveSupervisorEntry points at the vendored supervisor file', () => {
  const entry = resolveSupervisorEntry();
  assert.equal(existsSync(entry), true);
  assert.equal(path.basename(entry), 'supervisor.mjs');
  assert.equal(path.dirname(entry), path.dirname(VENDOR_PATH));
  const supervisor = readFileSync(entry, 'utf8');
  const bundle = readFileSync(VENDOR_PATH, 'utf8');
  assert.match(supervisor, /from "node:child_process"/);
  assert.match(supervisor, /Copyright \(c\) 2026 pi-gemini-acp-provider contributors/);
  assert.match(supervisor, /Permission is hereby granted, free of charge/);
  assert.match(bundle, /Copyright \(c\) 2026 pi-gemini-acp-provider contributors/);
  assert.match(bundle, /new URL\("\.\/supervisor\.mjs", import\.meta\.url\)/);
});

test('a fake ACP server started through the real supervisor completes initialize, newSession, and prompt', async () => {
  const dir = await makeTempDir('weft-agy-supervisor-');
  const script = path.join(dir, 'fake-agy-acp.mjs');
  const logPath = path.join(dir, 'methods.log');
  writeFileSync(script, FAKE_ACP_SERVER, { encoding: 'utf8' });
  chmodSync(script, 0o755);
  const saved = {
    AGY_ACP_BIN: process.env.AGY_ACP_BIN,
    GEMINI_HOME: process.env.GEMINI_HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    FAKE_ACP_LOG: process.env.FAKE_ACP_LOG,
  };
  // Windows CreateProcess does not run a shebang script. entryPath still goes
  // through supervisor.mjs: node supervisor.mjs --command <node> <script>.
  // Everywhere else AGY_ACP_BIN is the fake server, which is the production override.
  const factory = process.platform === 'win32'
    ? (options) => new AntigravityAcpConnection({ ...options, entryPath: script })
    : undefined;
  if (process.platform !== 'win32') process.env.AGY_ACP_BIN = script;
  process.env.GEMINI_HOME = dir;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, 'pi-agent');
  process.env.FAKE_ACP_LOG = logPath;
  const runtime = new AntigravityRuntime(factory, 'yolo', memoryStore(), () => dir);
  try {
    const stream = runtime.stream(MODEL, {
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    }, { sessionId: 'agy-supervisor' }).stream;
    let result;
    try {
      result = await stream.result();
    } catch (err) {
      result = {
        stopReason: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    const methods = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert.equal(
      result.stopReason,
      'stop',
      `${result.errorMessage || JSON.stringify(result)}\nmethods=${methods.join(',')}`,
    );
    assert.equal(methods[0], 'initialize');
    const opened = methods.indexOf('session/new');
    const prompted = methods.indexOf('session/prompt');
    assert.equal(opened > 0, true, methods.join(','));
    assert.equal(prompted > opened, true, methods.join(','));
  } finally {
    await runtime.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(dir);
  }
});

function memoryStore() {
  const records = new Map();
  return {
    get(id) { return records.get(id); },
    save(next) { records.set(next.piSessionId, next); },
    remove(id) { records.delete(id); },
    clear() { records.clear(); },
  };
}
