/** CSS `zoom` on `html` (see `--ui-zoom` in app.css). Visual coords from
 * getBoundingClientRect / clientX are zoomed; values written to style.left/top/width
 * are multiplied by zoom again, so callers must divide by the used factor. */

const FALLBACK_VIEWPORT_W = 1440;
const FALLBACK_VIEWPORT_H = 900;

export function parseUiZoom(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text || text === 'normal' || text === 'none') return null;
  if (text.endsWith('%')) {
    const n = Number.parseFloat(text);
    return Number.isFinite(n) && n > 0 ? n / 100 : null;
  }
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

type ZoomStyle = {
  zoom?: string;
  getPropertyValue?: (name: string) => string;
};

export function zoomFromStyle(style: ZoomStyle): number {
  const fromZoom = parseUiZoom(style.zoom);
  if (fromZoom != null) return fromZoom;
  const fromVar = parseUiZoom(style.getPropertyValue?.('--ui-zoom'));
  if (fromVar != null) return fromVar;
  return 1;
}

export function readUiZoom(root?: Element | null): number {
  if (typeof getComputedStyle !== 'function') return 1;
  const el = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!el) return 1;
  try {
    const style = getComputedStyle(el) as CSSStyleDeclaration & { zoom?: string };
    return zoomFromStyle(style);
  } catch {
    return 1;
  }
}

export function visualToCss(visualPx: number, zoom = readUiZoom()): number {
  if (!Number.isFinite(visualPx)) return 0;
  if (!Number.isFinite(zoom) || zoom <= 0) return visualPx;
  return visualPx / zoom;
}

export function cssViewportWidth(): number {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT_W;
  return window.innerWidth / readUiZoom();
}

export function cssViewportHeight(): number {
  if (typeof window === 'undefined') return FALLBACK_VIEWPORT_H;
  return window.innerHeight / readUiZoom();
}
