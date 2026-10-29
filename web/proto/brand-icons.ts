import xai from '../../public/vendor/brand-icons/xai.svg?raw';
import grok from '../../public/vendor/brand-icons/grok.svg?raw';
import openai from '../../public/vendor/brand-icons/openai.svg?raw';
import anthropic from '../../public/vendor/brand-icons/anthropic.svg?raw';
import gemini from '../../public/vendor/brand-icons/gemini.svg?raw';
import qwen from '../../public/vendor/brand-icons/qwen.svg?raw';
import githubcopilot from '../../public/vendor/brand-icons/githubcopilot.svg?raw';
import kiro from '../../public/vendor/brand-icons/kiro.svg?raw';
import deepseek from '../../public/vendor/brand-icons/deepseek.svg?raw';
import moonshot from '../../public/vendor/brand-icons/moonshot.svg?raw';
import kimi from '../../public/vendor/brand-icons/kimi.svg?raw';
import zhipu from '../../public/vendor/brand-icons/zhipu.svg?raw';
import openrouter from '../../public/vendor/brand-icons/openrouter.svg?raw';
import ollama from '../../public/vendor/brand-icons/ollama.svg?raw';
import lmstudio from '../../public/vendor/brand-icons/lmstudio.svg?raw';
import mistral from '../../public/vendor/brand-icons/mistral.svg?raw';
import meta from '../../public/vendor/brand-icons/meta.svg?raw';
import google from '../../public/vendor/brand-icons/google.svg?raw';
import minimax from '../../public/vendor/brand-icons/minimax.svg?raw';
import xiaomimimo from '../../public/vendor/brand-icons/xiaomimimo.svg?raw';
import aws from '../../public/vendor/brand-icons/aws.svg?raw';
import azure from '../../public/vendor/brand-icons/azure.svg?raw';
import googlecloud from '../../public/vendor/brand-icons/googlecloud.svg?raw';
import antgroup from '../../public/vendor/brand-icons/antgroup.svg?raw';
import baseten from '../../public/vendor/brand-icons/baseten.svg?raw';
import cerebras from '../../public/vendor/brand-icons/cerebras.svg?raw';
import cloudflare from '../../public/vendor/brand-icons/cloudflare.svg?raw';
import fireworks from '../../public/vendor/brand-icons/fireworks.svg?raw';
import groq from '../../public/vendor/brand-icons/groq.svg?raw';
import huggingface from '../../public/vendor/brand-icons/huggingface.svg?raw';
import nvidia from '../../public/vendor/brand-icons/nvidia.svg?raw';
import opencode from '../../public/vendor/brand-icons/opencode.svg?raw';
import together from '../../public/vendor/brand-icons/together.svg?raw';
import vercel from '../../public/vendor/brand-icons/vercel.svg?raw';
import alibaba from '../../public/vendor/brand-icons/alibaba.svg?raw';
import bedrock from '../../public/vendor/brand-icons/bedrock.svg?raw';
import vertexai from '../../public/vendor/brand-icons/vertexai.svg?raw';

/**
 * Only the brand icons the prototype data actually shows are bundled; inlining
 * all 950 from `public/vendor/brand-icons` would add megabytes to the file.
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
const EMPTY_DATA_URI =
  'data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2016%2016%22%2F%3E';

function mapBrandSrc(value: unknown): string {
  const text = String(value ?? '');
  const match = BRAND_SRC.exec(text);
  if (!match) return text;
  const raw = ICONS[match[1].toLowerCase()];
  return raw ? dataUri(raw) : EMPTY_DATA_URI;
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
