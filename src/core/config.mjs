import { agentShellKind } from '../platform/win/shell.mjs';

/** Command tools the UI treats as one kind (`bash` in the contract). */
export const COMMAND_TOOL_NAMES = ['bash', 'powershell'];

export function isCommandToolName(name) {
  return COMMAND_TOOL_NAMES.includes(String(name || '').toLowerCase());
}

/** Builtin workspace tool names for this process (command tool follows agentShellKind). */
export function workspaceToolNames(env = process.env, platform = process.platform) {
  return ['read', 'write', 'edit', 'ls', 'grep', agentShellKind(env, platform)];
}

/** Names plugins may not occupy: both command shells, even if this process only offers one. */
export function reservedBuiltinToolNames() {
  return ['read', 'write', 'edit', 'ls', 'grep', ...COMMAND_TOOL_NAMES];
}

export const TOOLS = workspaceToolNames();
