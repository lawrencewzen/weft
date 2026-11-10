/** v2 routes for scheduled tasks. The rules and the work live in the kernel's schedule service. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { components } from '../contract.gen.ts';
import { normalizeLang } from '../stream/hub.ts';

type V2Error = components['schemas']['V2Error'];
type Schedule = components['schemas']['Schedule'];
type ScheduleRun = components['schemas']['ScheduleRun'];
type ScheduleInvalid = components['schemas']['ScheduleInvalid'];

type Reply<T> = { status: number; body: T | V2Error | ScheduleInvalid };

/** What the kernel's schedule service offers the routes. */
export type SchedulesHost = {
  list(): Promise<Schedule[]>;
  create(body: Record<string, unknown>, opts: { lang: 'zh' | 'en' }): Promise<Reply<Schedule>>;
  update(id: string, body: Record<string, unknown>, opts: { lang: 'zh' | 'en' }): Promise<Reply<Schedule>>;
  remove(id: string, opts: { requestId?: string; lang: 'zh' | 'en' }): Promise<Reply<{ ok: true; id: string }>>;
  runNow(id: string, body: Record<string, unknown>, opts: { lang: 'zh' | 'en' }): Promise<Reply<ScheduleRun>>;
  runs(id: string, opts: { lang: 'zh' | 'en' }): Promise<Reply<{ runs: ScheduleRun[] }>>;
};

/** The kernel opens after the HTTP server is built, so the host is looked up per call. */
export function lazySchedulesHost(get: () => SchedulesHost | undefined): SchedulesHost {
  const notReady = { status: 500, body: { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error };
  return {
    list: async () => get()?.list() ?? [],
    create: async (body, o) => get()?.create(body, o) ?? notReady,
    update: async (id, body, o) => get()?.update(id, body, o) ?? notReady,
    remove: async (id, o) => get()?.remove(id, o) ?? notReady,
    runNow: async (id, body, o) => get()?.runNow(id, body, o) ?? notReady,
    runs: async (id, o) => get()?.runs(id, o) ?? notReady,
  };
}

type SendV2Fn = (res: ServerResponse, requestPath: string, method: string, status: number, body: object) => void;
type ReadObjectBodyFn = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
) => Promise<Record<string, unknown> | null>;

const ID_PATH = /^\/api\/v2\/schedules\/([^/]+)(\/run|\/runs)?$/;

export async function handleSchedulesApi(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  pathname: string;
  method: string;
  sendV2: SendV2Fn;
  readObjectBody: ReadObjectBodyFn;
  host?: SchedulesHost;
  onChanged?: () => void;
}): Promise<boolean> {
  const { req, res, url, pathname, method, sendV2, readObjectBody, host } = opts;
  if (pathname !== '/api/v2/schedules' && !pathname.startsWith('/api/v2/schedules/')) return false;
  if (!host) {
    sendV2(res, pathname, method, 500, { error: 'kernel not ready', code: 'E_INTERNAL' } satisfies V2Error);
    return true;
  }
  const lang = normalizeLang(url.searchParams.get('lang')) === 'en' ? 'en' : 'zh';
  const send = (reply: Reply<unknown>) => {
    sendV2(res, pathname, method, reply.status, reply.body as object);
    if (reply.status < 400 && method !== 'GET') opts.onChanged?.();
  };
  try {
    if (pathname === '/api/v2/schedules') {
      if (method === 'GET') {
        sendV2(res, pathname, method, 200, { schedules: await host.list() });
        return true;
      }
      if (method === 'POST') {
        const body = await readObjectBody(req, res, pathname, method);
        if (!body) return true;
        send(await host.create(body, { lang }));
        return true;
      }
      sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
      return true;
    }
    const match = ID_PATH.exec(pathname);
    if (!match) {
      sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
      return true;
    }
    const id = decodeURIComponent(match[1]);
    const tail = match[2] || '';
    if (tail === '/runs' && method === 'GET') {
      send(await host.runs(id, { lang }));
      return true;
    }
    if (tail === '/run' && method === 'POST') {
      let body: Record<string, unknown> = {};
      const raw = await readOptionalBody(req);
      if (raw === 'invalid') {
        sendV2(res, pathname, method, 400, { error: 'invalid body', code: 'E_BAD_REQUEST' } satisfies V2Error);
        return true;
      }
      body = raw;
      send(await host.runNow(id, body, { lang }));
      return true;
    }
    if (tail === '' && method === 'PATCH') {
      const body = await readObjectBody(req, res, pathname, method);
      if (!body) return true;
      send(await host.update(id, body, { lang }));
      return true;
    }
    if (tail === '' && method === 'DELETE') {
      const given = url.searchParams.get('requestId');
      send(await host.remove(id, { requestId: given ? given.trim() || undefined : undefined, lang }));
      return true;
    }
    sendV2(res, pathname, method, 404, { error: 'not found' } satisfies V2Error);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'schedule request failed';
    sendV2(res, pathname, method, 500, { error: message, code: 'E_INTERNAL' } satisfies V2Error);
  }
  return true;
}

/** `POST /run` may have no body at all. */
async function readOptionalBody(req: IncomingMessage): Promise<Record<string, unknown> | 'invalid'> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 100_000) return 'invalid';
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return 'invalid';
}
