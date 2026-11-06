import type { Model } from './types';

const BRAND_KEYWORDS: readonly [string, string][] = [
  ['deepseek', 'deepseek'],
  ['qwen', 'qwen'],
  ['kimi', 'kimi'],
  ['minimax', 'minimax'],
  ['doubao', 'doubao'],
  ['hunyuan', 'hunyuan'],
  ['ernie', 'ernie'],
  ['baichuan', 'baichuan'],
];

/**
 * Infer brand from model name or id:
 * - case-insensitive 'glm' -> 'chatglm'
 * - otherwise contains deepseek/qwen/kimi/minimax/doubao/hunyuan/ernie/baichuan -> corresponding brand
 * - otherwise null
 */
export function inferModelBrand(modelNameOrId: string | null | undefined): string | null {
  if (!modelNameOrId) return null;
  const lower = modelNameOrId.toLowerCase();
  if (lower.includes('glm')) return 'chatglm';
  for (const [kw, brand] of BRAND_KEYWORDS) {
    if (lower.includes(kw)) return brand;
  }
  return null;
}

/**
 * Infer custom provider brand from all its models:
 * If all models have the same non-empty brand, return that brand; otherwise null.
 */
export function inferCustomProviderBrand(
  models: readonly (Pick<Model, 'brand'> | { brand?: string | null })[],
): string | null {
  if (!models || models.length === 0) return null;
  const first = models[0]?.brand;
  if (!first) return null;
  for (let i = 1; i < models.length; i += 1) {
    if (models[i]?.brand !== first) return null;
  }
  return first;
}
