import { describe, expect, it } from 'vitest';
import { cssColorToHex } from './cssColor';

describe('cssColorToHex', () => {
  it('passes 6-digit hex through, lower-cased', () => {
    expect(cssColorToHex(' #1F1F1F ')).toBe('#1f1f1f');
  });
  it('converts the oklch values used by --fail', () => {
    expect(cssColorToHex('oklch(0.76 0.13 25)')).toBe('#f98f87');
    expect(cssColorToHex('oklch(0.76 0.12 30)')).toBe('#f49383');
    expect(cssColorToHex('oklch(0.55 0.15 25)')).toBe('#b94642');
  });
  it('reads the minified forms the browser reports for computed custom properties', () => {
    expect(cssColorToHex('#222')).toBe('#222222');
    expect(cssColorToHex('oklch(55% .15 25)')).toBe('#b94642');
  });
  it('returns null for anything else', () => {
    expect(cssColorToHex('rgb(1,2,3)')).toBeNull();
    expect(cssColorToHex('')).toBeNull();
  });
});
