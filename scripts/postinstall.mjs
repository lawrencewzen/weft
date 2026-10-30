import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_BUILT_HINT } from '../src/v2/auth.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

export { NOT_BUILT_HINT };

export function isMissingVite(err) {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? String(err.code || '') : '';
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    return /vite/i.test(message);
  }
  return /cannot find (package |module )?['"]vite['"]/i.test(message)
    || /vite['"]? (is not recognized|not found|ENOENT)/i.test(message);
}

export function defaultViteCli() {
  const pkg = require.resolve('vite/package.json');
  return path.join(path.dirname(pkg), 'bin', 'vite.js');
}

export function tryBuildWeb({
  resolveVite = defaultViteCli,
  spawn = spawnSync,
  cwd = ROOT,
  write = (text) => process.stdout.write(text),
} = {}) {
  let cli;
  try {
    cli = resolveVite();
  } catch (err) {
    if (isMissingVite(err)) {
      write(`${NOT_BUILT_HINT}\n`);
      return 0;
    }
    throw err;
  }
  const result = spawn(process.execPath, [cli, 'build', '--config', 'web/vite.config.ts'], {
    cwd,
    stdio: 'inherit',
  });
  if (result.error && (result.error.code === 'ENOENT' || isMissingVite(result.error))) {
    write(`${NOT_BUILT_HINT}\n`);
    return 0;
  }
  const status = result.status;
  if (status === 0) return 0;
  return status == null ? 1 : status;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

function main() {
  process.exit(tryBuildWeb());
}

if (isMain()) main();
