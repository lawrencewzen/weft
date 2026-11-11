import { useSyncExternalStore } from 'react';
import type { components } from '../../../src/v2/contract.gen';

export type ReportRequest = components['schemas']['DiagnosticsReportRequest'];

export const REPORT_PATH = '/api/v2/diagnostics/report';

export type ReportDialogOpen = {
  /** Present when opened from a conversation; unlocks the "attach conversation" option. */
  conversationId?: string;
};

let current: ReportDialogOpen | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function openReportDialog(opts: ReportDialogOpen = {}): void {
  current = { conversationId: opts.conversationId || undefined };
  emit();
}

export function closeReportDialog(): void {
  current = null;
  emit();
}

export function useReportDialog(): ReportDialogOpen | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    () => current,
    () => null,
  );
}

/**
 * The file list is derived on the client from the same parameters the server
 * receives (no preview endpoint), so it always follows the checkboxes.
 */
export function reportFileList(req: Omit<ReportRequest, 'description'>): string[] {
  const files = ['report.txt', 'system.txt'];
  if (req.includeDoctor) files.push('doctor.txt');
  if (req.includeLogs) files.push('logs/service.log…', 'logs/service-stdio.log');
  files.push('settings.json');
  if (req.conversationId) files.push(`conversation-${req.conversationId}.json`);
  return files;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function reportFileName(now: Date = new Date()): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `weft-report-${d}-${t}.zip`;
}
