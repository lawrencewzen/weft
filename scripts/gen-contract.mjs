/**
 * Read contract/openapi.yaml, write contract/openapi.json (key order preserved)
 * and generate src/v2/contract.gen.ts via openapi-typescript.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yamlPath = path.join(ROOT, 'contract/openapi.yaml');
const jsonPath = path.join(ROOT, 'contract/openapi.json');
const tsPath = path.join(ROOT, 'src/v2/contract.gen.ts');

const doc = parse(readFileSync(yamlPath, 'utf8'));
if (!doc || typeof doc !== 'object') {
  throw new Error('contract/openapi.yaml did not parse to an object');
}

mkdirSync(path.dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`);

mkdirSync(path.dirname(tsPath), { recursive: true });
const ast = await openapiTS(pathToFileURL(jsonPath));
const generated = astToString(ast);
writeFileSync(tsPath, generated.endsWith('\n') ? generated : `${generated}\n`);

process.stdout.write(`wrote ${path.relative(ROOT, jsonPath)}\n`);
process.stdout.write(`wrote ${path.relative(ROOT, tsPath)}\n`);
