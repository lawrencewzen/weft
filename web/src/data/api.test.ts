import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  ConflictError,
  continueRun,
  createConversation,
  createGitConnection,
  createProvider,
  createWorkspace,
  patchConversationModel,
  patchGitConnection,
  putModelContextWindow,
  getConversationDiff,
  patchProvider,
  getSnapshot,
  getWorkspaceFile,
  getWorkspaceTree,
  isConflictError,
  isUnauthenticatedError,
  refreshWorkspaceGit,
  removeWorkspace,
  saveWorkspaceFile,
  sendMessage,
  sendSubagentMessage,
  stop,
  stopSubagent,
  toolOutput,
  UnauthenticatedError,
  workspaceFileUrl,
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

  it('reuses an explicit requestId instead of generating one', async () => {
    const uuid = vi.spyOn(crypto, 'randomUUID');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, { runId: 'run-r' }))
      .mockResolvedValueOnce(jsonResponse(202, { runId: 'run-r' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendMessage('c1', 'hi', 'held-id')).resolves.toEqual({ runId: 'run-r' });
    await expect(continueRun('c1', 'held-cont')).resolves.toEqual({ runId: 'run-r' });
    expect(uuid).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).requestId).toBe('held-id');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).requestId).toBe('held-cont');
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

  it('includes images on sendMessage when provided', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000009');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { runId: 'run-img' }));
    vi.stubGlobal('fetch', fetchMock);
    const images = [{ mediaType: 'image/png' as const, data: 'AAAA', name: 'shot.png' }];
    await expect(sendMessage('c1', '', 'held-img', images)).resolves.toEqual({ runId: 'run-img' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      text: '',
      requestId: 'held-img',
      images,
    });
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

  it('posts subagent messages and stop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(202, { ok: true }))
      .mockResolvedValueOnce(jsonResponse(202, { stopping: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendSubagentMessage('c/1', 'c/1:sub:a', 'hello')).resolves.toEqual({ ok: true });
    await expect(stopSubagent('c/1', 'c/1:sub:a')).resolves.toEqual({ stopping: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/conversations/c%2F1/subagents/c%2F1%3Asub%3Aa/messages');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v2/conversations/c%2F1/subagents/c%2F1%3Asub%3Aa/stop');
  });

  it('creates a conversation and removes a workspace', async () => {
    const created = {
      id: 'c-new',
      workspaceId: 'w1',
      title: 'New conversation',
      updatedAt: 1,
      status: 'idle',
      runningAgents: 0,
      subagents: null,
      archived: false,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, created))
      .mockResolvedValueOnce(jsonResponse(200, { removed: true }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'busy', code: 'E_WS_BUSY', conversations: ['c1'] }, 'Conflict'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createConversation('w/1')).resolves.toEqual(created);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/workspaces/w%2F1/conversations');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({}),
    });

    await expect(removeWorkspace('w/1')).resolves.toEqual({ removed: true });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v2/workspaces/w%2F1');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    expect(new Headers(fetchMock.mock.calls[1][1].headers).get('content-type')).toMatch(/application\/json/);

    await expect(removeWorkspace('w1')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).code).toBe('E_WS_BUSY');
      return true;
    });
  });

  it('posts git refresh for a workspace', async () => {
    const gitWs = {
      id: 'w1', name: 'n', path: '/p', source: 'local' as const,
      gitUrl: null, branch: null, git: null, conversationCount: 0, runningCount: 0,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, gitWs));
    vi.stubGlobal('fetch', fetchMock);
    await expect(refreshWorkspaceGit('w/1')).resolves.toEqual(gitWs);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/workspaces/w%2F1/git/refresh');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('loads tree, file, and diff through v2 endpoints and encodes the path query', async () => {
    const file = {
      path: 'notes/today.md',
      size: 12,
      binary: false,
      tooLarge: false,
      text: 'hi',
      version: 'v1',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { entries: [{ path: 'notes', type: 'dir' }], truncated: false }))
      .mockResolvedValueOnce(jsonResponse(200, file))
      .mockResolvedValueOnce(jsonResponse(200, {
        path: 'notes/today.md', added: 1, removed: 0, hunks: [], tooLarge: false,
      }))
      .mockResolvedValueOnce(jsonResponse(200, { path: 'notes/today.md', version: 'v2', added: 1, removed: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWorkspaceTree('w/1')).resolves.toMatchObject({ truncated: false });
    await expect(getWorkspaceFile('w/1', 'notes/today.md')).resolves.toEqual(file);
    await expect(getConversationDiff('c/1', 'notes/today.md')).resolves.toMatchObject({ path: 'notes/today.md' });
    await expect(saveWorkspaceFile('w/1', { path: 'notes/today.md', text: 'hi', baseVersion: 'v1' }))
      .resolves.toMatchObject({ version: 'v2' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/workspaces/w%2F1/tree');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v2/workspaces/w%2F1/files?path=notes%2Ftoday.md');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v2/conversations/c%2F1/diff?path=notes%2Ftoday.md');
    expect(JSON.parse(String(fetchMock.mock.calls[3][1].body))).toEqual({
      path: 'notes/today.md', text: 'hi', baseVersion: 'v1',
    });
  });

  it('turns 409 E_CONFLICT with current into a ConflictError', async () => {
    const current = {
      path: 'a.md', size: 3, binary: false, tooLarge: false, text: 'new', version: 'v9',
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(409, { error: 'conflict', code: 'E_CONFLICT', current }, 'Conflict'),
    ));
    await expect(saveWorkspaceFile('w1', { path: 'a.md', text: 'mine', baseVersion: 'v1' }))
      .rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ConflictError);
        expect(isConflictError(err)).toBe(true);
        expect((err as ConflictError).current).toEqual(current);
        return true;
      });
    expect(workspaceFileUrl('w1', '../../etc/passwd')).toBe(
      '/api/v2/workspaces/w1/files?path=..%2F..%2Fetc%2Fpasswd',
    );
  });

  it('creates and patches providers through v2 endpoints', async () => {
    const created = {
      id: 'p1', vendor: 'DeepSeek', name: 'Work', access: 'api_key', runtime: 'model',
      baseUrl: 'https://api.deepseek.com/v1', keyMasked: '••••3f9c', hasKey: true,
      status: 'untested', statusText: '', lastTestedAt: null, models: [], isDefault: false,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, created))
      .mockResolvedValueOnce(jsonResponse(200, { ...created, name: 'Home' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createProvider({
      vendor: 'deepseek', name: 'Work', apiKey: 'sk-secret',
    }, 'zh')).resolves.toMatchObject({ id: 'p1', keyMasked: '••••3f9c' });
    await expect(patchProvider('p1', { name: 'Home' }, 'zh')).resolves.toMatchObject({ name: 'Home' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/providers?lang=zh');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      vendor: 'deepseek', name: 'Work', apiKey: 'sk-secret',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ name: 'Home' });
  });

  it('patches a conversation model and puts a context window, encoding ids', async () => {
    const view = { id: 'c/1', model: { sourceId: 'p/1', modelId: 'grok-4', label: 'grok-4' } };
    const provider = { id: 'p/1', models: [{ id: 'grok-4', contextWindow: 256000, contextWindowCustom: true }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, view))
      .mockResolvedValueOnce(jsonResponse(200, view))
      .mockResolvedValueOnce(jsonResponse(200, provider))
      .mockResolvedValueOnce(jsonResponse(200, provider));
    vi.stubGlobal('fetch', fetchMock);

    await expect(patchConversationModel('c/1', { providerId: 'p/1', modelId: 'grok-4' }))
      .resolves.toMatchObject({ id: 'c/1' });
    await expect(patchConversationModel('c/1', null)).resolves.toMatchObject({ id: 'c/1' });
    await expect(putModelContextWindow('p/1', 'grok-4', 256000))
      .resolves.toMatchObject({ id: 'p/1' });
    await expect(putModelContextWindow('p/1', 'grok-4', null))
      .resolves.toMatchObject({ id: 'p/1' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/conversations/c%2F1');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      model: { providerId: 'p/1', modelId: 'grok-4' },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ model: null });
    expect(fetchMock.mock.calls[2][0]).toBe(
      '/api/v2/providers/p%2F1/models/grok-4/context-window',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toEqual({ window: 256000 });
    expect(JSON.parse(String(fetchMock.mock.calls[3][1].body))).toEqual({ window: null });
  });

  it('creates a workspace and a git connection through v2 endpoints', async () => {
    const ws = {
      id: 'w1', name: 'widget', path: '/tmp/widget', source: 'git', gitUrl: 'https://gitlab.example/acme/widget.git',
      branch: 'main', conversationCount: 0, runningCount: 0,
    };
    const conn = {
      id: 'g1', name: 'Corp', kind: 'gitlab-self', baseUrl: 'http://127.0.0.1:1',
      token: '••••9k3q', hasToken: true, allowHttp: true, caFile: '', lastTest: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, ws))
      .mockResolvedValueOnce(jsonResponse(201, conn))
      .mockResolvedValueOnce(jsonResponse(200, { ...conn, name: 'Home' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createWorkspace({
      name: 'widget', source: 'git', connectionId: 'g1', projectId: 7, branch: 'main',
    }, 'zh')).resolves.toMatchObject({ id: 'w1' });
    await expect(createGitConnection({
      kind: 'gitlab-self', name: 'Corp', baseUrl: 'http://127.0.0.1:1', token: 'glpat-secret', allowHttp: true,
    }, 'zh')).resolves.toMatchObject({ token: '••••9k3q' });
    await expect(patchGitConnection('g1', { name: 'Home' }, 'zh')).resolves.toMatchObject({ name: 'Home' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/workspaces?lang=zh');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
      name: 'widget', source: 'git', connectionId: 'g1', projectId: 7, branch: 'main',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).token).toBe('glpat-secret');
    expect(JSON.parse(String(fetchMock.mock.calls[2][1].body))).toEqual({ name: 'Home' });
  });
});
