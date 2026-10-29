import { createProvider } from '@earendil-works/pi-ai/models';

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function chatModel(providerId, id, extra = {}) {
  return {
    id,
    name: extra.name || id,
    api: extra.api || 'openai-completions',
    provider: providerId,
    baseUrl: extra.baseUrl || 'http://127.0.0.1:9/v1',
    reasoning: extra.reasoning === true,
    input: extra.images ? ['text', 'image'] : ['text'],
    cost: { ...COST },
    contextWindow: extra.contextWindow ?? 8000,
    maxTokens: extra.maxTokens ?? 2000,
  };
}

function assistantMessage(model, { stopReason = 'stop', errorMessage, status } = {}) {
  return {
    role: 'assistant',
    content: stopReason === 'error' ? [] : [{ type: 'text', text: 'ok' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
    status,
  };
}

function resultStream(message, event) {
  return {
    async *[Symbol.asyncIterator]() {
      yield event;
    },
    result: async () => message,
  };
}

export function fakeChatApi({ onCall } = {}) {
  return {
    stream(...args) {
      return this.streamSimple(...args);
    },
    streamSimple(model, context, options) {
      const outcome = onCall ? onCall({ model, context, options }) : { ok: true };
      if (outcome && outcome.throw) throw outcome.throw;
      const httpStatus = outcome?.status ?? (outcome?.ok === false ? 401 : 200);
      try { options?.onResponse?.({ status: httpStatus }); } catch { /* ignore */ }
      if (outcome?.ok === false) {
        const message = assistantMessage(model, {
          stopReason: 'error',
          errorMessage: outcome.errorMessage || 'invalid api key',
          status: httpStatus,
        });
        return resultStream(message, { type: 'error', reason: 'error', error: message });
      }
      const message = assistantMessage(model);
      return resultStream(message, { type: 'done', message });
    },
  };
}

export function fakeKeyProvider({
  id = 'weft-key',
  name = 'Fake Key',
  models = ['fake-1', 'fake-2'],
  onCall,
  envVar = 'WEFT_FAKE_KEY',
} = {}) {
  const list = models.map((item) => (typeof item === 'string' ? chatModel(id, item) : item));
  return createProvider({
    id,
    name,
    auth: {
      apiKey: {
        name: `${name} key`,
        async resolve({ credential, ctx } = {}) {
          if (credential?.key) return { auth: { apiKey: credential.key }, source: 'stored credential' };
          const envKey = envVar && ctx?.env ? await ctx.env(envVar) : undefined;
          if (envKey) return { auth: { apiKey: envKey }, source: envVar };
          return undefined;
        },
      },
    },
    models: list,
    api: fakeChatApi({ onCall }),
  });
}

export function fakeOAuthProvider({
  id = 'weft-oauth',
  name = 'Fake OAuth',
  models = ['oauth-1', 'oauth-2'],
  onLogin,
} = {}) {
  const list = models.map((item) => (typeof item === 'string' ? chatModel(id, item) : item));
  return createProvider({
    id,
    name,
    auth: {
      oauth: {
        name: `${name} OAuth`,
        async login(interaction) {
          if (onLogin) return onLogin(interaction);
          interaction.notify({
            type: 'auth_url',
            url: 'https://example.test/auth',
            instructions: 'Open the link',
          });
          interaction.notify({
            type: 'device_code',
            userCode: 'ABCD-1234',
            verificationUri: 'https://example.test/device',
          });
          interaction.notify({ type: 'info', message: 'Waiting for code' });
          const value = await interaction.prompt({
            type: 'manual_code',
            message: 'Enter the code',
            placeholder: 'code',
          });
          if (interaction.signal?.aborted) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }
          return {
            type: 'oauth',
            access: `tok-${value || 'ok'}`,
            refresh: 'ref-ok',
            expires: Date.now() + 3_600_000,
            account: 'tester@example.test',
          };
        },
        async refresh(credential) {
          return credential;
        },
        async toAuth(credential) {
          return { apiKey: credential.access };
        },
      },
    },
    models: list,
    api: fakeChatApi(),
  });
}

export async function waitUntil(fn, { timeoutMs = 2_000, intervalMs = 15 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitUntil timed out: ${last == null ? 'no value' : JSON.stringify(last)}`);
}
