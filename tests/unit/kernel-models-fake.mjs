import http from 'node:http';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const TITLE_PROMPT_MARKER = 'Write a short conversation title.';

/** Completions that are the host's one-shot title call, not a harness turn. */
export function isTitleCompletionHit(hit) {
  return String(hit?.raw || '').includes(TITLE_PROMPT_MARKER);
}

export function chatCompletionHits(seen) {
  return (seen || []).filter((hit) => (
    String(hit?.path || '').endsWith('/chat/completions') && !isTitleCompletionHit(hit)
  ));
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
 * Rewrite `https://api.deepseek.com` to a local fake. Captures the original
 * fetch so this can also be installed as `globalThis.fetch` in a child process.
 */
export function rewriteDeepseekFetch(fakeBaseUrl, fetchImpl = globalThis.fetch) {
  const fake = new URL(fakeBaseUrl);
  const orig = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const href = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.href : (input && typeof input.url === 'string' ? input.url : ''));
    const url = new URL(href);
    if (url.hostname !== 'api.deepseek.com') return orig(input, init);
    url.protocol = fake.protocol;
    url.host = fake.host;
    if (input instanceof Request) return orig(new Request(url, input), init);
    return orig(url, init);
  };
}

const fakeDeepseekOrigin = String(process.env.WEFT_FAKE_DEEPSEEK_ORIGIN || '').trim();
if (fakeDeepseekOrigin) {
  globalThis.fetch = rewriteDeepseekFetch(fakeDeepseekOrigin);
}

/**
 * Local stand-in for one OpenAI-compatible model endpoint.
 * Records the key's last 4 characters, never the secret.
 */
export function startFakeModel({ mode = 'openai', text, models } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const authorization = String(req.headers.authorization || '');
    const record = {
      method: req.method,
      path: url.pathname,
      authorization,
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

    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(models || { data: [] }));
      return;
    }

    if (mode === 'openai' && url.pathname.endsWith('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(chatCompletionSse(text || 'ok'));
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
