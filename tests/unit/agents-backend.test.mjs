import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './_root.mjs';

const { buildAgents, agentEventData } = await load('src/core/agents.mjs');
const { resolveKernelTarget } = await load('src/kernel/models.mjs');

test('buildAgents names the main agent Agent and has no role field', () => {
  const agents = buildAgents({
    conv: { id: 'c1', status: 'idle' },
    messages: [{ role: 'assistant', text: 'hi' }],
  });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'c1:agent:0');
  assert.equal(agents[0].name, 'Agent');
  assert.equal(agents[0].status, 'waiting');
  assert.equal(agents[0].lastText, 'hi');
  assert.equal(Object.hasOwn(agents[0], 'roleId'), false);
});

test('agentEventData omits retired role fields', () => {
  const data = agentEventData({
    id: 'c1:agent:0',
    name: 'Agent',
    status: 'waiting',
    step: 0,
    totalSteps: 0,
    lastText: '',
  });
  assert.equal(data.name, 'Agent');
  assert.equal(Object.hasOwn(data, 'roleId'), false);
});

test('resolveKernelTarget uses the pinned model, then defaultModel, otherwise null', () => {
  const settings = {
    version: 3,
    providers: [{
      id: 'custom-aaaaaaaa',
      kind: 'custom',
      name: 'A',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      enabled: ['alpha', 'beta'],
      overrides: {},
    }],
    defaultModel: { providerId: 'custom-aaaaaaaa', modelId: 'alpha' },
  };
  assert.deepEqual(
    resolveKernelTarget(settings, { modelSourceId: 'custom-aaaaaaaa', modelId: 'beta' }),
    { provider: 'custom-aaaaaaaa', modelId: 'beta' },
  );
  assert.deepEqual(resolveKernelTarget(settings, {}), {
    provider: 'custom-aaaaaaaa',
    modelId: 'alpha',
  });
  assert.equal(resolveKernelTarget({ version: 3, providers: [], defaultModel: null }, {}), null);
});
