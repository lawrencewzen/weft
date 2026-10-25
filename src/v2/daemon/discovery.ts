import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { components } from '../contract.gen.ts';

export const DISCOVERY_FILENAME = 'service.json';

export type ServiceDiscovery = components['schemas']['ServiceDiscovery'];

export function discoveryPath(dataDir: string): string {
  return path.join(dataDir, DISCOVERY_FILENAME);
}

function discoveryTmpPath(dataDir: string, pid: number): string {
  return `${discoveryPath(dataDir)}.${pid}.tmp`;
}

export function writeDiscoverySync(dataDir: string, info: ServiceDiscovery): void {
  mkdirSync(dataDir, { recursive: true });
  const dest = discoveryPath(dataDir);
  const tmp = discoveryTmpPath(dataDir, info.pid);
  const body = JSON.stringify({
    protocolVersion: info.protocolVersion,
    serviceVersion: info.serviceVersion,
    pid: info.pid,
    port: info.port,
    startedAt: info.startedAt,
    token: info.token,
  }, null, 2) + '\n';
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows cannot chmod 0600 */ }
  renameSync(tmp, dest);
  try { chmodSync(dest, 0o600); } catch { /* Windows cannot chmod 0600 */ }
}

function pidFromDiscoveryFile(file: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown };
    return Number.isInteger(parsed.pid) ? parsed.pid as number : null;
  } catch {
    return null;
  }
}

/** Delete `<dataDir>/service.json` only when it belongs to `pid`. */
export function removeDiscoverySync(dataDir: string, pid: number = process.pid): void {
  const dest = discoveryPath(dataDir);
  const filePid = pidFromDiscoveryFile(dest);
  if (filePid !== pid) return;
  try { unlinkSync(dest); } catch { /* already gone */ }
}
