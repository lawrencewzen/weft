import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  continueRun,
  getSnapshot,
  isUnauthenticatedError,
  sendMessage,
  stop,
  toolOutput,
  UnauthenticatedError,
} from './api';

function jsonResponse(status: number, body: unknown, statusText = 'Error'): Response {
  return new Response(body == null ? '' : JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('turns 401 into an identifiable unauthenticated error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'unauthorized', code: 'E_UNAUTHORIZED' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getSnapshot('c1', 'zh')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(UnauthenticatedError);
      expect(isUnauthenticatedError(err)).toBe(true);
      expect((err as UnauthenticatedError).message).toBe('未登录');
      expect((err as UnauthenticatedError).status).toBe(401);
      return true;
    });
  });

  it('copies error and code from a JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(409, { error: 'no workspace', code: 'E_NO_WORKSPACE' }, 'Conflict'),
    ));
    await expect(sendMessage('c1', 'hi')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect(isUnauthenticatedError(err)).toBe(false);
      expect((err as ApiError).message).toBe('no workspace');
      expect((err as ApiError).code).toBe('E_NO_WORKSPACE');
      expect((err as ApiError).status).toBe(409);
      return true;
    });
  });

  it('falls back to raw text when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('boom', { status: 500, statusText: 'Server Error' }),
    ));
    await expect(stop('c1')).rejects.toMatchObject({ message: 'boom', status: 500 });
  });

  it('sends a generated requestId with the message', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { runId: 'run-1' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendMessage('cid/1', 'hello')).resolves.toEqual({ runId: 'run-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v2/conversations/cid%2F1/messages');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe(JSON.stringify({ text: 'hello', requestId: '00000000-0000-4000-8000-000000000001' }));
  });

  it('posts continue with a generated requestId and fetches tool output', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000002');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: 'run-2' }))
      .mockResolvedValueOnce(jsonResponse(202, { stopping: true }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 't1', text: 'out', totalLines: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, {
        conversation: { id: 'c1' },
        items: [],
        tools: [],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(continueRun('c1')).resolves.toEqual({ runId: 'run-2' });
    await expect(stop('c1')).resolves.toEqual({ stopping: true });
    await expect(toolOutput('c1', 't/1')).resolves.toEqual({ id: 't1', text: 'out', totalLines: 1 });
    await getSnapshot('c1', 'en');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/conversations/c1/continue');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ requestId: '00000000-0000-4000-8000-000000000002' }),
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v2/conversations/c1/stop');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v2/conversations/c1/tools/t%2F1/output');
    expect(fetchMock.mock.calls[3][0]).toBe('/api/v2/conversations/c1?lang=en');
  });
});
