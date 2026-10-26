import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { compileSchema } from '../../src/v2/validate.ts';
import { phrase } from '../../src/v2/phrases/index.ts';
import {
  catalogErrorView,
  gitCloneFailureView,
  gitConnectionView,
  gitTestStatusText,
  pathErrorView,
  pluginFailureText,
  pluginView,
  skillView,
} from '../../src/v2/views/extensions.ts';
import { ROOT } from './_root.mjs';

const spec = JSON.parse(readFileSync(path.join(ROOT, 'contract/openapi.json'), 'utf8'));
const validatePlugin = compileSchema(structuredClone(spec.components.schemas.Plugin));
const validateSkill = compileSchema(structuredClone(spec.components.schemas.Skill));
const validateConn = compileSchema(structuredClone(spec.components.schemas.GitConnection));
const validatePath = compileSchema(structuredClone(spec.components.schemas.PathNotAllowed));
const validateClone = compileSchema(structuredClone(spec.components.schemas.GitCloneFailure));
const validateCatalog = compileSchema(structuredClone(spec.components.schemas.CatalogError));

function ok(validate, value, label) {
  assert.equal(validate(value), true, `${label}: ${JSON.stringify(validate.errors)}`);
}

test('pluginFailureText ports describePluginFailure for zh and en', () => {
  assert.equal(pluginFailureText('zh', '', 'tool echo is not exported'), phrase('zh', 'err_plugin_tool_missing', { name: 'echo' }));
  assert.equal(pluginFailureText('en', '', 'tool echo is not exported'), phrase('en', 'err_plugin_tool_missing', { name: 'echo' }));
  assert.equal(pluginFailureText('zh', '', 'plugin.json is not valid JSON'), phrase('zh', 'err_plugin_json'));
  assert.equal(pluginFailureText('en', '', 'plugin main module was not found'), phrase('en', 'err_plugin_main_missing'));
  assert.equal(
    pluginFailureText('zh', '', 'tool word_count is already registered'),
    phrase('zh', 'err_plugin_tool_taken', { name: 'word_count' }),
  );
  const loadable = pluginFailureText('zh', 'err_plugin_not_loadable', 'boom detail');
  assert.match(loadable, /插件模块无法加载/);
  assert.match(loadable, /boom detail/);
  assert.equal(pluginFailureText('en', 'err_plugin_exists', ''), phrase('en', 'err_plugin_exists'));
});

test('pluginView puts the sentence in error and keeps errorCode', () => {
  const view = pluginView('zh', {
    id: 'broken',
    name: 'Broken',
    description: '',
    version: '0.0.0',
    source: 'imported',
    enabled: true,
    loaded: false,
    error: 'tool broken_tool is not exported',
    errorCode: 'err_plugin_not_loadable',
    tools: [{ name: 'broken_tool', description: '' }],
  });
  ok(validatePlugin, view, 'failed-plugin');
  assert.equal(view.errorCode, 'err_plugin_not_loadable');
  assert.equal(view.error, phrase('zh', 'err_plugin_tool_missing', { name: 'broken_tool' }));
  const fine = pluginView('en', {
    id: 'echo',
    name: 'Echo',
    description: 'd',
    version: '0.1.0',
    source: 'bundled',
    enabled: true,
    loaded: true,
    error: null,
    errorCode: null,
    tools: [{ name: 'echo', description: 'Return text' }],
  });
  ok(validatePlugin, fine, 'ok-plugin');
  assert.equal(fine.error, null);
  assert.equal(fine.errorCode, null);
});

test('skillView and catalogErrorView zh/en', () => {
  const skill = skillView({
    id: 'commit-message',
    name: 'Commit messages',
    description: 'why',
    version: '1.0.0',
    source: 'bundled',
    enabled: true,
    deletable: false,
  });
  ok(validateSkill, skill, 'skill');
  const zh = catalogErrorView('zh', { catalogCode: 'err_skill_builtin', message: 'built-in skill cannot be deleted' });
  const en = catalogErrorView('en', { catalogCode: 'err_skill_builtin', message: 'built-in skill cannot be deleted' });
  ok(validateCatalog, zh, 'catalog-zh');
  ok(validateCatalog, en, 'catalog-en');
  assert.equal(zh.error, phrase('zh', 'err_skill_builtin'));
  assert.equal(en.error, phrase('en', 'err_skill_builtin'));
  assert.equal(zh.code, 'err_skill_builtin');
});

test('pathErrorView uses allowed root sentence', () => {
  const zh = pathErrorView('zh', { message: 'path is not under an allowed workspace root' }, '/home/me/projects');
  const en = pathErrorView('en', { message: 'path is forbidden' }, '/home/me/projects');
  ok(validatePath, zh, 'path-zh');
  ok(validatePath, en, 'path-en');
  assert.equal(zh.code, 'E_PATH');
  assert.equal(zh.error, phrase('zh', 'ws_err_path_root', { root: '/home/me/projects' }));
  assert.equal(en.error, phrase('en', 'ws_err_path_root', { root: '/home/me/projects' }));
});

test('gitCloneFailureView distinguishes connection vs clone codes', () => {
  const clone = gitCloneFailureView('zh', { message: 'git clone failed', gitCode: 'auth_failed' });
  const via = gitCloneFailureView('en', { message: 'git clone failed', gitCode: 'auth_failed', via: 'connection' });
  const url = gitCloneFailureView('zh', { message: 'invalid gitUrl' });
  ok(validateClone, clone, 'clone');
  ok(validateClone, via, 'via');
  ok(validateClone, url, 'url');
  assert.equal(clone.code, 'auth_failed');
  assert.equal(clone.error, phrase('zh', 'ws_err_git_auth'));
  assert.equal(via.via, 'connection');
  assert.equal(via.error, phrase('en', 'ws_err_conn_auth'));
  assert.equal(url.error, phrase('zh', 'ws_err_git_url'));
});

test('gitConnectionView masks nothing extra and adds lastTest.errorText', () => {
  const view = gitConnectionView('zh', {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: '内网',
    kind: 'gitlab-self',
    baseUrl: 'http://127.0.0.1:9',
    token: '••••9k3q',
    hasToken: true,
    allowHttp: true,
    caFile: '',
    lastTest: { ok: false, username: '', error: 'auth_failed', at: '2026-01-01T00:00:00.000Z' },
  });
  ok(validateConn, view, 'conn');
  assert.equal(view.token.includes('glpat'), false);
  assert.equal(view.lastTest.error, 'auth_failed');
  assert.equal(view.lastTest.errorText, phrase('zh', 'git_test_auth'));
  assert.equal(gitTestStatusText('en', 'http_not_allowed', false), phrase('en', 'git_test_http'));
  assert.equal(gitTestStatusText('zh', '', true), phrase('zh', 'git_test_ok'));
});
