/**
 * Maps a provider ID to a known brand identifier used by /vendor/brand-icons/<id>.svg.
 * The brand ids are also the source of the build-time icon manifest (brandIconManifest.ts).
 */
const PROVIDER_BRAND_RULES: ReadonlyArray<readonly [(id: string) => boolean, string]> = [
  [(id) => id.startsWith('qwen-token-plan'), 'qwen'],
  [(id) => id === 'zai' || id === 'zai-coding-cn', 'zhipu'],
  [(id) => id === 'kimi-coding', 'kimi'],
  [(id) => id.startsWith('moonshotai'), 'moonshot'],
  [(id) => id.startsWith('minimax'), 'minimax'],
  [(id) => id.startsWith('xiaomi'), 'xiaomi'],
  [(id) => id === 'amazon-bedrock', 'aws'],
  [(id) => id === 'azure', 'azure'],
  [(id) => id === 'google-vertex', 'googlecloud'],
  [(id) => id === 'ant-ling', 'antgroup'],
  [(id) => id === 'baseten', 'baseten'],
  [(id) => id === 'cerebras', 'cerebras'],
  [(id) => id.startsWith('cloudflare'), 'cloudflare'],
  [(id) => id === 'fireworks', 'fireworks'],
  [(id) => id === 'github-copilot', 'githubcopilot'],
  [(id) => id === 'groq', 'groq'],
  [(id) => id === 'huggingface', 'huggingface'],
  [(id) => id === 'meta', 'meta'],
  [(id) => id === 'mistral', 'mistral'],
  [(id) => id === 'nvidia', 'nvidia'],
  [(id) => id.startsWith('opencode'), 'opencode'],
  [(id) => id === 'together', 'together'],
  [(id) => id.startsWith('vercel'), 'vercel'],
  [(id) => id === 'deepseek', 'deepseek'],
  [(id) => id === 'anthropic', 'anthropic'],
  [(id) => id === 'openai', 'openai'],
  [(id) => id === 'google', 'google'],
  [(id) => id === 'openrouter', 'openrouter'],
  [(id) => id === 'xai', 'xai'],
];

/** Every brand id providerBrand() can return. */
export const PROVIDER_BRAND_IDS: readonly string[] = [...new Set(PROVIDER_BRAND_RULES.map(([, brand]) => brand))];

export function providerBrand(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  const id = providerId.trim().toLowerCase();
  if (!id) return null;
  for (const [match, brand] of PROVIDER_BRAND_RULES) {
    if (match(id)) return brand;
  }
  return null;
}
