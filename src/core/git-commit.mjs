import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Short commit of the checkout at `root`. Reads .git directly (no git process); release packages have none: undefined. */
export function readGitCommit(root) {
  try {
    let gitDir = path.join(root, '.git');
    if (!existsSync(gitDir)) return undefined;
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!m) return undefined;
      gitDir = path.resolve(root, m[1].trim());
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7) || undefined;
    const ref = head.slice(5).trim();
    const dirs = [gitDir];
    try { dirs.push(path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim())); } catch { /* none */ }
    for (const dir of dirs) {
      try {
        const sha = readFileSync(path.join(dir, ref), 'utf8').trim();
        if (sha) return sha.slice(0, 7);
      } catch { /* try packed-refs */ }
      try {
        const line = readFileSync(path.join(dir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
        if (line) return line.slice(0, 7);
      } catch { /* none */ }
    }
  } catch { /* no commit info */ }
  return undefined;
}
