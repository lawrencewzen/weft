import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HAN = /[\u4e00-\u9fff]/;
const srcRoot = path.dirname(fileURLToPath(import.meta.url));

/** Files that may contain Chinese: catalogs, tests, and comments (stripped below). */
const SKIP_FILE = /\.test\.(ts|tsx)$/;
const SKIP_NAMES = new Set(['i18n.ts']);

/**
 * Extra source lines allowed to keep CJK (regexes, model prompts, etc.).
 * Keep this list explicit — new UI copy must go through i18n.
 */
const LINE_ALLOWLIST = new Set<string>([
  // none yet: web/src UI copy should all go through i18n.ts
]);

function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const nxt = i + 1 < n ? src[i + 1] : '';
    if (ch === '/' && nxt === '/') {
      const j = src.indexOf('\n', i);
      if (j < 0) {
        out += ' '.repeat(n - i);
        break;
      }
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (ch === '/' && nxt === '*') {
      const j = src.indexOf('*/', i + 2);
      if (j < 0) {
        out += ' '.repeat(n - i);
        break;
      }
      const chunk = src.slice(i, j + 2);
      out += chunk.replace(/[^\n]/g, ' ');
      i = j + 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const STRING_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
const JSX_TEXT_RE = />([^<>{]+)</g;

function lineOf(src: string, idx: number): number {
  return src.slice(0, idx).split('\n').length;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    if (SKIP_FILE.test(name) || SKIP_NAMES.has(name)) continue;
    out.push(full);
  }
  return out;
}

describe('web/src has no hardcoded Chinese UI literals', () => {
  it('english catalog in i18n.ts contains no CJK', () => {
    const src = fs.readFileSync(path.join(srcRoot, 'i18n.ts'), 'utf8');
    const start = src.indexOf('\nconst en:');
    const end = src.indexOf('\nconst DICT:');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    const hits = [...block.matchAll(/[\u4e00-\u9fff]+/g)].map((m) => m[0]);
    expect(hits, hits.join(', ')).toEqual([]);
  });

  it('non-test source files have no CJK string literals or JSX text', () => {
    const files = walk(srcRoot);
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of files) {
      const raw = fs.readFileSync(file, 'utf8');
      const src = stripComments(raw);
      const rel = path.relative(srcRoot, file).split(path.sep).join('/');
      for (const m of src.matchAll(STRING_RE)) {
        if (!HAN.test(m[0])) continue;
        const line = lineOf(src, m.index ?? 0);
        const key = `${rel}:${line}`;
        if (LINE_ALLOWLIST.has(key)) continue;
        hits.push(`${key} ${m[0].slice(0, 80)}`);
      }
      for (const m of src.matchAll(JSX_TEXT_RE)) {
        const text = m[1].trim();
        if (!text || !HAN.test(text)) continue;
        const line = lineOf(src, m.index ?? 0);
        const key = `${rel}:${line}`;
        if (LINE_ALLOWLIST.has(key)) continue;
        hits.push(`${key} JSX ${text.slice(0, 80)}`);
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });
});
