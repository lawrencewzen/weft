import { readFileSync } from 'node:fs';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { PROTOCOL_VERSION } from './version.ts';

type JsonSchema = Record<string, unknown>;

type OpenApiSpec = {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema> };
};

type Operation = {
  responses?: Record<string, {
    content?: Record<string, { schema?: unknown }>;
  }>;
};

const spec = JSON.parse(
  readFileSync(new URL('../../contract/openapi.json', import.meta.url), 'utf8'),
) as OpenApiSpec;

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction>();

export type ValidateResult = {
  ok: boolean;
  errors?: ErrorObject[] | { message: string }[];
};

function lookup(ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current: unknown = spec;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveSchema(node: unknown, seen = new Set<string>()): JsonSchema | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const rec = node as Record<string, unknown>;
  if (typeof rec.$ref === 'string') {
    if (seen.has(rec.$ref)) return undefined;
    seen.add(rec.$ref);
    return resolveSchema(lookup(rec.$ref), seen);
  }
  return rec as JsonSchema;
}

function responseSchema(requestPath: string, method: string, status: number): JsonSchema | undefined {
  const op = spec.paths?.[requestPath]?.[method.toLowerCase()];
  const responses = op?.responses;
  if (responses) {
    const ranged = status >= 500 ? '5XX' : status >= 400 ? '4XX' : undefined;
    const chosen = responses[String(status)] || (ranged ? responses[ranged] : undefined) || responses.default;
    const schema = resolveSchema(chosen?.content?.['application/json']?.schema);
    if (schema) return schema;
  }
  if (status >= 400) return resolveSchema(spec.components?.schemas?.V2Error);
  return undefined;
}

export function validateResponse(
  requestPath: string,
  method: string,
  status: number,
  body: unknown,
): ValidateResult {
  const key = `${method.toUpperCase()} ${requestPath} ${status}`;
  let validator = cache.get(key);
  if (!validator) {
    const schema = responseSchema(requestPath, method, status);
    if (!schema) {
      return { ok: false, errors: [{ message: `no schema for ${key}` }] };
    }
    const compiled = ajv.compile(structuredClone(schema));
    cache.set(key, compiled);
    validator = compiled;
  }
  const ok = validator(body);
  if (ok) return { ok: true };
  return { ok: false, errors: validator.errors || [{ message: 'invalid' }] };
}

export function contractMismatchLog(
  requestPath: string,
  method: string,
  status: number,
  errors: ValidateResult['errors'],
): string {
  return `WEFT_V2_CONTRACT_MISMATCH ${PROTOCOL_VERSION} ${method.toUpperCase()} ${requestPath} ${status} ${JSON.stringify(errors)}`;
}
