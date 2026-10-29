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
    id: 'chatcmpl-kernel',
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
 * Local stand-in for one OpenAI-compatible model endpoint.
 * Records the key's last 4 characters, never the secret.
 */
export function startFakeModel({ mode = 'openai', text }) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const authorization = String(req.headers.authorization || '');
    const record = {
      method: req.method,
      path: url.pathname,
      keyTail: authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(-4) : '',
    };
    let raw = '';
    try {
      raw = await readBody(req);
    } catch {
      seen.push(record);
      res.writeHead(400);
      res.end('bad body');
      return;
    }
    record.raw = raw;
    try {
      const parsed = JSON.parse(raw);
      record.body = parsed;
      if (typeof parsed?.model === 'string') record.model = parsed.model;
    } catch { /* ignore non-JSON */ }
    seen.push(record);

    if (mode === 'openai' && url.pathname.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(chatCompletionSse(text));
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
        seen,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
