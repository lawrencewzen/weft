import { describe, expect, it } from 'vitest';
import { handoffCommandOf } from './handoffCommand';

describe('handoffCommandOf', () => {
  it('treats /handoff as a handoff with no focus', () => {
    expect(handoffCommandOf('/handoff')).toEqual({});
    expect(handoffCommandOf('  /handoff  ')).toEqual({});
  });

  it('uses the rest of the line as instructions', () => {
    expect(handoffCommandOf('/handoff  packages/server 的配置')).toEqual({
      instructions: 'packages/server 的配置',
    });
    expect(handoffCommandOf('/handoff\nkeep the failing test')).toEqual({
      instructions: 'keep the failing test',
    });
  });

  it('leaves other text alone', () => {
    expect(handoffCommandOf('/handofffoo')).toBeNull();
    expect(handoffCommandOf('please /handoff now')).toBeNull();
    expect(handoffCommandOf('')).toBeNull();
  });
});
