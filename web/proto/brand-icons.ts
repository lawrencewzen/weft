import xai from '../../public/vendor/brand-icons/xai.svg?raw';
import grok from '../../public/vendor/brand-icons/grok.svg?raw';
import openai from '../../public/vendor/brand-icons/openai.svg?raw';
import anthropic from '../../public/vendor/brand-icons/anthropic.svg?raw';

/**
 * Only the brand icons the prototype data actually shows are bundled; inlining
 * all 950 from `public/vendor/brand-icons` would add megabytes to the file.
 */
const ICONS: Record<string, string> = {
  xai,
  grok,
  openai,
  anthropic,
};

function dataUri(raw: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}

const BRAND_SRC = /^\/vendor\/brand-icons\/([a-z0-9._-]+)\.svg$/i;

function mapBrandSrc(value: unknown): string {
  const text = String(value ?? '');
  const match = BRAND_SRC.exec(text);
  const raw = match ? ICONS[match[1].toLowerCase()] : undefined;
  return raw ? dataUri(raw) : text;
}

/**
 * `brandIconUrl()` in product code returns `/vendor/brand-icons/<id>.svg`.
 * A single `file://` HTML has no such path, so resolve those image sources to
 * data URIs at the DOM boundary instead of touching the product component.
 *
 * React sets `img.src` both as a property and (for reused nodes) as an
 * attribute, so both paths have to be covered; otherwise a stray
 * `file:///vendor/...` request shows up as a console error.
 */
export function installBrandIcons(): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (descriptor?.get && descriptor.set) {
    const { get, set } = descriptor;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(this: HTMLImageElement) {
        return get.call(this) as string;
      },
      set(this: HTMLImageElement, value: string) {
        set.call(this, mapBrandSrc(value));
      },
    });
  }

  const setAttribute = HTMLImageElement.prototype.setAttribute;
  HTMLImageElement.prototype.setAttribute = function patchedSetAttribute(
    this: HTMLImageElement,
    name: string,
    value: string,
  ) {
    if (String(name).toLowerCase() === 'src') {
      setAttribute.call(this, name, mapBrandSrc(value));
      return;
    }
    setAttribute.call(this, name, value);
  };
}
