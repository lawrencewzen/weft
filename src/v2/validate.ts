import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
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

const ajv = new Ajv2020({ allErrors: true, strict: true });

/** OpenAPI 标注关键字：只允许出现，不参与校验。 */
const OPENAPI_ANNOTATION_KEYWORDS = ['example', 'discriminator', 'xml', 'externalDocs', 'deprecated'] as const;
for (const keyword of OPENAPI_ANNOTATION_KEYWORDS) {
  if (ajv.getKeyword(keyword)) continue;
  try {
    ajv.addKeyword(keyword);
  } catch (err) {
    if (err instanceof Error && /already defined/i.test(err.message)) continue;
    throw err;
  }
}

for (const [name, schema] of Object.entries(spec.components?.schemas || {})) {
  ajv.addSchema(structuredClone(schema), `#/components/schemas/${name}`);
}

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

/** `{id}` matches one path segment that does not contain `/`. */
export function pathTemplateMatches(template: string, requestPath: string): boolean {
  const tParts = template.split('/');
  const pParts = requestPath.split('/');
  if (tParts.length !== pParts.length) return false;
  for (let i = 0; i < tParts.length; i += 1) {
    const t = tParts[i];
    const p = pParts[i];
    if (t.startsWith('{') && t.endsWith('}') && t.length > 2) {
      if (!p) return false;
      continue;
    }
    if (t !== p) return false;
  }
  return true;
}

/** Exact path first, then OpenAPI path templates. */
export function matchContractPath(requestPath: string): string | undefined {
  if (spec.paths && Object.prototype.hasOwnProperty.call(spec.paths, requestPath)) return requestPath;
  for (const template of Object.keys(spec.paths || {})) {
    if (!template.includes('{')) continue;
    if (pathTemplateMatches(template, requestPath)) return template;
  }
  return undefined;
}

function responseSchema(requestPath: string, method: string, status: number): JsonSchema | undefined {
  const specPath = matchContractPath(requestPath) ?? requestPath;
  const op = spec.paths?.[specPath]?.[method.toLowerCase()];
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

export function compileSchema(schema: object): ValidateFunction {
  return ajv.compile(schema);
}

export function validateResponse(
  requestPath: string,
  method: string,
  status: number,
  body: unknown,
): ValidateResult {
  const specPath = matchContractPath(requestPath) ?? requestPath;
  if (status === 204) {
    const op = spec.paths?.[specPath]?.[method.toLowerCase()];
    const chosen = op?.responses?.['204'];
    if (chosen && (chosen.content == null || Object.keys(chosen.content).length === 0)) {
      if (body == null || body === '') return { ok: true };
      return { ok: false, errors: [{ message: '204 must not have a body' }] };
    }
  }
  const key = `${method.toUpperCase()} ${specPath} ${status}`;
  let validator = cache.get(key);
  if (!validator) {
    const schema = responseSchema(requestPath, method, status);
    if (!schema) {
      return { ok: false, errors: [{ message: `no schema for ${method.toUpperCase()} ${requestPath} ${status}` }] };
    }
    const compiled = compileSchema(structuredClone(schema));
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
