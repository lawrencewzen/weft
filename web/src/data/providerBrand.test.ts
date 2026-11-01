import { describe, expect, it } from 'vitest';
import { providerBrand } from './providerBrand';

describe('providerBrand', () => {
  it('maps known provider IDs correctly', () => {
    expect(providerBrand('qwen-token-plan-cn')).toBe('qwen');
    expect(providerBrand('qwen-token-plan')).toBe('qwen');
    expect(providerBrand('zai')).toBe('zhipu');
    expect(providerBrand('zai-coding-cn')).toBe('zhipu');
    expect(providerBrand('moonshotai-cn')).toBe('moonshot');
    expect(providerBrand('kimi-coding')).toBe('kimi');
    expect(providerBrand('minimax-cn')).toBe('minimax');
    expect(providerBrand('minimax')).toBe('minimax');
    expect(providerBrand('xiaomi')).toBe('xiaomi');
    expect(providerBrand('xiaomi-token-plan-cn')).toBe('xiaomi');
    expect(providerBrand('amazon-bedrock')).toBe('aws');
    expect(providerBrand('azure')).toBe('azure');
    expect(providerBrand('google-vertex')).toBe('googlecloud');
    expect(providerBrand('ant-ling')).toBe('antgroup');
    expect(providerBrand('baseten')).toBe('baseten');
    expect(providerBrand('cerebras')).toBe('cerebras');
    expect(providerBrand('cloudflare-ai-gateway')).toBe('cloudflare');
    expect(providerBrand('fireworks')).toBe('fireworks');
    expect(providerBrand('github-copilot')).toBe('githubcopilot');
    expect(providerBrand('groq')).toBe('groq');
    expect(providerBrand('huggingface')).toBe('huggingface');
    expect(providerBrand('meta')).toBe('meta');
    expect(providerBrand('mistral')).toBe('mistral');
    expect(providerBrand('nvidia')).toBe('nvidia');
    expect(providerBrand('opencode')).toBe('opencode');
    expect(providerBrand('together')).toBe('together');
    expect(providerBrand('vercel-ai-gateway')).toBe('vercel');
    expect(providerBrand('deepseek')).toBe('deepseek');
    expect(providerBrand('anthropic')).toBe('anthropic');
    expect(providerBrand('openai')).toBe('openai');
    expect(providerBrand('google')).toBe('google');
    expect(providerBrand('openrouter')).toBe('openrouter');
    expect(providerBrand('xai')).toBe('xai');
  });

  it('handles empty or unrecognized provider ids gracefully', () => {
    expect(providerBrand('')).toBeNull();
    expect(providerBrand(null)).toBeNull();
    expect(providerBrand(undefined)).toBeNull();
    expect(providerBrand('custom-gateway')).toBeNull();
    expect(providerBrand('unknown-provider')).toBeNull();
  });
});
