/**
 * Maps a provider ID to a known brand identifier used by /vendor/brand-icons/<id>.svg.
 */
export function providerBrand(providerId: string | null | undefined): string | null {
  if (!providerId) return null;
  const id = providerId.trim().toLowerCase();
  if (!id) return null;

  if (id.startsWith('qwen-token-plan')) return 'qwen';
  if (id === 'zai' || id === 'zai-coding-cn') return 'zhipu';
  if (id === 'kimi-coding') return 'kimi';
  if (id.startsWith('moonshotai')) return 'moonshot';
  if (id.startsWith('minimax')) return 'minimax';
  if (id.startsWith('xiaomi')) return 'xiaomi';
  if (id === 'amazon-bedrock') return 'aws';
  if (id === 'azure') return 'azure';
  if (id === 'google-vertex') return 'googlecloud';
  if (id === 'ant-ling') return 'antgroup';
  if (id === 'baseten') return 'baseten';
  if (id === 'cerebras') return 'cerebras';
  if (id.startsWith('cloudflare')) return 'cloudflare';
  if (id === 'fireworks') return 'fireworks';
  if (id === 'github-copilot') return 'githubcopilot';
  if (id === 'groq') return 'groq';
  if (id === 'huggingface') return 'huggingface';
  if (id === 'meta') return 'meta';
  if (id === 'mistral') return 'mistral';
  if (id === 'nvidia') return 'nvidia';
  if (id.startsWith('opencode')) return 'opencode';
  if (id === 'together') return 'together';
  if (id.startsWith('vercel')) return 'vercel';
  if (id === 'deepseek') return 'deepseek';
  if (id === 'anthropic') return 'anthropic';
  if (id === 'openai') return 'openai';
  if (id === 'google') return 'google';
  if (id === 'openrouter') return 'openrouter';
  if (id === 'xai') return 'xai';
  if (id === 'antigravity-acp' || id === 'antigravity') return 'antigravity';

  return null;
}
