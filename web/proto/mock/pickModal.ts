import type { Lang } from './types';
import type { MockReply } from './http';

export function isBlockedPath(p: string): boolean {
  const norm = p.replaceAll('/', '\\').toLowerCase();
  return (
    norm.includes('\\.ssh')
    || norm === '~\\.ssh'
    || norm.endsWith('\\.ssh')
    || norm === '.ssh'
    || norm === '~/.ssh'
  );
}

const PICK_DELAY_MS = 600;
const PICK_PATHS = [
  'C:\\Users\\demo\\Projects\\billing-api',
  'C:\\Users\\demo\\Projects\\docs-site',
];

let pickCalls = 0;

/**
 * Simulates the server-side system folder picker behind the dialog's Browse button.
 * Replies after ~600ms. Odd calls (1st, 3rd, ...) pick the next path from PICK_PATHS;
 * even calls (2nd, 4th, ...) are cancelled, so both outcomes can be tried by clicking twice.
 * With `?pick=unsupported` it replies `unsupported` at once.
 */
export function mockPickWorkspaceFolder(_lang: Lang): Promise<MockReply> {
  // `?pick=unsupported` 模拟远程访问：系统选文件夹不可用，对话框退回页内目录浏览。
  const search = typeof window !== 'undefined' ? window.location.search : '';
  if (new URLSearchParams(search).get('pick') === 'unsupported') {
    return Promise.resolve({ status: 200, body: { status: 'unsupported' }, headers: {} });
  }
  pickCalls += 1;
  const call = pickCalls;
  return new Promise<MockReply>((resolve) => {
    setTimeout(() => {
      if (call % 2 === 0) {
        resolve({ status: 200, body: { status: 'cancelled' }, headers: {} });
        return;
      }
      const path = PICK_PATHS[((call - 1) / 2) % PICK_PATHS.length];
      resolve({ status: 200, body: { status: 'picked', path }, headers: {} });
    }, PICK_DELAY_MS);
  });
}
