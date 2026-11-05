import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { load, ROOT } from './_root.mjs';
import { readDiscovery, request as serverRequest, startServer, stopServer } from './_server.mjs';
import { SAMPLE_COMMIT_SKILL, SAMPLE_REVIEW_SKILL, writeSampleEcho, writeSampleSkills } from './_sample-extensions.mjs';

const {
  SKILL_LIST_INTRO,
  buildSkillPrompt,
  createSkill,
  deleteSkill,
  listSkills,
  loadSkillBody,
  renderSkillList,
  updateSkill,
  writeSkillFile,
} = await load('src/core/skills.mjs');
const { clearPluginCache, describePlugins, installPlugin, pluginHandlers } = await load('src/core/plugins.mjs');
const { mergeSettings, normalizeSettings } = await load('src/core/settings.mjs');

async function tmp() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'piw-ext-')));
}

function pluginFixture(id, toolName) {
  return {
    manifest: {
      id,
      name: id,
      description: `${id} tool`,
      version: '0.1.0',
      source: 'local',
      main: 'index.mjs',
      tools: [{ name: toolName, description: `Run ${toolName}`, parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
    },
    source: `export async function ${toolName}(args) {\n  return { output: '${toolName}:' + String(args?.text || ''), status: 'completed' };\n}\n`,
  };
}

async function writePlugin(dir, id, toolName, source) {
  const folder = path.join(dir, id);
  await fs.mkdir(folder, { recursive: true });
  const fixture = pluginFixture(id, toolName);
  if (source) fixture.source = source;
  await fs.writeFile(path.join(folder, 'plugin.json'), `${JSON.stringify(fixture.manifest, null, 2)}\n`);
  await fs.writeFile(path.join(folder, 'index.mjs'), fixture.source);
  return folder;
}

test('skills render as a one-line catalog and can be disabled', async () => {
  const skillsDir = await tmp();
  await writeSampleSkills(skillsDir);
  const dirs = [skillsDir];
  const enabled = await buildSkillPrompt(dirs, {});
  assert.equal(
    enabled,
    [
      SKILL_LIST_INTRO,
      `- commit-message: ${SAMPLE_COMMIT_SKILL.description}`,
      `- review-notes: ${SAMPLE_REVIEW_SKILL.description}`,
    ].join('\n'),
  );
  assert.equal(enabled.includes('Subject line is imperative'), false);
  assert.equal(enabled.includes('Lead with findings'), false);
  assert.equal(enabled.includes('# Skills'), false);
  const disabled = await buildSkillPrompt(dirs, { 'commit-message': false, 'review-notes': false });
  assert.equal(disabled, '');
  const listed = await listSkills(dirs, { 'review-notes': false });
  assert.equal(listed.find((skill) => skill.id === 'commit-message').enabled, true);
  assert.equal(listed.find((skill) => skill.id === 'review-notes').enabled, false);
  assert.equal(listed.some((skill) => Object.hasOwn(skill, 'body')), false);
});

test('skill list flattens descriptions; loadSkillBody matches id then name', async () => {
  const long = `${'why '.repeat(80)}\nsecond line`;
  const list = renderSkillList([
    { id: 'wide', description: long },
    { id: 'plain', description: 'one line' },
  ]);
  assert.equal(list.startsWith(`${SKILL_LIST_INTRO}\n`), true);
  const wide = list.split('\n').find((line) => line.startsWith('- wide: '));
  assert.ok(wide);
  assert.equal(wide.includes('\n'), false);
  assert.equal(wide.length <= `- wide: `.length + 160, true);
  assert.match(list, /^- plain: one line$/m);

  const skillsDir = await tmp();
  await writeSampleSkills(skillsDir);
  const dirs = [skillsDir];
  const byId = await loadSkillBody(dirs, {}, 'commit-message');
  assert.match(byId.body, /Subject line is imperative/);
  const byName = await loadSkillBody(dirs, {}, 'Commit messages');
  assert.equal(byName.body, byId.body);
  const unknown = await loadSkillBody(dirs, { 'commit-message': false }, 'commit-message');
  assert.equal(unknown.body, undefined);
  assert.match(unknown.error, /^unknown skill commit-message，可用：/);
  assert.match(unknown.error, /review-notes/);
  assert.equal(unknown.error.split('可用：')[1].includes('commit-message'), false);
});

test('user skills override earlier text and reject duplicates', async () => {
  const earlier = await tmp();
  await writeSampleSkills(earlier);
  const user = await tmp();
  await writeSkillFile(user, {
    id: 'commit-message',
    name: 'Commit messages',
    description: 'local override',
    body: 'USER_SKILL_MARK',
    source: 'local',
  });
  const prompt = await buildSkillPrompt([earlier, user], {});
  assert.match(prompt, /- commit-message: local override/);
  assert.equal(prompt.includes('USER_SKILL_MARK'), false);
  assert.equal(prompt.includes('imperative'), false);
  const loaded = await loadSkillBody([earlier, user], {}, 'commit-message');
  assert.equal(loaded.body, 'USER_SKILL_MARK');
  await assert.rejects(
    () => createSkill(user, { name: 'Commit messages', id: 'commit-message', body: 'again' }, new Set(['commit-message'])),
    (err) => err.catalogCode === 'err_skill_exists',
  );
  const created = await createSkill(user, { name: '发布检查', description: '发版前', body: '先看测试再发版。' }, new Set());
  assert.match(created.id, /^skill-[0-9a-f]{6}$/);
  const updated = await updateSkill([user], user, created.id, { body: 'UPDATED_SKILL_BODY' });
  assert.equal(updated.body, 'UPDATED_SKILL_BODY');
  const again = await buildSkillPrompt([user], { [created.id]: false });
  assert.equal(again.includes('UPDATED_SKILL_BODY'), false);
  assert.equal(again.includes(created.id), false);
  const shutBody = await loadSkillBody([user], { [created.id]: false }, created.id);
  assert.match(shutBody.error, new RegExp(`unknown skill ${created.id}`));
  const listed = await listSkills([earlier, user], {}, user);
  assert.equal(listed.find((skill) => skill.id === 'review-notes').deletable, false);
  assert.equal(listed.find((skill) => skill.id === created.id).deletable, true);
  await assert.rejects(
    () => deleteSkill([earlier], user, 'review-notes'),
    (err) => err.catalogCode === 'err_skill_builtin',
  );
  assert.equal((await deleteSkill([earlier, user], user, created.id)).id, created.id);
  assert.equal((await listSkills([user], {}, user)).some((skill) => skill.id === created.id), false);
});

test('settings keep skill and plugin toggles', () => {
  const next = mergeSettings({ plugins: { echo: true }, skills: {} }, { skills: { 'commit-message': false } });
  assert.equal(next.skills['commit-message'], false);
  assert.equal(next.plugins.echo, true);
  const normalized = normalizeSettings({ skills: { 'review-notes': 'false' }, plugins: { echo: 0 } });
  assert.equal(normalized.skills['review-notes'], false);
  assert.equal(normalized.plugins.echo, false);
});

test('a sample echo plugin loads and a disabled plugin contributes no tool', async () => {
  clearPluginCache();
  const pluginsDir = await tmp();
  await writeSampleEcho(pluginsDir);
  const dirs = [pluginsDir];
  const listed = await describePlugins(dirs, {});
  const echo = listed.find((plugin) => plugin.id === 'echo');
  assert.equal(echo.loaded, true);
  assert.equal(echo.enabled, true);
  assert.equal(echo.tools[0].name, 'echo');
  assert.equal(Object.hasOwn(echo, 'handlers'), false);
  const tools = await pluginHandlers(dirs, {});
  const result = await tools.find((tool) => tool.name === 'echo').handler({ text: 'ping' });
  assert.equal(result.output, 'ping');
  const disabled = await pluginHandlers(dirs, { echo: false });
  assert.equal(disabled.length, 0);
});

test('plugin import loads a module and rejects metadata, symlinks, and path escapes', async () => {
  clearPluginCache();
  const srcRoot = await tmp();
  const dest = await tmp();
  const folder = await writePlugin(srcRoot, 'ping', 'ping');
  const installed = await installPlugin(folder, dest, { existingIds: new Set(), existingToolNames: new Set(['echo']) });
  assert.equal(installed.id, 'ping');
  assert.equal(installed.loaded, true);
  assert.equal(installed.source, 'imported');
  await fs.rm(folder, { recursive: true, force: true });
  const fromCopy = await pluginHandlers([dest], {});
  const ran = await fromCopy[0].handler({ text: 'ok' });
  assert.equal(ran.output, 'ping:ok');

  const dead = path.join(srcRoot, 'dead');
  await fs.mkdir(dead, { recursive: true });
  await fs.writeFile(path.join(dead, 'plugin.json'), JSON.stringify({ id: 'dead', name: 'Dead', description: 'no module' }));
  await assert.rejects(
    () => installPlugin(dead, dest, { existingIds: new Set(['ping']) }),
    (err) => err.catalogCode === 'err_plugin_not_loadable' || err.catalogCode === 'err_plugin_invalid',
  );
  assert.equal(await fs.access(path.join(dest, 'dead')).then(() => true, () => false), false);

  await assert.rejects(
    () => installPlugin('', dest, { existingIds: new Set() }),
    (err) => err.catalogCode === 'err_plugin_path_required',
  );

  const escaped = path.join(srcRoot, 'evil');
  await fs.mkdir(escaped, { recursive: true });
  const marker = path.join(srcRoot, 'marker.txt');
  await fs.writeFile(path.join(srcRoot, 'outside.mjs'), `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'x');\nexport function evil(){ return { output: 'no' }; }\n`);
  await fs.writeFile(path.join(escaped, 'plugin.json'), JSON.stringify({
    id: 'evil',
    name: 'Evil',
    description: 'escape',
    version: '0.0.1',
    main: '../outside.mjs',
    tools: [{ name: 'evil', description: 'no' }],
  }));
  await assert.rejects(
    () => installPlugin(escaped, dest, { existingIds: new Set() }),
    (err) => err.catalogCode === 'err_plugin_not_loadable',
  );
  assert.equal(await fs.access(marker).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(dest, 'evil')).then(() => true, () => false), false);

  const linked = path.join(srcRoot, 'linked');
  await fs.mkdir(linked, { recursive: true });
  await fs.writeFile(path.join(linked, 'plugin.json'), JSON.stringify(pluginFixture('linked', 'linked').manifest));
  await fs.symlink(path.join(srcRoot, 'outside.mjs'), path.join(linked, 'index.mjs'));
  await assert.rejects(
    () => installPlugin(linked, dest, { existingIds: new Set() }),
    (err) => err.catalogCode === 'err_plugin_symlink',
  );
});

test('install directory ships only the ask plugin and no skills', async () => {
  const repoSkills = await listSkills([path.join(ROOT, 'skills')], {});
  const repoPlugins = await describePlugins([path.join(ROOT, 'plugins')], {});
  assert.deepEqual(repoSkills, []);
  assert.equal(repoPlugins.length, 1);
  assert.equal(repoPlugins[0].id, 'ask');
  assert.equal(repoPlugins[0].loaded, true);
  assert.equal(repoPlugins[0].enabled, true);
  assert.equal(repoPlugins[0].tools[0].name, 'ask_user_question');
  assert.equal(Object.hasOwn(repoPlugins[0], 'handlers'), false);

  const token = 'unit-test-token-empty-ext';
  const srv = await startServer({ token, env: { WEFT_LLM: 'faux' } });
  try {
    const skills = await serverRequest(srv.base, 'GET', '/api/skills', undefined, token);
    const plugins = await serverRequest(srv.base, 'GET', '/api/plugins', undefined, token);
    assert.equal(skills.status, 200);
    assert.deepEqual(skills.body, []);
    assert.equal(plugins.status, 200);
    assert.deepEqual(plugins.body.map((plugin) => plugin.id), ['ask']);
    assert.equal(plugins.body[0].loaded, true);
    assert.equal(plugins.body[0].tools[0].name, 'ask_user_question');

    const discovery = await readDiscovery(srv.dataDir);
    const v2Skills = await fetch(`${srv.base}/api/v2/skills`, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    const v2Plugins = await fetch(`${srv.base}/api/v2/plugins`, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    assert.equal(v2Skills.status, 200);
    assert.deepEqual((await v2Skills.json()).skills, []);
    assert.equal(v2Plugins.status, 200);
    const v2PluginBody = await v2Plugins.json();
    assert.deepEqual(v2PluginBody.plugins.map((plugin) => plugin.id), ['ask']);
    assert.equal(v2PluginBody.plugins[0].loaded, true);
    assert.equal(v2PluginBody.plugins[0].tools[0].name, 'ask_user_question');

    const log = srv.logs();
    assert.match(log, /WEFT_READY /);
    assert.equal(/WEFT_ERROR|WEFT_KERNEL_PLUGIN|WEFT_KERNEL_OPEN_FAILED|ENOENT/.test(log), false, log);
  } finally {
    await stopServer(srv);
  }
});

test('examples/plugins/word-count still installs and counts words', async () => {
  clearPluginCache();
  const dest = await tmp();
  const ws = await tmp();
  await fs.writeFile(path.join(ws, 'wc-sample.txt'), 'one two three four\n');
  const installed = await installPlugin(path.join(ROOT, 'examples/plugins/word-count'), dest, {
    existingIds: new Set(),
    existingToolNames: new Set(),
  });
  assert.equal(installed.id, 'word-count');
  assert.equal(installed.loaded, true);
  assert.equal(installed.source, 'imported');
  assert.equal(installed.tools[0].name, 'word_count');
  const tools = await pluginHandlers([dest], {});
  const result = await tools.find((tool) => tool.name === 'word_count').handler(
    { path: 'wc-sample.txt' },
    { workspacePath: ws },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.output, '4');
});

test('http api creates skills, rejects dead plugin metadata, and runs echo', async () => {
  const dataDir = await tmp();
  await writeSampleSkills(path.join(dataDir, 'skills'));
  await writeSampleEcho(path.join(dataDir, 'plugins'));
  const scriptPath = path.join(dataDir, 'faux.json');
  await fs.writeFile(scriptPath, JSON.stringify({
    turns: [
      { tool: 'echo', args: { text: 'from-plugin' } },
      { text: 'done' },
    ],
  }));
  const token = 'unit-test-token-skills';
  const record = path.join(dataDir, 'requests.jsonl');
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      WEFT_DATA_DIR: dataDir,
      WEFT_TOKEN: token,
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: scriptPath,
      WEFT_FAUX_RECORD: record,
      WEFT_RETRY_BASE_MS: '20',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 15000);
    const onData = (buf) => {
      log += buf;
      const match = log.match(/WEFT_READY (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}:\n${log}`));
    });
  });
  proc.removeAllListeners('exit');

  async function request(method, apiPath, body) {
    const res = await fetch(base + apiPath, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  try {
    const skills = await request('GET', '/api/skills');
    assert.equal(skills.status, 200);
    assert.equal(skills.body.find((skill) => skill.id === 'commit-message').enabled, true);
    assert.equal(skills.body.some((skill) => skill.id === 'review-notes'), true);

    const created = await request('POST', '/api/skills', {
      name: '发布检查',
      description: '发版前',
      body: '先看测试再发版。',
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.enabled, true);
    assert.match(created.body.id, /^skill-/);

    const off = await request('PUT', `/api/skills/${created.body.id}`, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);

    const edited = await request('PUT', `/api/skills/${created.body.id}`, { body: '只报告失败的测试。' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.description, '发版前');
    assert.equal(created.body.deletable, true);
    assert.equal(skills.body.find((skill) => skill.id === 'commit-message').deletable, false);

    const removed = await request('DELETE', `/api/skills/${created.body.id}`);
    assert.equal(removed.status, 200);
    const afterDelete = await request('GET', '/api/skills');
    assert.equal(afterDelete.body.some((skill) => skill.id === created.body.id), false);
    const builtin = await request('DELETE', '/api/skills/commit-message');
    assert.equal(builtin.status, 403);
    assert.equal(builtin.body.code, 'err_skill_builtin');

    const ghost = await request('POST', '/api/plugins', { name: 'ghost', description: 'not a module', version: '1.0.0' });
    assert.equal(ghost.status, 400);
    assert.equal(ghost.body.code, 'err_plugin_path_required');

    const plugins = await request('GET', '/api/plugins');
    assert.equal(plugins.status, 200);
    const echo = plugins.body.find((plugin) => plugin.id === 'echo');
    assert.equal(echo.loaded, true);
    assert.equal(echo.tools[0].name, 'echo');
    assert.equal(plugins.body.some((plugin) => plugin.id === 'ghost'), false);

    const ws = await request('POST', '/api/workspaces', { name: 'ext' });
    assert.equal(ws.status, 201);
    const conv = await request('POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'echo' });
    assert.equal(conv.status, 201);
    const sent = await request('POST', `/api/conversations/${conv.body.id}/messages`, { text: 'ping the plugin' });
    assert.equal(sent.status, 202);
    const done = await waitConv(request, conv.body.id);
    assert.equal(done.status, 'done');
    assert.equal(done.messages.some((message) => message.role === 'tool' && message.text === 'from-plugin'), true);
    const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const skillText = calls[0].sections.find((section) => section.key === 'skills')?.value || '';
    assert.match(skillText, /Skills you can load with the skill tool when a request matches:/);
    assert.match(skillText, /^- commit-message: /m);
    assert.equal(skillText.includes('Subject line is imperative'), false);
    assert.equal((calls[0].tools || []).includes('skill'), true);

    const skillOff = await request('PUT', '/api/skills/commit-message', { enabled: false });
    assert.equal(skillOff.status, 200);
    const disabled = await request('PUT', '/api/plugins/echo', { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);
    const conv2 = await request('POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'echo-off' });
    await request('POST', `/api/conversations/${conv2.body.id}/messages`, { text: 'ping again' });
    const doneOff = await waitConv(request, conv2.body.id);
    assert.equal(doneOff.messages.some((message) => message.text === 'E_UNKNOWN_TOOL'), true);
    assert.equal(doneOff.messages.some((message) => message.text === 'from-plugin'), false);
    const later = (await fs.readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const shut = later[later.length - 1].sections.find((section) => section.key === 'skills')?.value || '';
    assert.equal(shut.includes('commit-message'), false);
    assert.match(shut, /review-notes/);
    assert.equal(shut.includes('Subject line is imperative'), false);
  } finally {
    await stopProcess(proc);
  }
});

async function waitConv(request, id) {
  for (let i = 0; i < 40; i += 1) {
    const res = await request('GET', `/api/conversations/${id}`);
    if (res.body?.status === 'done' || res.body?.status === 'failed') return res.body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`conversation ${id} did not finish`);
}

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}
