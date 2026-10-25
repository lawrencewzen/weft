import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSendRequest } from './sendRequest';
import { continueRun, sendMessage } from '../data/api';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createSendRequest', () => {
  it('reuses the same requestId on retry until success', () => {
    const generate = vi.fn()
      .mockReturnValueOnce('id-1')
      .mockReturnValueOnce('id-2');
    const req = createSendRequest(generate);
    expect(req.begin('hello')).toBe('id-1');
    expect(req.begin('hello')).toBe('id-1');
    expect(generate).toHaveBeenCalledTimes(1);
    req.succeed();
    expect(req.current()).toBeNull();
    expect(req.begin('hello')).toBe('id-2');
  });
});

describe('send retry uses the same requestId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the held requestId on sendMessage and continueRun retries', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(202, { runId: 'run-1' }))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse(202, { runId: 'run-2' }));
    vi.stubGlobal('fetch', fetchMock);

    const send = createSendRequest(() => 'send-id');
    const sendId = send.begin('hello');
    await expect(sendMessage('c1', 'hello', sendId)).rejects.toThrow('network down');
    await expect(sendMessage('c1', 'hello', send.begin('hello'))).resolves.toEqual({ runId: 'run-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).requestId).toBe('send-id');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).requestId).toBe('send-id');

    const cont = createSendRequest(() => 'cont-id');
    const contId = cont.begin('continue');
    await expect(continueRun('c1', contId)).rejects.toThrow('network down');
    await expect(continueRun('c1', cont.begin('continue'))).resolves.toEqual({ runId: 'run-2' });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).requestId).toBe('cont-id');
    expect(JSON.parse(String(fetchMock.mock.calls[3][1].body)).requestId).toBe('cont-id');
  });
});
