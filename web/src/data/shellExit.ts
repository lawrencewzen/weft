import { getSettings, putCloseAction, type CloseAction } from './api';

let cachedCloseAction: CloseAction = 'ask';

export function getCachedCloseAction(): CloseAction {
  return cachedCloseAction;
}

export function setCachedCloseAction(action: CloseAction): void {
  cachedCloseAction = action;
}

export async function fetchCloseAction(): Promise<CloseAction> {
  try {
    const s = await getSettings();
    const action = s.closeAction ?? 'ask';
    setCachedCloseAction(action);
    return action;
  } catch {
    return cachedCloseAction;
  }
}

export async function updateCloseAction(action: CloseAction): Promise<void> {
  setCachedCloseAction(action);
  await putCloseAction(action);
}

export function resetCloseActionForTesting(action: CloseAction = 'ask'): void {
  cachedCloseAction = action;
}
