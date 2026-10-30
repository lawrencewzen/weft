import { describe, expect, it } from 'vitest';
import { parseUiZoom, visualToCss, zoomFromStyle } from './uiZoom';

describe('parseUiZoom', () => {
  it('parses unitless, percent, and rejects empty/invalid', () => {
    expect(parseUiZoom('0.9')).toBe(0.9);
    expect(parseUiZoom('90%')).toBe(0.9);
    expect(parseUiZoom(' 1 ')).toBe(1);
    expect(parseUiZoom('normal')).toBeNull();
    expect(parseUiZoom('none')).toBeNull();
    expect(parseUiZoom('')).toBeNull();
    expect(parseUiZoom(undefined)).toBeNull();
    expect(parseUiZoom('0')).toBeNull();
    expect(parseUiZoom('-0.9')).toBeNull();
  });
});

describe('zoomFromStyle', () => {
  it('prefers computed zoom, then --ui-zoom, else 1', () => {
    expect(zoomFromStyle({ zoom: '0.9' })).toBe(0.9);
    expect(zoomFromStyle({ zoom: '90%', getPropertyValue: () => '0.5' })).toBe(0.9);
    expect(zoomFromStyle({
      zoom: 'normal',
      getPropertyValue: (name) => (name === '--ui-zoom' ? '0.9' : ''),
    })).toBe(0.9);
    expect(zoomFromStyle({ zoom: '', getPropertyValue: () => '' })).toBe(1);
  });
});

describe('visualToCss', () => {
  it('divides visual pixels by the zoom factor', () => {
    expect(visualToCss(90, 0.9)).toBeCloseTo(100);
    expect(visualToCss(1280, 0.9)).toBeCloseTo(1280 / 0.9);
    expect(visualToCss(40, 1)).toBe(40);
    expect(visualToCss(40, 0)).toBe(40);
  });
});
