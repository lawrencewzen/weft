import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createStartupTimer, startupFields, logStartupSummary } from '../../src/core/startup-timing.mjs';
import { createLogger } from '../../src/core/log.mjs';
import { readDiscovery, startServer, stopServer } from './_server.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

test('timer: each phase is the time since the previous mark, and the phases add up to the total', () => {
  let t = 0;
  const timer = createStartupTimer({ now: () => t });
  t = 120; timer.mark('imports');
  t = 150; timer.mark('dataDir');
  t = 400; timer.mark('kernel');
  t = 410; timer.mark('listen');
  const snap = timer.snapshot();
  assert.deepEqual(snap.phases, { imports: 120, dataDir: 30, kernel: 250, listen: 10 });
  assert.equal(snap.totalMs, 410);
  assert.equal(Object.values(snap.phases).reduce((a, b) => a + b, 0), snap.totalMs);
});

test('summary record: WEFT_STARTUP with phase, total and scale fields', () => {
  let t = 0;
  const timer = createStartupTimer({ now: () => t });
  t = 100; timer.mark('imports');
  t = 160; timer.mark('settings');
  assert.deepEqual(startupFields(timer.snapshot(), { conversations: 3, workspaces: 2 }), {
    importsMs: 100, settingsMs: 60, totalMs: 160, conversations: 3, workspaces: 2,
  });
  const lines = [];
  const logger = createLogger({ level: 'info', console: true });
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    logStartupSummary(logger, timer.snapshot(), { conversations: 3, workspaces: 2 });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /INFO {2}\[WEFT_STARTUP\] importsMs=100 settingsMs=60 totalMs=160 conversations=3 workspaces=2 ready$/);
});

test('server logs one WEFT_STARTUP line whose phases add up to the total', { timeout: 60_000 }, async () => {
  const dataDir = await makeTempDir('weft-startup-timing-');
  const srv = await startServer({ dataDir, env: { WEFT_LLM: 'faux', WEFT_LOG_CONSOLE: '0' } });
  try {
    await readDiscovery(dataDir);
    let text = '';
    for (let i = 0; i < 50 && !/\[WEFT_STARTUP\]/.test(text); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      text = await readFile(path.join(dataDir, 'logs', 'service.log'), 'utf8').catch(() => '');
    }
    const lines = text.split('\n').filter((l) => l.includes('[WEFT_STARTUP]'));
    assert.equal(lines.length, 1, text);
    const f = Object.fromEntries([...lines[0].matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], Number(m[2])]));
    for (const k of ['importsMs', 'dataDirMs', 'storeMs', 'settingsMs', 'providersMs', 'kernelHarnessMs', 'kernelRecoverMs', 'kernelModelsMs', 'kernelRestMs', 'listenMs', 'readyMs', 'totalMs']) {
      assert.ok(Number.isFinite(f[k]), `${k} missing: ${lines[0]}`);
    }
    assert.equal(f.conversations, 0);
    assert.equal(f.workspaces, 0);
    const sum = Object.entries(f).filter(([k]) => k.endsWith('Ms') && k !== 'totalMs').reduce((a, [, v]) => a + v, 0);
    assert.ok(Math.abs(sum - f.totalMs) <= 12, `sum ${sum} vs total ${f.totalMs}`);
  } finally {
    await stopServer(srv);
    await removeTempDir(dataDir);
  }
});
