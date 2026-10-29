export const FOCUS_SUBAGENT_EVENT = 'weft:focus-subagent';

export interface FocusSubagentDetail {
  agentId: string;
}

export function focusSubagent(agentId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<FocusSubagentDetail>(FOCUS_SUBAGENT_EVENT, {
      detail: { agentId },
    })
  );
}
