import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';
import { agentShellKind } from '../../src/platform/win/shell.mjs';

const {
  COMMAND_TOOL_NAMES,
  isCommandToolName,
  reservedBuiltinToolNames,
  TOOLS,
  workspaceToolNames,
} = await load('src/core/config.mjs');

test('TOOLS lists every builtin workspace tool for this process', () => {
  assert.deepEqual(TOOLS, ['read', 'write', 'edit', 'ls', 'grep', agentShellKind()]);
  assert.deepEqual(workspaceToolNames(), TOOLS);
});

test('reservedBuiltinToolNames keeps both command shells', () => {
  assert.deepEqual(COMMAND_TOOL_NAMES, ['bash', 'powershell']);
  assert.deepEqual(reservedBuiltinToolNames(), ['read', 'write', 'edit', 'ls', 'grep', 'bash', 'powershell']);
  assert.equal(isCommandToolName('bash'), true);
  assert.equal(isCommandToolName('PowerShell'), true);
  assert.equal(isCommandToolName('read'), false);
});
