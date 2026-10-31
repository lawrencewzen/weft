// Point Antigravity ACP at the conversation workspace.
// Pi Durable still owns the turn. This hook only records sessionId -> cwd
// before the provider streams; it does not schedule work or store checkpoints.
import { defineExtension, GenerationTask, hook, ProviderDoc } from '@earendil-works/pi-durable';
import {
  bindAntigravitySessionCwd,
  noteAntigravityTurn,
} from '../core/antigravity-acp.mjs';
import { EXT_ANTIGRAVITY_CWD } from './ids.mjs';

/** Agent cwd for a harness conversation. Blank means the chat has no workspace. */
export async function readAgentCwd(harness, context, harnessId) {
  if (!harness || harnessId == null || !context) return '';
  try {
    const handle = await harness.conversation(harnessId, context);
    if (!handle) return '';
    const agent = await handle.agent(context);
    return typeof agent?.cwd === 'string' ? agent.cwd.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Record the workspace for this turn. `sessionId` is absent on the first
 * request (Pi Durable creates it after beforeRequest); the async-local cwd
 * still covers that call. Later requests bind the persisted session id.
 */
export async function rememberAntigravityConversationCwd(harness, context, harnessId, sessionId) {
  const cwd = await readAgentCwd(harness, context, harnessId);
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (id) bindAntigravitySessionCwd(id, cwd);
  noteAntigravityTurn(cwd);
  return cwd;
}

/**
 * `bound.harness` / `bound.context` are filled after Harness.open.
 * The hook reads them when a turn starts.
 */
export function createAntigravityCwdExtension(bound = {}) {
  return defineExtension({
    name: EXT_ANTIGRAVITY_CWD,
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(_request, api, hookContext) {
          let sessionId = '';
          try {
            const provider = await api.snapshot(ProviderDoc, api.conversationId, hookContext);
            if (typeof provider?.sessionId === 'string') sessionId = provider.sessionId;
          } catch { /* the first turn still has the async-local workspace */ }
          await rememberAntigravityConversationCwd(
            bound.harness,
            bound.context,
            api.conversationId,
            sessionId,
          );
        },
      }),
    ],
  });
}
