import { describe, expect, it } from 'vitest';
import { computeFlipCoords } from './stripProjectsMotion';

describe('computeFlipCoords', () => {
  it('computes basic delta without scrolling or zoom', () => {
    const coords = computeFlipCoords({
      originRect: { left: 19, top: 168, width: 16, height: 16 },
      targetRect: { left: 19, top: 124, width: 16, height: 16 },
      zoom: 1,
    });
    expect(coords.visualDeltaX).toBe(0);
    expect(coords.visualDeltaY).toBe(44);
    expect(coords.cssDeltaX).toBe(0);
    expect(coords.cssDeltaY).toBe(44);
    expect(coords.totalDistance).toBe(44);
  });

  it('divides visual deltas by zoom according to uiZoom convention', () => {
    const coords = computeFlipCoords({
      originRect: { left: 17.1, top: 151.2, width: 14.4, height: 14.4 },
      targetRect: { left: 17.1, top: 111.6, width: 14.4, height: 14.4 },
      zoom: 0.9,
    });
    expect(coords.visualDeltaX).toBeCloseTo(0);
    expect(coords.visualDeltaY).toBeCloseTo(39.6);
    expect(coords.cssDeltaX).toBeCloseTo(0);
    expect(coords.cssDeltaY).toBeCloseTo(44);
    expect(coords.totalDistance).toBeCloseTo(39.6);
  });

  it('clamps origin when scrolled out of visible scroll area (top and bottom)', () => {
    const scrollRect = { left: 0, top: 100, width: 264, height: 300, right: 264, bottom: 400 };

    // Scrolled above visible area
    const coordsAbove = computeFlipCoords({
      originRect: { left: 19, top: 50, width: 16, height: 16 },
      targetRect: { left: 19, top: 124, width: 16, height: 16 },
      scrollRect,
      zoom: 1,
    });
    // originY should be clamped to scrollRect.top (100)
    expect(coordsAbove.visualDeltaY).toBe(100 - 124);

    // Scrolled below visible area
    const coordsBelow = computeFlipCoords({
      originRect: { left: 19, top: 500, width: 16, height: 16 },
      targetRect: { left: 19, top: 124, width: 16, height: 16 },
      scrollRect,
      zoom: 1,
    });
    // originY should be clamped to scrollRect.bottom - height (400 - 16 = 384)
    expect(coordsBelow.visualDeltaY).toBe(384 - 124);
  });
});
