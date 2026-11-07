import { describe, expect, it } from 'vitest';
import { parseTriggerPercent } from './GeneralPage';

describe('parseTriggerPercent', () => {
  it('accepts whole numbers from 60 to 90', () => {
    expect(parseTriggerPercent('60')).toBe(60);
    expect(parseTriggerPercent(' 80 ')).toBe(80);
    expect(parseTriggerPercent('90')).toBe(90);
  });

  it('rejects out-of-range, fractional and non-numeric input', () => {
    for (const bad of ['59', '91', '1.5', '75.0', '', 'abc', '-70', '1e2', '080x']) {
      expect(parseTriggerPercent(bad), bad).toBeNull();
    }
  });
});
