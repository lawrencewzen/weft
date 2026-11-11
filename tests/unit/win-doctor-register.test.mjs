import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../../src/core/doctor.mjs';
import { createWinDoctorSection, registerWinDoctor, WIN_DOCTOR_TIMEOUT_TEXT } from '../../src/platform/win/doctor-register.mjs';

test('win doctor: not registered off Windows', () => {
  assert.equal(registerWinDoctor({ platform: 'darwin' }), null);
});

test('win doctor: registered section lands in the report', async () => {
  const off = registerWinDoctor({ platform: 'win32', run: async ({ dataDir }) => `win ok ${dataDir}` });
  try {
    const text = await runDoctor({ dataDir: 'D' });
    assert.match(text, /== windows ==\nwin ok D/);
    assert.match(text, /== base ==/);
  } finally {
    off();
  }
});

test('win doctor: timeout writes the marker without blocking', async () => {
  const section = createWinDoctorSection({ run: () => new Promise(() => {}), timeoutMs: 30 });
  const t0 = Date.now();
  assert.equal(await section({}), WIN_DOCTOR_TIMEOUT_TEXT);
  assert.ok(Date.now() - t0 < 2000);
});

test('win doctor: secret values are never emitted', async () => {
  const section = createWinDoctorSection({
    run: async () => 'leak sk-secret-value-123',
    env: { OPENAI_API_KEY: 'sk-secret-value-123' },
  });
  assert.ok(!(await section({})).includes('sk-secret-value-123'));
});
