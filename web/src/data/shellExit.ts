import { getSettings, putCloseAction, type CloseAction } from './api';

let cachedCloseAction: CloseAction = 'ask';
const subscribers = new Set<(action: CloseAction) => void>();

export function getCachedCloseAction(): CloseAction {
  return cachedCloseAction;
}

export function setCachedCloseAction(action: CloseAction): void {
  if (cachedCloseAction === action) return;
  cachedCloseAction = action;
  subscribers.forEach((fn) => fn(action));
}

export function subscribeCloseAction(fn: (action: CloseAction) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
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
