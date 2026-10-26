import type { FileContent } from './api';

export type SavePhase = 'idle' | 'saving' | 'saved' | 'conflict' | 'error';

export type SaveState = {
  phase: SavePhase;
  current: FileContent | null;
  message: string;
};

export const IDLE_SAVE: SaveState = { phase: 'idle', current: null, message: '' };

export type SaveAction =
  | { type: 'start' }
  | { type: 'success' }
  | { type: 'conflict'; current: FileContent }
  | { type: 'error'; message: string }
  | { type: 'reload' }
  | { type: 'overwrite' }
  | { type: 'clear' };

export function saveReducer(state: SaveState, action: SaveAction): SaveState {
  switch (action.type) {
    case 'start':
    case 'overwrite':
      return { phase: 'saving', current: null, message: '' };
    case 'success':
      return { phase: 'saved', current: null, message: '' };
    case 'conflict':
      return { phase: 'conflict', current: action.current, message: '' };
    case 'error':
      return { phase: 'error', current: null, message: action.message };
    case 'reload':
    case 'clear':
      return IDLE_SAVE;
    default:
      return state;
  }
}

export function shouldSendBaseVersion(state: SaveState, overwrite: boolean): boolean {
  return !overwrite && state.phase !== 'conflict';
}
