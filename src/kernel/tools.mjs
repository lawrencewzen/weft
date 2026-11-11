// Workspace tools for the Pi Durable kernel.
// read/edit are hashline versions (hashline-tools.mjs), write and bash or powershell
// are official Pi Durable tools. grep is ripgrep-backed (grep-tool.mjs); ls uses the
// conversation ExecutionEnv. Path checks live only in workspace-env.mjs.
import path from 'node:path';
import { obj, opt, str } from '@earendil-works/pi-schema';
import { defineExtension, defineTool, GenerationTask, hook, ToolTask } from '@earendil-works/pi-durable';
import { FileError, getOrThrow } from '@earendil-works/pi-durable/env';
import { createBashTool, createPowerShellTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { diffStats, splitLines } from '../core/diff.mjs';
import {
  agentPowerShellPrograms,
  agentShellKind,
  powershellCommandPrefix,
  windowsChildEnv,
} from '../platform/win/shell.mjs';
import { applyBashEnvAllowlist } from './bash-env.mjs';
import { createGrepTool } from './grep-tool.mjs';
import { createHandoffTool } from './handoff.mjs';
import { createHashlineEditTool, createHashlineReadTool } from './hashline-tools.mjs';
import { EXT_WORKSPACE } from './ids.mjs';
import { log } from '../core/log.mjs';

const DETAIL_CAP = 1024 * 1024;

export const DEFAULT_BASH_TIMEOUT_SECONDS = 600;
/** The official bash tool refuses anything above 2_147_483_647 ms. */
export const MAX_BASH_TIMEOUT_SECONDS = 2_147_483.647;

/**
 * The bash cap in seconds: `WEFT_BASH_TIMEOUT_SECONDS` when it is a positive
 * number, clamped to the official maximum; the built-in default otherwise.
 */
export function bashTimeoutSeconds(env = process.env) {
  const raw = String(env?.WEFT_BASH_TIMEOUT_SECONDS ?? '').trim();
  if (raw === '') return DEFAULT_BASH_TIMEOUT_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_BASH_TIMEOUT_SECONDS;
  return Math.min(seconds, MAX_BASH_TIMEOUT_SECONDS);
}

/**
 * Fill in the bash timeout when the model left it out. The official tool has no
 * default, so a hung command (`npm test`, a stray watcher) would hold the
 * conversation "running" until someone stops it. The value lands in the
 * prepared arguments, so the checkpoint shows the timeout the call actually ran
 * with, and a timeout the model chose is kept as is.
 */
function withDefaultTimeout(tool) {
  const prepare = tool.prepareArguments;
  const execute = tool.execute;
  const capped = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    if (input.timeout !== undefined) return input;
    return { ...input, timeout: bashTimeoutSeconds() };
  };
  return {
    ...tool,
    prepareArguments(input) {
      const next = capped(input);
      return prepare ? prepare(next) : next;
    },
    async execute(args, api, context) {
      return execute(capped(args), api, context);
    },
  };
}

function withReplay(tool, replay) {
  return { ...tool, replay };
}

const INTENT_DESCRIPTION = '可选。用不超过 15 个字说明这一步要干什么，例如『跑单元测试』『看登录逻辑』。';

/** Optional description on a tool's JSON Schema, without making it required. */
function withIntentParameters(schema) {
  const base = schema && typeof schema === 'object' ? schema : obj({});
  const properties = {
    ...(base.properties && typeof base.properties === 'object' ? base.properties : {}),
    description: { type: 'string', description: INTENT_DESCRIPTION },
  };
  const required = Array.isArray(base.required)
    ? base.required.filter((name) => name !== 'description')
    : [];
  const next = { ...base, type: 'object', properties };
  if (required.length) next.required = required;
  else delete next.required;
  return next;
}

function omitIntent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (!Object.hasOwn(input, 'description')) return input;
  const { description: _description, ...rest } = input;
  return rest;
}

function readIntent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  return typeof input.description === 'string' ? input.description : undefined;
}

/**
 * Add optional `description` so the model can name the step. Pi Durable validates
 * the value returned by prepareArguments, then stores that same object on the
 * live checkpoint (`tool_execution_start.args`). The inner tool therefore sees
 * arguments without `description`; the UI still receives it.
 */
export function withIntent(tool) {
  const prepare = tool.prepareArguments;
  const execute = tool.execute;
  return {
    ...tool,
    parameters: withIntentParameters(tool.parameters),
    prepareArguments(input) {
      const description = readIntent(input);
      let next = omitIntent(input);
      next = prepare ? prepare(next) : next;
      if (description === undefined) return next;
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        return { ...next, description };
      }
      return next;
    },
    async execute(args, api, context) {
      return execute(omitIntent(args), api, context);
    },
  };
}

/** Map the previous `{ old, new }` shape onto the official edit schema. */
function withLegacyEditArgs(tool) {
  const prepare = tool.prepareArguments;
  return {
    ...tool,
    prepareArguments(input) {
      let next = input;
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        const mapped = { ...next };
        if (typeof mapped.old === 'string' && mapped.oldText === undefined) mapped.oldText = mapped.old;
        if (typeof mapped.new === 'string' && mapped.newText === undefined) mapped.newText = mapped.new;
        next = mapped;
      }
      return prepare ? prepare(next) : next;
    },
  };
}

/**
 * Official write/edit details have no before/after. Capture them here because
 * afterTool's HookApi has no env. afterTool then applies the 1 MB cap.
 */
function withFileChangeDetails(tool) {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(args, api, context) {
      const env = api.env;
      const filePath = typeof args?.path === 'string' ? args.path : '';
      let before = '';
      if (env && filePath) {
        const previous = await env.readTextFile(filePath, context);
        before = previous.ok ? previous.value : '';
      }
      const result = await execute(args, api, context);
      if (!env || !filePath || result?.isError) return result;
      const next = await env.readTextFile(filePath, context);
      const after = next.ok
        ? next.value
        : (typeof args.content === 'string' ? args.content : '');
      const details = result?.details && typeof result.details === 'object' ? result.details : {};
      return {
        ...result,
        details: { ...details, path: filePath, before, after },
      };
    },
  };
}

/**
 * write / edit stay inside the workspace. Reads are allowed outside it (see
 * workspace-env.mjs), so the official tools' own read-before-write steps would
 * otherwise get past the path check; refuse up front instead.
 */
function withWorkspaceOnly(tool) {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(args, api, context) {
      const filePath = typeof args?.path === 'string' ? args.path : '';
      if (api?.env && filePath) {
        const allowed = await api.env.allow(await resolveAgainstCwd(api.env, filePath));
        if (!allowed.ok) throw allowed.error;
      }
      return execute(args, api, context);
    },
  };
}

function resolveAgainstCwd(env, filePath) {
  return path.resolve(env.cwd, filePath);
}

function requireEnv(api) {
  if (!api?.env) throw new FileError('invalid', 'E_SANDBOX: conversation cwd is not set');
  return api.env;
}

function createLsTool() {
  return defineTool({
    name: 'ls',
    description: 'List a directory. Paths outside the workspace are readable except sensitive locations (credentials).',
    parameters: obj({ path: opt(str()) }),
    replay: 'safe',
    async execute(args, api, context) {
      const env = requireEnv(api);
      const rel = args.path || '.';
      const info = getOrThrow(await env.fileInfo(rel, context));
      if (info.kind !== 'directory') {
        return { output: [{ type: 'text', text: info.name }] };
      }
      const entries = getOrThrow(await env.listDir(rel, context));
      const lines = entries
        .map((entry) => `${entry.kind === 'directory' ? 'd' : 'f'} ${entry.name}`)
        .join('\n');
      return { output: [{ type: 'text', text: lines }] };
    },
  });
}

const fileWorkspaceTools = [
  withIntent(withReplay(createHashlineReadTool(), 'safe')),
  withIntent(withReplay(withWorkspaceOnly(withFileChangeDetails(createWriteTool())), 'unsafe')),
  withIntent(withReplay(withWorkspaceOnly(withFileChangeDetails(withLegacyEditArgs(createHashlineEditTool()))), 'unsafe')),
  withIntent(createLsTool()),
  withIntent(createGrepTool()),
  withIntent(createHandoffTool()),
];

const commandTools = new Map();

function wrapCommandTool(tool) {
  return withIntent(withReplay(withDefaultTimeout(tool), 'unsafe'));
}

/** Official bash or powershell tool for this process (or an explicit kind). */
export function createAgentShellTool(kind = agentShellKind()) {
  const cached = commandTools.get(kind);
  if (cached) return cached;
  const tool = kind === 'powershell'
    ? wrapCommandTool(createPowerShellTool({
      programs: agentPowerShellPrograms(),
      commandPrefix: powershellCommandPrefix,
      prepare(execution) {
        applyBashEnvAllowlist(execution);
        execution.env = windowsChildEnv(execution.env);
      },
    }))
    : wrapCommandTool(createBashTool({
      prepare(execution) {
        applyBashEnvAllowlist(execution);
      },
    }));
  commandTools.set(kind, tool);
  return tool;
}

export function workspaceTools() {
  return [...fileWorkspaceTools, createAgentShellTool()];
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

const HARNESS_SKIPPED_TOOL = new Set([
  'tool_unavailable',
  'invalid_arguments',
  'blocked',
  'interrupted',
  'restart_limit',
  'aborted',
  'abandoned',
]);

/** 1.5 runs afterTool for results the Harness writes itself, before the tool runs. */
function harnessSkippedTool(result) {
  const diagnostics = result?.diagnostics;
  return Array.isArray(diagnostics) && diagnostics.some((item) => HARNESS_SKIPPED_TOOL.has(item?.code));
}

/** Keep path, before, after, and line stats on the tool result. Over 1 MB, line stats only. */
export function fileChangeDetails({ path: filePath, before, after }) {
  const oldText = before ?? '';
  const newText = after ?? '';
  const { added, removed } = diffStats(oldText, newText);
  if (byteLength(oldText) > DETAIL_CAP || byteLength(newText) > DETAIL_CAP) {
    return {
      path: filePath,
      added,
      removed,
      linesBefore: splitLines(oldText).length,
      linesAfter: splitLines(newText).length,
      oversized: true,
    };
  }
  return { path: filePath, before: oldText, after: newText, added, removed };
}

/**
 * Host hook: after write/edit succeeds, keep official details and the diff
 * snapshot the right-hand changes list reads back.
 * `hooks.beforeRequest` / `hooks.afterRun` record one turn's file list.
 * The object is filled in after the kernel finishes opening.
 */
export function createWorkspaceExtension(hooks = {}) {
  const bridge = hooks || {};
  return defineExtension({
    name: EXT_WORKSPACE,
    tools: workspaceTools(),
    hooks: [
      hook(ToolTask, {
        async afterTool(call, result) {
          if (harnessSkippedTool(result)) return undefined;
          const details = result?.details;
          const tracked = details
            && !result.isError
            && (call.name === 'write' || call.name === 'edit')
            && typeof details.path === 'string';
          if (!tracked) return undefined;
          const change = fileChangeDetails({
            path: details.path,
            before: details.before ?? '',
            after: details.after ?? '',
          });
          const { before: _before, after: _after, ...rest } = details;
          return {
            ...result,
            details: { ...rest, ...change },
          };
        },
      }),
      hook(GenerationTask, {
        async beforeRequest(_request, api, hookContext) {
          if (typeof bridge.beforeRequest !== 'function') return undefined;
          try {
            await bridge.beforeRequest(api, hookContext);
          } catch (err) {
            log.error('WEFT_TURN_CHANGES', '', err);
          }
          return undefined;
        },
        async afterRun(run, api) {
          if (typeof bridge.afterRun !== 'function') return undefined;
          try {
            await bridge.afterRun(api.conversationId, run?.answer);
          } catch (err) {
            log.error('WEFT_TURN_CHANGES', '', err);
          }
          return undefined;
        },
      }),
    ],
  });
}
