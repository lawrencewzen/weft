import { describe, expect, it } from 'vitest';
import { compactCommandOf } from './compactCommand';

describe('compactCommandOf', () => {
  it('treats /compact as a compaction with no instructions', () => {
    expect(compactCommandOf('/compact')).toEqual({});
    expect(compactCommandOf('  /compact  ')).toEqual({});
  });

  it('uses the rest of the line as instructions', () => {
    expect(compactCommandOf('/compact  只保留测试结果')).toEqual({
      instructions: '只保留测试结果',
    });
    expect(compactCommandOf('/compact\nkeep the failing test')).toEqual({
      instructions: 'keep the failing test',
    });
  });

  it('leaves other text alone', () => {
    expect(compactCommandOf('/compactfoo')).toBeNull();
    expect(compactCommandOf('please /compact now')).toBeNull();
    expect(compactCommandOf('')).toBeNull();
  });
});
