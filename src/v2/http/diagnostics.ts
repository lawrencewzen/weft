/** POST /api/v2/diagnostics/report — problem report zip (built in memory, never uploaded). */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { SECURITY_HEADERS } from '../../core/auth.mjs';
import { buildReport } from '../../core/diagnostics-report.mjs';
import { log } from '../../core/log.mjs';
import type { components } from '../contract.gen.ts';
import { PROTOCOL_VERSION } from '../version.ts';
import type { ReadObjectBodyFn, SendV2Fn } from './extensions.ts';

type V2Error = components['schemas']['V2Error'];

export type DiagnosticsHost = {
  version: string;
  commit?: string;
  dataDir?: string;
  startedAt: number;
  getSettings?: () => Promise<unknown>;
  /** Presented conversation with messages, or null when it does not exist. */
  loadConversation?: (id: string) => Promise<{ presented?: unknown } | null>;
};

export async function handleDiagnosticsApi(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  pathname: string;
  method: string;
  sendV2: SendV2Fn;
  readObjectBody: ReadObjectBodyFn;
  host: DiagnosticsHost;
}): Promise<boolean> {
  const { req, res, pathname, method, sendV2, readObjectBody, host } = opts;
  if (pathname !== '/api/v2/diagnostics/report') return false;
  if (method !== 'POST') {
    sendV2(res, pathname, method, 405, { error: 'method not allowed', code: 'E_BAD_REQUEST' } satisfies V2Error);
    return true;
  }
  const body = await readObjectBody(req, res, pathname, method);
  if (!body) return true;
  const { description, includeLogs, includeDoctor, conversationId } = body;
  const bad = typeof description !== 'string'
    || description.length > 20000
    || typeof includeLogs !== 'boolean'
    || typeof includeDoctor !== 'boolean'
    || (conversationId != null && (typeof conversationId !== 'string' || !conversationId.trim()));
  if (bad) {
    sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' } satisfies V2Error);
    return true;
  }
  try {
    let conversation: unknown;
    const cid = typeof conversationId === 'string' ? conversationId.trim() : '';
    if (cid) {
      const loaded = host.loadConversation ? await host.loadConversation(cid) : null;
      if (!loaded) {
        sendV2(res, pathname, method, 404, { error: 'not found', code: 'E_NOT_FOUND' } satisfies V2Error);
        return true;
      }
      conversation = loaded.presented;
    }
    const settings = host.getSettings ? await host.getSettings() : {};
    const report = await buildReport(
      {
        description,
        includeLogs,
        includeDoctor,
        conversation: conversation as object | undefined,
        conversationId: cid || undefined,
      },
      {
        version: host.version,
        commit: host.commit,
        dataDir: host.dataDir,
        startedAt: host.startedAt,
        level: log.level,
        settings,
      },
    );
    log.info('WEFT_REPORT', 'report exported', {
      logs: includeLogs,
      doctor: includeDoctor,
      conversation: Boolean(cid),
      bytes: report.buffer.length,
    });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${report.name}"`,
      'content-length': String(report.buffer.length),
      'cache-control': 'no-store',
      'Weft-Protocol': PROTOCOL_VERSION,
    });
    res.end(report.buffer);
  } catch (err) {
    const tooLarge = (err as { code?: string })?.code === 'E_TOO_LARGE';
    if (!tooLarge) log.error('WEFT_REPORT', 'report failed', err);
    sendV2(res, pathname, method, tooLarge ? 413 : 500, {
      error: tooLarge ? 'report too large' : (err instanceof Error ? err.message : 'report failed'),
      code: tooLarge ? 'E_TOO_LARGE' : 'E_INTERNAL',
    } satisfies V2Error);
  }
  return true;
}
