import { describe, expect, it } from 'vitest';
import { inferCustomProviderBrand, inferModelBrand } from './brand';

describe('inferModelBrand', () => {
  it('maps any case-insensitive glm to chatglm', () => {
    expect(inferModelBrand('GLM4.7')).toBe('chatglm');
    expect(inferModelBrand('glm5')).toBe('chatglm');
    expect(inferModelBrand('zai-glm-4.6')).toBe('chatglm');
    expect(inferModelBrand('ChatGLM-6B')).toBe('chatglm');
    expect(inferModelBrand('glm-5.2-fp8')).toBe('chatglm');
  });

  it('maps known brands when glm is not present', () => {
    expect(inferModelBrand('DeepSeek-V3.2')).toBe('deepseek');
    expect(inferModelBrand('deepseek-chat')).toBe('deepseek');
    expect(inferModelBrand('qwen3-coder-480b')).toBe('qwen');
    expect(inferModelBrand('kimi-k1.5')).toBe('kimi');
    expect(inferModelBrand('minimax-01')).toBe('minimax');
    expect(inferModelBrand('doubao-pro-128k')).toBe('doubao');
    expect(inferModelBrand('hunyuan-standard')).toBe('hunyuan');
    expect(inferModelBrand('ernie-4.0')).toBe('ernie');
    expect(inferModelBrand('baichuan2-turbo')).toBe('baichuan');
  });

  it('returns null for unknown model names or empty inputs', () => {
    expect(inferModelBrand('my-internal-model')).toBeNull();
    expect(inferModelBrand('llama3.3:70b')).toBeNull();
    expect(inferModelBrand('nomic-embed-text')).toBeNull();
    expect(inferModelBrand('')).toBeNull();
    expect(inferModelBrand(null)).toBeNull();
    expect(inferModelBrand(undefined)).toBeNull();
  });
});

describe('inferCustomProviderBrand', () => {
  it('returns the brand when all models share the same non-empty brand', () => {
    expect(
      inferCustomProviderBrand([
        { brand: 'deepseek' },
        { brand: 'deepseek' },
      ]),
    ).toBe('deepseek');

    expect(
      inferCustomProviderBrand([
        { brand: 'chatglm' },
        { brand: 'chatglm' },
        { brand: 'chatglm' },
      ]),
    ).toBe('chatglm');
  });

  it('returns null when brands are mixed', () => {
    expect(
      inferCustomProviderBrand([
        { brand: 'qwen' },
        { brand: 'chatglm' },
        { brand: null },
      ]),
    ).toBeNull();

    expect(
      inferCustomProviderBrand([
        { brand: 'deepseek' },
        { brand: 'chatglm' },
      ]),
    ).toBeNull();
  });

  it('returns null when all models have null brand or array is empty', () => {
    expect(
      inferCustomProviderBrand([
        { brand: null },
        { brand: null },
      ]),
    ).toBeNull();
    expect(inferCustomProviderBrand([])).toBeNull();
  });
});
