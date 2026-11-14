import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import {
  clipText,
  createScheduleRunLogger,
  relativeScheduleLogFile,
  sanitizeValue,
} from '../../src/kernel/schedule-run-log.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { createFakeClock } from './_fake-clock.mjs';
import { withHarnessLock } from './_harness-lock.mjs';
import { makeTempDir, removeTempDir } from './_tmp.mjs';

const START = new Date(2026, 2, 10, 8, 0, 0, 0).getTime();

async function until(fn, { timeout = 15_000, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function captureLogger() {
  const lines = [];
  const push = (level) => (tag, message, ...extras) => lines.push({ level, tag, message, extras });
  return {
    lines,
    logger: {
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error'),
    },
  };
}

function isolatedNoModelEnv(dataDir) {
  const env = { ...process.env };
  for (const key of [
    'WEFT_LLM',
    'WEFT_FAUX_SCRIPT',
    'WEFT_FAUX_TEXT',
    'WEFT_FAUX_PLAN',
    'WEFT_FAUX_HOLD',
    'LLM_API',
    'LLM_API_KEY',
    'LLM_BASE_URL',
    'LLM_MODEL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
  ]) {
    delete env[key];
  }
  env.HOME = dataDir;
  env.USERPROFILE = dataDir;
  return env;
}

async function openTestEnv({ dataDir, clock, demo = true, env = {}, onSchedulesChanged } = {}) {
  const store = createSqliteStore(dataDir);
  const kernel = await openConversationKernel({
    dataDir,
    store,
    demo,
    clock,
    onSchedulesChanged,
    env: demo ? { ...process.env, WEFT_LLM: 'faux', ...env } : { ...isolatedNoModelEnv(dataDir), ...env },
  });
  return {
    store,
    kernel,
    svc: kernel.schedules,
    async close() {
      await kernel.close();
      store.close();
    },
  };
}

test('relativeScheduleLogFile, clipText, and sanitizeValue enforce Windows-safe names, 64KB clipping, and secret/image masking', () => {
  const rel = relativeScheduleLogFile('sched:1/a', 'sched:1:now:bad\\name?*', Date.UTC(2026, 10, 14, 2, 0, 0));
  assert.equal(rel.includes('\\'), false);
  const base = path.posix.basename(rel);
  assert.equal(/[:"*?<>\\/]/.test(base), false);
  assert.equal(rel, 'logs/schedules/sched-1-a/2026-11-14T02-00-00Z-sched-1-now-bad-name.jsonl');

  const secretClip = clipText('Authorization: Bearer sk-1234567890abcdefghijklmnop ok');
  assert.equal(secretClip.truncated, false);
  assert.equal(secretClip.text.includes('sk-1234567890'), false);

  const big = '中'.repeat(30_000);
  const clipped = clipText(big);
  assert.equal(clipped.truncated, true);
  assert.ok(Buffer.byteLength(clipped.text, 'utf8') <= 64 * 1024);
  assert.match(clipped.text, /\[truncated, 90000 bytes total\]$/);
  assert.equal(clipped.text.includes('\ufffd'), false);

  const masked = sanitizeValue({
    apiKey: 'plain-secret-key',
    token: 'tok-xyz',
    password: 'pw',
    safe: 'Bearer sk-abc1234567890def',
    attachment: { type: 'image', mimeType: 'image/png', data: 'A'.repeat(2048) },
  });
  assert.equal(masked.apiKey, '[REDACTED]');
  assert.equal(masked.token, '[REDACTED]');
  assert.equal(masked.password, '[REDACTED]');
  assert.equal(masked.safe.includes('sk-abc1234567890def'), false);
  assert.equal(masked.attachment.data, '[image omitted, 2048 chars]');
});

test('scheduled run writes complete JSONL execution log, updates SQLite metrics, and keeps service.log free of content', async () => {
  await withHarnessLock(async () => {
    const dataDir = await makeTempDir('weft-schedlog-e2e-');
    const wsDir = await makeTempDir('weft-schedlog-ws-');
    try {
      const scriptPath = path.join(dataDir, 'faux-script.json');
      await writeFile(scriptPath, JSON.stringify({
        turns: [
          {
            when: 'AUDIT_TASK',
            tool: 'bash',
            args: { command: 'printf "cron-bash-out-42\\n"' },
            usage: { input: 110, output: 25 },
          },
          {
            when: 'AUDIT_TASK',
            text: 'audit summary complete token=sk-secret9876543210',
            usage: { input: 140, output: 30 },
          },
        ],
      }), 'utf8');

      const clock = createFakeClock(START);
      const one = await openTestEnv({
        dataDir,
        clock,
        env: { WEFT_FAUX_SCRIPT: scriptPath },
      });
      try {
        const ws = await one.store.createWorkspace({ name: 'proj', path: wsDir, source: 'local' });
        const created = await one.svc.create({
          requestId: 'create-1',
          name: 'Nightly audit',
          message: 'AUDIT_TASK secret-prompt-marker',
          rule: { kind: 'interval', everyMinutes: 15 },
          target: { kind: 'new', workspaceId: ws.id },
        });
        assert.equal(created.status, 201);
        const schedId = created.body.id;

        const triggered = await one.svc.runNow(schedId, { requestId: 'run-1' });
        assert.equal(triggered.status, 200);
        const runId = triggered.body.id;

        await one.svc.whenLogsIdle();

        const dbRun = await until(async () => {
          const r = await one.store.getScheduleRun(runId);
          return r?.finishedAt != null ? r : null;
        }, { label: 'finished dbRun' });

        assert.equal(dbRun.status, 'ok');
        assert.ok(dbRun.submissionId);
        assert.ok(dbRun.finishedAt >= dbRun.at);
        assert.ok(dbRun.durationMs >= 0);
        assert.ok(dbRun.logFile?.endsWith('.jsonl'));
        assert.equal(dbRun.summary.state, 'ok');
        assert.equal(dbRun.summary.trigger, 'manual');
        assert.equal(dbRun.summary.llmCalls, 2);
        assert.equal(dbRun.summary.toolCalls, 1);
        assert.equal(dbRun.summary.toolErrors, 0);
        assert.equal(dbRun.summary.tools.bash, 1);
        assert.equal(dbRun.summary.inputTokens, 250);
        assert.equal(dbRun.summary.outputTokens, 55);
        assert.equal(dbRun.summary.totalTokens, 305);

        // OpenAPI run view still exposes only the 5 contract fields.
        const view = await one.svc.runs(schedId);
        assert.equal(view.status, 200);
        assert.deepEqual(Object.keys(view.body.runs[0]).sort(), ['at', 'conversationId', 'error', 'id', 'status']);

        const fullLogPath = path.join(dataDir, ...dbRun.logFile.split('/'));
        if (process.platform !== 'win32') {
          const info = await stat(fullLogPath);
          assert.equal(info.mode & 0o077, 0);
        }

        const entries = await readJsonl(fullLogPath);
        const startRec = entries.find((e) => e.type === 'run_start');
        assert.ok(startRec);
        assert.equal(startRec.trigger, 'manual');
        assert.equal(startRec.prompt, 'AUDIT_TASK secret-prompt-marker');
        assert.equal(startRec.target.kind, 'new');

        const llmCalls = entries.filter((e) => e.type === 'llm_call');
        assert.equal(llmCalls.length, 2);
        assert.equal(llmCalls[0].toolCalls[0].name, 'bash');
        assert.match(llmCalls[0].toolCalls[0].arguments.command, /cron-bash-out-42/);
        assert.equal(llmCalls[1].text.includes('audit summary complete'), true);
        assert.equal(llmCalls[1].text.includes('sk-secret9876543210'), false);

        const toolResults = entries.filter((e) => e.type === 'tool_result');
        assert.equal(toolResults.length, 1);
        assert.equal(toolResults[0].toolName, 'bash');
        assert.equal(toolResults[0].isError, false);
        assert.match(toolResults[0].output, /cron-bash-out-42/);
        assert.match(toolResults[0].command, /cron-bash-out-42/);

        const endRec = entries.at(-1);
        assert.equal(endRec.type, 'run_end');
        assert.equal(endRec.status, 'ok');
        assert.equal(endRec.summary.llmCalls, 2);
        assert.equal(endRec.summary.toolCalls, 1);

        // Verify service.log never leaks prompt/response/command bodies even if written directly.
        const cap = captureLogger();
        const directLogger = createScheduleRunLogger({
          store: one.store,
          harness: one.kernel.harness,
          context: one.kernel.context,
          dataDir,
          logger: cap.logger,
        });
        await directLogger.recordImmediate({
          schedule: created.body,
          run: {
            id: `${schedId}:privacy`,
            scheduleId: schedId,
            at: START,
            finishedAt: START + 10,
            durationMs: 10,
            status: 'ok',
            conversationId: dbRun.conversationId,
            error: null,
            submissionId: null,
            logFile: relativeScheduleLogFile(schedId, `${schedId}:privacy`, START),
            summary: directLogger.immediateSummary({ trigger: 'scheduled', state: 'ok' }),
          },
          trigger: 'scheduled',
          prompt: 'TOP_SECRET_PROMPT_DO_NOT_LOG',
        });
        const loggedText = JSON.stringify(cap.lines);
        assert.match(loggedText, /WEFT_SCHEDULE_RUN/);
        assert.equal(loggedText.includes('TOP_SECRET_PROMPT_DO_NOT_LOG'), false);
      } finally {
        await one.close();
      }
    } finally {
      await removeTempDir(wsDir);
      await removeTempDir(dataDir);
    }
  });
});

test('async LLM error updates SQLite status to failed and emits notify; delivery error logs immediately', async () => {
  await withHarnessLock(async () => {
    const dataDir = await makeTempDir('weft-schedlog-fail-');
    const wsDir = await makeTempDir('weft-schedlog-ws-');
    try {
      const scriptPath = path.join(dataDir, 'faux-fail.json');
      await writeFile(scriptPath, JSON.stringify({
        turns: Array.from({ length: 6 }, () => ({ when: 'FAIL_TURN', error: 'upstream 429 rate limit' })),
      }), 'utf8');

      const clock = createFakeClock(START);
      let notifies = 0;
      const one = await openTestEnv({
        dataDir,
        clock,
        env: { WEFT_FAUX_SCRIPT: scriptPath, WEFT_RETRY_BASE_MS: '10', WEFT_RETRY_MAX: '2' },
        onSchedulesChanged: () => { notifies += 1; },
      });
      try {
        const ws = await one.store.createWorkspace({ name: 'proj', path: wsDir, source: 'local' });
        const conv = await one.kernel.createConversation({
          workspaceId: ws.id,
          workspacePath: ws.path,
          title: 'fail target',
        });
        const created = await one.svc.create({
          requestId: 'c-fail',
          name: 'Failing task',
          message: 'FAIL_TURN check',
          rule: { kind: 'interval', everyMinutes: 10 },
          target: { kind: 'conversation', conversationId: conv.id },
        });
        const schedId = created.body.id;

        const res = await one.svc.runNow(schedId, { requestId: 'r-fail' });
        assert.equal(res.status, 200);
        const beforeNotifies = notifies;

        await one.svc.whenLogsIdle();
        const dbRun = await one.store.getScheduleRun(res.body.id);
        assert.equal(dbRun.status, 'failed');
        assert.match(dbRun.error, /429 rate limit|terminated|unanswered/i);
        assert.ok(dbRun.finishedAt != null);
        assert.equal(dbRun.summary.state, 'failed');
        assert.ok(notifies > beforeNotifies);

        const entries = await readJsonl(path.join(dataDir, ...dbRun.logFile.split('/')));
        assert.equal(entries[0].type, 'run_start');
        assert.equal(entries.at(-1).type, 'run_end');
        assert.equal(entries.at(-1).status, 'failed');
      } finally {
        await one.close();
      }

      // Separate zero-model kernel: immediate delivery/admission failure also creates run_start + run_end JSONL.
      const dataDirNoModel = await makeTempDir('weft-schedlog-nomodel-');
      try {
        const two = await openTestEnv({ dataDir: dataDirNoModel, clock, demo: false });
        try {
          const conv2 = await two.kernel.createConversation({ title: 'no model chat' });
          const created2 = await two.svc.create({
            requestId: 'c-nomodel',
            name: 'No model task',
            message: 'should fail delivery without model',
            rule: { kind: 'interval', everyMinutes: 10 },
            target: { kind: 'conversation', conversationId: conv2.id },
          });
          const res2 = await two.svc.runNow(created2.body.id, { requestId: 'r-nomodel' });
          assert.equal(res2.status, 200);
          await two.svc.whenLogsIdle();

          const dbRun2 = await two.store.getScheduleRun(res2.body.id);
          assert.equal(dbRun2.status, 'failed');
          assert.ok(dbRun2.error);
          assert.ok(dbRun2.logFile);
          const entries2 = await readJsonl(path.join(dataDirNoModel, ...dbRun2.logFile.split('/')));
          assert.equal(entries2[0].type, 'run_start');
          assert.equal(entries2.at(-1).type, 'run_end');
          assert.equal(entries2.at(-1).status, 'failed');
        } finally {
          await two.close();
        }
      } finally {
        await removeTempDir(dataDirNoModel);
      }
    } finally {
      await removeTempDir(wsDir);
      await removeTempDir(dataDir);
    }
  });
});

test('queued scheduled run isolates entries from prior busy conversation turn', async () => {
  await withHarnessLock(async () => {
    const dataDir = await makeTempDir('weft-schedlog-queue-');
    const wsDir = await makeTempDir('weft-schedlog-ws-');
    try {
      const scriptPath = path.join(dataDir, 'faux-queue.json');
      await writeFile(scriptPath, JSON.stringify({
        turns: [
          { when: 'BUSY_USER', delayMs: 250, text: 'busy user answer', usage: { input: 10, output: 5 } },
          { when: 'QUEUED_SCHED', text: 'queued sched answer', usage: { input: 20, output: 8 } },
          { when: 'QUEUED_SCHED', text: 'queued sched answer', usage: { input: 20, output: 8 } },
        ],
      }), 'utf8');

      const clock = createFakeClock(START);
      const one = await openTestEnv({
        dataDir,
        clock,
        env: { WEFT_FAUX_SCRIPT: scriptPath },
      });
      try {
        const ws = await one.store.createWorkspace({ name: 'proj', path: wsDir, source: 'local' });
        const conv = await one.kernel.createConversation({
          workspaceId: ws.id,
          workspacePath: ws.path,
          title: 'shared conv',
        });
        const created = await one.svc.create({
          requestId: 'c-q',
          name: 'Queued schedule',
          message: 'QUEUED_SCHED check',
          rule: { kind: 'interval', everyMinutes: 10 },
          target: { kind: 'conversation', conversationId: conv.id },
        });

        const busy = await one.kernel.postMessage(conv, 'BUSY_USER prompt', { requestId: 'msg-busy' });
        assert.equal(busy.status, 202);

        const triggered = await one.svc.runNow(created.body.id, { requestId: 'sched-q' });
        assert.equal(triggered.status, 200);

        await one.svc.whenLogsIdle();
        const dbRun = await one.store.getScheduleRun(triggered.body.id);
        assert.equal(dbRun.status, 'ok');

        const raw = await readFile(path.join(dataDir, ...dbRun.logFile.split('/')), 'utf8');
        assert.equal(raw.includes('QUEUED_SCHED check'), true);
        assert.equal(raw.includes('queued sched answer'), true);
        assert.equal(raw.includes('BUSY_USER prompt'), false);
        assert.equal(raw.includes('busy user answer'), false);
      } finally {
        await one.close();
      }
    } finally {
      await removeTempDir(wsDir);
      await removeTempDir(dataDir);
    }
  });
});

test('retention prunes old JSONL files, schedule delete removes log dir, and reconcile recovers interrupted runs', async () => {
  await withHarnessLock(async () => {
    const dataDir = await makeTempDir('weft-schedlog-ret-');
    const wsDir = await makeTempDir('weft-schedlog-ws-');
    try {
      const clock = createFakeClock(START);
      const one = await openTestEnv({ dataDir, clock, env: { WEFT_FAUX_TEXT: 'ok-ret' } });
      try {
        const ws = await one.store.createWorkspace({ name: 'proj', path: wsDir, source: 'local' });
        const conv = await one.kernel.createConversation({ workspaceId: ws.id, workspacePath: ws.path, title: 'ret conv' });

        const sched = await one.svc.create({
          requestId: 'c-ret',
          name: 'Retention test',
          message: 'check retention',
          rule: { kind: 'interval', everyMinutes: 10 },
          target: { kind: 'conversation', conversationId: conv.id },
        });
        const schedId = sched.body.id;

        // Exercise maxKeep=2 pruning using the run logger directly on top of the same schedule dir.
        const prunedLogger = createScheduleRunLogger({
          store: one.store,
          harness: one.kernel.harness,
          context: one.kernel.context,
          dataDir,
          maxKeep: 2,
        });
        for (let i = 1; i <= 4; i += 1) {
          const at = START + i * 1000;
          const runId = `${schedId}:ret:${i}`;
          await prunedLogger.recordImmediate({
            schedule: sched.body,
            run: {
              id: runId,
              scheduleId: schedId,
              at,
              finishedAt: at + 10,
              durationMs: 10,
              status: 'ok',
              conversationId: conv.id,
              error: null,
              submissionId: null,
              logFile: relativeScheduleLogFile(schedId, runId, at),
              summary: prunedLogger.immediateSummary({ trigger: 'manual', state: 'ok' }),
            },
            trigger: 'manual',
            prompt: 'check retention',
          });
        }

        const schedLogDir = path.join(dataDir, 'logs', 'schedules', schedId);
        const files = (await readdir(schedLogDir)).filter((n) => n.endsWith('.jsonl')).sort();
        assert.equal(files.length, 2);
        assert.match(files[0], /ret-3\.jsonl$/);
        assert.match(files[1], /ret-4\.jsonl$/);

        // Insert an interrupted in-flight run from an earlier process, then reconcile() via real service.
        const orphanId = `${schedId}:orphan`;
        const orphanRel = relativeScheduleLogFile(schedId, orphanId, START + 99_000);
        await one.store.addScheduleRun(schedId, {
          id: orphanId,
          at: START + 99_000,
          status: 'ok',
          conversationId: conv.id,
          error: null,
          submissionId: '999999',
          finishedAt: null,
          durationMs: null,
          summary: { trigger: 'scheduled', state: 'running' },
          logFile: orphanRel,
        });
        await one.svc.reconcile();
        const recovered = await one.store.getScheduleRun(orphanId);
        assert.equal(recovered.status, 'failed');
        assert.equal(recovered.error, 'submission not found after restart');
        assert.ok(recovered.finishedAt != null);
        const recEntries = await readJsonl(path.join(dataDir, ...orphanRel.split('/')));
        assert.equal(recEntries.at(-1).type, 'run_end');
        assert.equal(recEntries.at(-1).status, 'failed');

        // Delete schedule via real service and verify entire schedule log directory is removed.
        const delRes = await one.svc.remove(schedId, { requestId: 'del-ret' });
        assert.equal(delRes.status, 200);
        await assert.rejects(stat(schedLogDir), { code: 'ENOENT' });
      } finally {
        await one.close();
      }
    } finally {
      await removeTempDir(wsDir);
      await removeTempDir(dataDir);
    }
  });
});
