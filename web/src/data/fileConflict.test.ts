import { describe, expect, it } from 'vitest';
import { IDLE_SAVE, saveReducer, shouldSendBaseVersion, type SaveState } from './fileConflict';
import type { FileContent } from './api';

const current: FileContent = {
  path: 'notes/today.md',
  size: 4,
  binary: false,
  tooLarge: false,
  text: 'disk',
  version: 'abc123',
};

describe('file save conflict state machine', () => {
  it('goes idle → saving → saved', () => {
    let state: SaveState = IDLE_SAVE;
    state = saveReducer(state, { type: 'start' });
    expect(state.phase).toBe('saving');
    expect(shouldSendBaseVersion(state, false)).toBe(true);
    state = saveReducer(state, { type: 'success' });
    expect(state.phase).toBe('saved');
  });

  it('records a 409 current snapshot and offers overwrite without baseVersion', () => {
    let state = saveReducer(IDLE_SAVE, { type: 'start' });
    state = saveReducer(state, { type: 'conflict', current });
    expect(state).toEqual({ phase: 'conflict', current, message: '' });
    expect(shouldSendBaseVersion(state, false)).toBe(false);
    expect(shouldSendBaseVersion(state, true)).toBe(false);
    state = saveReducer(state, { type: 'overwrite' });
    expect(state.phase).toBe('saving');
    expect(state.current).toBeNull();
  });

  it('reload and clear return to idle; errors keep a message', () => {
    let state = saveReducer(IDLE_SAVE, { type: 'conflict', current });
    state = saveReducer(state, { type: 'reload' });
    expect(state).toEqual(IDLE_SAVE);
    state = saveReducer(state, { type: 'error', message: 'nope' });
    expect(state.phase).toBe('error');
    expect(state.message).toBe('nope');
    state = saveReducer(state, { type: 'clear' });
    expect(state).toEqual(IDLE_SAVE);
  });
});
