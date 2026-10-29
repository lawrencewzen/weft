import http from 'node:http';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function chatCompletionSse(text) {
  const chunk = (delta, finish) => JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    `data: ${chunk({ role: 'assistant', content: text }, null)}`,
    '',
    `data: ${chunk({}, 'stop')}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

/**
 * Local stand-in for an OpenAI-compatible endpoint.
 * Supports GET /v1/models and POST /v1/chat/completions (streaming and non-streaming).
 */
export function startFakeOpenAIServer({
  models = [
    { id: 'grok-4.6', name: 'Grok 4.6', context_window: 200000 },
    { id: 'grok-4', name: 'Grok 4', context_window: 200000 },
  ],
  text = 'ok',
  statusFor,
  expectedKey,
} = {}) {
  const hits = [];
  const modelList = models.map((m) => {
    if (typeof m === 'string') {
      return { id: m, name: m, context_window: 200000 };
    }
    return {
      id: m.id,
      name: m.name || m.id,
      context_window: m.context_window ?? m.contextWindow ?? 200000,
      ...m,
    };
  });

  let closed = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const authorization = String(req.headers.authorization || '');
    const key = authorization.replace(/^Bearer\s+/i, '');
    const hit = { method: req.method, url: req.url, pathname: url.pathname, authorization };
    hits.push(hit);

    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('bad body');
      return;
    }
    hit.raw = raw;
    try { hit.body = JSON.parse(raw); } catch { /* non-JSON */ }

    const status = statusFor ? statusFor(key) : expectedKey && key !== expectedKey ? 401 : 200;
    if (status === 401) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
      return;
    }

    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: modelList }));
      return;
    }

    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const isStream = hit.body?.stream === true || req.headers.accept?.includes('text/event-stream');
      if (isStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(chatCompletionSse(text));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits,
        close: () => {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}
