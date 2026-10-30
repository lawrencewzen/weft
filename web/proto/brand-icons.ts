import xai from '@lobehub/icons-static-svg/icons/xai.svg?raw';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?raw';
import openai from '@lobehub/icons-static-svg/icons/openai.svg?raw';
import anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?raw';
import gemini from '@lobehub/icons-static-svg/icons/gemini.svg?raw';
import qwen from '@lobehub/icons-static-svg/icons/qwen.svg?raw';
import githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?raw';
import kiro from '@lobehub/icons-static-svg/icons/kiro.svg?raw';
import deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg?raw';
import moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?raw';
import kimi from '@lobehub/icons-static-svg/icons/kimi.svg?raw';
import zhipu from '@lobehub/icons-static-svg/icons/zhipu.svg?raw';
import openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?raw';
import ollama from '@lobehub/icons-static-svg/icons/ollama.svg?raw';
import lmstudio from '@lobehub/icons-static-svg/icons/lmstudio.svg?raw';
import mistral from '@lobehub/icons-static-svg/icons/mistral.svg?raw';
import meta from '@lobehub/icons-static-svg/icons/meta.svg?raw';
import google from '@lobehub/icons-static-svg/icons/google.svg?raw';
import minimax from '@lobehub/icons-static-svg/icons/minimax.svg?raw';
import xiaomimimo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?raw';
import aws from '@lobehub/icons-static-svg/icons/aws.svg?raw';
import azure from '@lobehub/icons-static-svg/icons/azure.svg?raw';
import googlecloud from '@lobehub/icons-static-svg/icons/googlecloud.svg?raw';
import antgroup from '@lobehub/icons-static-svg/icons/antgroup.svg?raw';
import baseten from '@lobehub/icons-static-svg/icons/baseten.svg?raw';
import cerebras from '@lobehub/icons-static-svg/icons/cerebras.svg?raw';
import cloudflare from '@lobehub/icons-static-svg/icons/cloudflare.svg?raw';
import fireworks from '@lobehub/icons-static-svg/icons/fireworks.svg?raw';
import groq from '@lobehub/icons-static-svg/icons/groq.svg?raw';
import huggingface from '@lobehub/icons-static-svg/icons/huggingface.svg?raw';
import nvidia from '@lobehub/icons-static-svg/icons/nvidia.svg?raw';
import opencode from '@lobehub/icons-static-svg/icons/opencode.svg?raw';
import together from '@lobehub/icons-static-svg/icons/together.svg?raw';
import vercel from '@lobehub/icons-static-svg/icons/vercel.svg?raw';
import alibaba from '@lobehub/icons-static-svg/icons/alibaba.svg?raw';
import bedrock from '@lobehub/icons-static-svg/icons/bedrock.svg?raw';
import vertexai from '@lobehub/icons-static-svg/icons/vertexai.svg?raw';

/**
 * Only the brand icons the prototype data actually shows are bundled; inlining
 * all 950 from `@lobehub/icons-static-svg` would add megabytes to the file.
 */
const ICONS: Record<string, string> = {
  xai,
  grok,
  openai,
  anthropic,
  claude: anthropic,
  gemini,
  qwen,
  githubcopilot,
  'github-copilot': githubcopilot,
  kiro,
  deepseek,
  moonshot,
  kimi,
  zhipu,
  openrouter,
  ollama,
  lmstudio,
  mistral,
  meta,
  google,
  minimax,
  xiaomi: xiaomimimo,
  xiaomimimo,
  aws,
  azure,
  googlecloud,
  antgroup,
  baseten,
  cerebras,
  cloudflare,
  fireworks,
  groq,
  huggingface,
  nvidia,
  opencode,
  together,
  togetherai: together,
  vercel,
  alibaba,
  bedrock,
  vertexai,
};

function dataUri(raw: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(raw)}`;
}

const BRAND_SRC = /^\/vendor\/brand-icons\/([a-z0-9._-]+)\.svg$/i;
const FALLBACK_PLUG_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="%23888888" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v3.5M10 2v3.5"/><path d="M4.5 5.5h7v3a3.5 3.5 0 0 1-7 0Z"/><path d="M8 12v2.5"/></svg>';
const FALLBACK_DATA_URI = `data:image/svg+xml;charset=utf-8,${FALLBACK_PLUG_SVG}`;

function mapBrandSrc(value: unknown): string {
  const text = String(value ?? '');
  const match = BRAND_SRC.exec(text);
  if (!match) return text;
  const raw = ICONS[match[1].toLowerCase()];
  return raw ? dataUri(raw) : FALLBACK_DATA_URI;
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
