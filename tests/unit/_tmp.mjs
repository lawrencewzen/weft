import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ROOT } from './_root.mjs';

/**
 * macOS resolves os.tmpdir() to /private/var/..., and workspace-guard refuses
 * every system prefix (/var among them), so a workspace root made there is
 * rejected. Use the git-ignored data/test-tmp inside the repo instead.
 */
async function tmpBase() {
  const system = await realpath(tmpdir());
  if (!/^\/(private\/)?var\//.test(system)) return system;
  const local = path.join(ROOT, 'data', 'test-tmp');
  await mkdir(local, { recursive: true });
  return local;
}

/** A temporary directory the workspace guard accepts. Remove it with `removeTempDir`. */
export async function makeTempDir(prefix = 'weft-unit-') {
  return realpath(await mkdtemp(path.join(await tmpBase(), prefix)));
}

export async function removeTempDir(dir) {
  if (dir) await rm(dir, { recursive: true, force: true });
}
