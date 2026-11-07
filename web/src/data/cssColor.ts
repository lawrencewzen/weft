/** Resolve the CSS colours the desktop shell needs to #rrggbb. Handles `#rgb`, `#rrggbb` and `oklch(L C h)` (the theme `--fail`), as browsers serialise them. */

function toByte(linear: number): number {
  const v = linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

export function cssColorToHex(raw: string): string | null {
  const value = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  // Computed custom properties come back minified: `#222`, `oklch(55% .15 25)`.
  const short = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*\)$/i.exec(value);
  if (!m) return null;
  const L = Number(m[1]) / (m[2] ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  if (![L, C, h].every(Number.isFinite)) return null;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s;
  return '#' + [r, g, bl].map((c) => toByte(c).toString(16).padStart(2, '0')).join('');
}
