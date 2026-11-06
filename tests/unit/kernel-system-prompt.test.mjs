import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import { SKILL_LIST_INTRO, buildSkillPrompt } from '../../src/core/skills.mjs';
import { createExtensionHost } from '../../src/core/extensions.mjs';
import { openConversationKernel } from '../../src/kernel/conversations.mjs';
import {
  DELEGATE_DESCRIPTION,
  SUBAGENT_DESCRIPTION,
  SUBAGENT_INSTRUCTIONS,
} from '../../src/kernel/subagents.mjs';
import {
  AGENTS_BYTE_LIMIT,
  AGENTS_TRUNCATION_LINE,
  PREAMBLE_TEXT,
  RULES_TEXT,
  clipUtf8Bytes,
  environmentText,
  isChatServiceCwd,
  shellLine,
} from '../../src/kernel/system-prompt.mjs';
import { createSqliteStore } from '../../src/store/sqlite.mjs';
import { ROOT } from './_root.mjs';

const DELEGATE_LEAD = 'Use this for independent tasks that can run on their own. Do simple work yourself.';
const SKILL_DIRS = [path.join(ROOT, 'skills')];

function platformName() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'linux') return 'Linux';
  if (process.platform === 'win32') return 'Windows';
  return process.platform;
}

function tagged(key, text) {
  return `<${key}>\n${text}\n</${key}>`;
}

function joinPrompt(parts) {
  return parts.filter((part) => part && part.length > 0).join('\n\n');
}

function projectBlock(content) {
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `<project_instructions path="AGENTS.md">\n${body}</project_instructions>`;
}

function environmentBlock({ cwd } = {}) {
  const lines = [];
  if (cwd) lines.push(`Working directory: ${cwd}`);
  lines.push(`Platform: ${platformName()}`);
  lines.push('Shell: bash (use the bash tool)');
  return lines.join('\n');
}

function mainPrompt({ cwd, project, skills }) {
  const parts = [
    PREAMBLE_TEXT,
    tagged('rules', RULES_TEXT),
    tagged('environment', environmentBlock({ cwd })),
  ];
  if (project) parts.push(tagged('project_context', project));
  if (skills) parts.push(tagged('skills', skills));
  parts.push(tagged('instructions', ''));
  return joinPrompt(parts);
}

function childPrompt({ cwd, project }) {
  const parts = [
    tagged('environment', environmentBlock({ cwd })),
  ];
  if (project) parts.push(tagged('project_context', project));
  parts.push(tagged('instructions', SUBAGENT_INSTRUCTIONS));
  return joinPrompt(parts);
}

async function openKernel(dataDir, env = {}) {
  const store = createSqliteStore(dataDir);
  const kernel = await openConversationKernel({
    dataDir,
    store,
    demo: true,
    extensions: createExtensionHost({
      skillDirs: SKILL_DIRS,
      getSettings: () => store.getSettings(),
    }),
    getSettings: () => store.getSettings(),
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_TEXT: 'noted',
      WEFT_RETRY_MAX: '1',
      WEFT_RETRY_BASE_MS: '20',
      ...env,
    },
  });
  return { store, kernel };
}

async function makeProject(store, kernel, dataDir, name) {
  const wsPath = path.join(dataDir, name);
  await mkdir(wsPath, { recursive: true });
  const ws = await store.createWorkspace({ name, path: wsPath, kind: 'project' });
  const conv = await kernel.createConversation({
    workspaceId: ws.id,
    workspacePath: wsPath,
    title: name,
  });
  return { ws, wsPath, root: await realpath(wsPath), conv };
}

async function waitDone(kernel, store, id) {
  let body = null;
  for (let i = 0; i < 100; i += 1) {
    const live = await store.getConversation(id);
    body = await kernel.present(live, { includeMessages: true });
    if (body.status === 'done' || body.status === 'failed') return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return body;
}

async function say(kernel, store, conv, text) {
  const posted = await kernel.postMessage(conv, text);
  assert.equal(posted.status, 202, JSON.stringify(posted.body));
  const done = await waitDone(kernel, store, conv.id);
  assert.equal(done.status, 'done', JSON.stringify(done.llmError || done.status));
  return done;
}

async function rendered(kernel, harnessId) {
  const handle = await kernel.harness.conversation(harnessId, kernel.context);
  assert.ok(handle);
  const view = await handle.context(kernel.context);
  return {
    prompt: getCurrentSystemPrompt(view.messages),
    systems: view.messages.filter((message) => message?.role === 'system'),
  };
}

function sectionKeys(message) {
  return Object.keys(message?.sections || {});
}

test('shell line follows the offered tool and chat directories are not projects', () => {
  assert.equal(shellLine([{ name: 'bash' }]), 'Shell: bash (use the bash tool)');
  assert.equal(shellLine([{ name: 'powershell' }]), 'Shell: PowerShell (use the powershell tool)');
  assert.equal(shellLine([{ name: 'bash' }, { name: 'powershell' }]), 'Shell: bash (use the bash tool)');
  assert.equal(shellLine([{ name: 'read' }]), '');
  const dataDir = '/tmp/weft-data';
  assert.equal(isChatServiceCwd(`${dataDir}/chats/abc`, dataDir), true);
  assert.equal(isChatServiceCwd(`${dataDir}/workspaces/repo`, dataDir), false);
  assert.equal(environmentText({
    agent: { tools: [{ name: 'read' }] },
    env: { cwd: process.cwd() },
  }).includes('Working directory:'), false);
  assert.equal(DELEGATE_DESCRIPTION.startsWith(`${DELEGATE_LEAD} `), true);
  assert.equal(SUBAGENT_DESCRIPTION.startsWith(`${DELEGATE_LEAD} `), true);
  assert.equal(SUBAGENT_INSTRUCTIONS.includes('?'), false);
  const limit = AGENTS_BYTE_LIMIT;
  const split = Buffer.concat([
    Buffer.alloc(limit - 1, 0x61),
    Buffer.from('中'),
    Buffer.from('TAIL'),
  ]);
  const clipped = clipUtf8Bytes(split, limit);
  assert.equal(clipped.length, limit - 1);
  assert.equal(clipped.toString('utf8').includes('\uFFFD'), false);
  assert.equal(clipped.toString('utf8').includes('中'), false);
});

test('rendered main-agent prompt: sections, workspaces, AGENTS.md, and no project', { timeout: 120000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-prompt-'));
  const skills = await buildSkillPrompt(SKILL_DIRS, {});
  let opened = null;
  try {
    opened = await openKernel(dataDir);
    const { store, kernel } = opened;
    const alphaBody = 'alpha rules for the prompt\n';
    const betaBody = 'beta rules, a different workspace';
    const alpha = await makeProject(store, kernel, dataDir, 'alpha');
    const beta = await makeProject(store, kernel, dataDir, 'beta');
    await writeFile(path.join(alpha.wsPath, 'AGENTS.md'), alphaBody);
    await writeFile(path.join(beta.wsPath, 'AGENTS.md'), betaBody);
    await writeFile(path.join(alpha.wsPath, 'CLAUDE.md'), 'CLAUDE_SHOULD_NOT_APPEAR');
    await mkdir(path.join(alpha.wsPath, 'docs'), { recursive: true });
    await writeFile(path.join(alpha.wsPath, 'docs', 'AGENTS.md'), 'NESTED_AGENTS_SHOULD_NOT_APPEAR');

    await say(kernel, store, alpha.conv, 'one');
    const first = await rendered(kernel, alpha.conv.harnessId);
    const expectedAlpha = mainPrompt({
      cwd: alpha.root,
      project: projectBlock(alphaBody),
      skills,
    });
    assert.deepEqual(sectionKeys(first.systems[0]), [
      'preamble', 'rules', 'environment', 'project_context', 'skills', 'instructions',
    ]);
    assert.equal(first.prompt, expectedAlpha);
    assert.equal(first.prompt.includes('CLAUDE_SHOULD_NOT_APPEAR'), false);
    assert.equal(first.prompt.includes('NESTED_AGENTS_SHOULD_NOT_APPEAR'), false);
    assert.match(first.prompt, /Shell: bash \(use the bash tool\)/);

    await say(kernel, store, alpha.conv, 'two');
    const second = await rendered(kernel, alpha.conv.harnessId);
    assert.equal(second.systems.length, first.systems.length);
    assert.equal(second.systems.filter((message) => typeof message.sections?.preamble === 'string').length, 1);
    assert.equal(second.prompt, first.prompt);

    const updated = 'alpha rules were edited\n';
    await writeFile(path.join(alpha.wsPath, 'AGENTS.md'), updated);
    await say(kernel, store, alpha.conv, 'three');
    const third = await rendered(kernel, alpha.conv.harnessId);
    assert.equal(third.prompt, mainPrompt({
      cwd: alpha.root,
      project: projectBlock(updated),
      skills,
    }));
    const patch = third.systems[third.systems.length - 1];
    assert.deepEqual(Object.keys(patch.sections), ['project_context']);
    assert.equal(patch.sections.preamble, undefined);
    assert.match(patch.sections.project_context, /alpha rules were edited/);

    await rm(path.join(alpha.wsPath, 'AGENTS.md'));
    await say(kernel, store, alpha.conv, 'four');
    const gone = await rendered(kernel, alpha.conv.harnessId);
    assert.equal(gone.prompt, mainPrompt({ cwd: alpha.root, skills }));
    assert.equal(gone.prompt.includes('project_context'), false);
    assert.equal(gone.prompt.includes('alpha rules'), false);
    const removal = gone.systems[gone.systems.length - 1];
    assert.equal(removal.sections.project_context, null);

    await say(kernel, store, beta.conv, 'beta');
    const betaPrompt = await rendered(kernel, beta.conv.harnessId);
    assert.equal(betaPrompt.prompt, mainPrompt({
      cwd: beta.root,
      project: projectBlock(betaBody),
      skills,
    }));
    assert.notEqual(alpha.root, beta.root);
    assert.equal(betaPrompt.prompt.includes(`Working directory: ${alpha.root}`), false);
    assert.equal(betaPrompt.prompt.includes('alpha rules'), false);
    assert.match(betaPrompt.prompt, new RegExp(`Working directory: ${beta.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const claudeOnly = await makeProject(store, kernel, dataDir, 'claude-only');
    await writeFile(path.join(claudeOnly.wsPath, 'CLAUDE.md'), 'ONLY_CLAUDE_MD');
    await mkdir(path.join(claudeOnly.wsPath, 'nested'), { recursive: true });
    await writeFile(path.join(claudeOnly.wsPath, 'nested', 'AGENTS.md'), 'ONLY_NESTED_AGENTS');
    await say(kernel, store, claudeOnly.conv, 'claude');
    const claudePrompt = (await rendered(kernel, claudeOnly.conv.harnessId)).prompt;
    assert.equal(claudePrompt, mainPrompt({ cwd: claudeOnly.root, skills }));
    assert.equal(claudePrompt.includes('ONLY_CLAUDE_MD'), false);
    assert.equal(claudePrompt.includes('ONLY_NESTED_AGENTS'), false);
    assert.equal(claudePrompt.includes('project_context'), false);

    const empty = await makeProject(store, kernel, dataDir, 'empty-agents');
    await writeFile(path.join(empty.wsPath, 'AGENTS.md'), ' \n');
    await say(kernel, store, empty.conv, 'empty');
    assert.equal((await rendered(kernel, empty.conv.harnessId)).prompt, mainPrompt({
      cwd: empty.root,
      skills,
    }));

    const split = await makeProject(store, kernel, dataDir, 'split-char');
    const splitBytes = Buffer.concat([
      Buffer.alloc(AGENTS_BYTE_LIMIT - 1, 0x61),
      Buffer.from('中'),
      Buffer.from('TAIL_AFTER_CUT'),
    ]);
    await writeFile(path.join(split.wsPath, 'AGENTS.md'), splitBytes);
    await say(kernel, store, split.conv, 'split');
    const splitKept = Buffer.alloc(AGENTS_BYTE_LIMIT - 1, 0x61).toString('utf8');
    const splitProject = `<project_instructions path="AGENTS.md">\n${splitKept}\n${AGENTS_TRUNCATION_LINE}\n</project_instructions>`;
    const splitPrompt = (await rendered(kernel, split.conv.harnessId)).prompt;
    assert.equal(splitPrompt, mainPrompt({ cwd: split.root, project: splitProject, skills }));
    assert.equal(splitPrompt.includes('\uFFFD'), false);
    assert.equal(splitPrompt.includes('中'), false);
    assert.equal(splitPrompt.includes('TAIL_AFTER_CUT'), false);
    assert.equal(Buffer.byteLength(splitKept, 'utf8') <= AGENTS_BYTE_LIMIT, true);

    const fit = await makeProject(store, kernel, dataDir, 'fit-char');
    const fitHead = Buffer.concat([
      Buffer.alloc(AGENTS_BYTE_LIMIT - 3, 0x61),
      Buffer.from('中'),
    ]);
    await writeFile(path.join(fit.wsPath, 'AGENTS.md'), Buffer.concat([fitHead, Buffer.from('MORE_AFTER_LIMIT')]));
    await say(kernel, store, fit.conv, 'fit');
    const fitProject = `<project_instructions path="AGENTS.md">\n${fitHead.toString('utf8')}\n${AGENTS_TRUNCATION_LINE}\n</project_instructions>`;
    const fitPrompt = (await rendered(kernel, fit.conv.harnessId)).prompt;
    assert.equal(fitPrompt, mainPrompt({ cwd: fit.root, project: fitProject, skills }));
    assert.equal(fitPrompt.includes('中'), true);
    assert.equal(fitPrompt.includes('\uFFFD'), false);
    assert.equal(fitPrompt.includes('MORE_AFTER_LIMIT'), false);

    const broken = await makeProject(store, kernel, dataDir, 'unreadable');
    await mkdir(path.join(broken.wsPath, 'AGENTS.md'), { recursive: true });
    await say(kernel, store, broken.conv, 'broken');
    const brokenView = await rendered(kernel, broken.conv.harnessId);
    assert.equal(brokenView.prompt, mainPrompt({ cwd: broken.root, skills }));
    assert.equal(brokenView.prompt.includes('project_context'), false);

    const chatDir = path.join(dataDir, 'chats', 'no-project');
    await mkdir(chatDir, { recursive: true });
    await writeFile(path.join(chatDir, 'AGENTS.md'), 'CHAT_SERVICE_AGENTS_SHOULD_NOT_APPEAR');
    const chatWs = await store.createWorkspace({
      name: '对话',
      path: chatDir,
      kind: 'chat',
    });
    const chat = await kernel.createConversation({
      workspaceId: chatWs.id,
      workspacePath: chatDir,
      title: 'chat',
    });
    await say(kernel, store, chat, 'no project');
    const chatPrompt = (await rendered(kernel, chat.harnessId)).prompt;
    assert.equal(chatPrompt, mainPrompt({ skills }));
    assert.equal(chatPrompt.includes('Working directory:'), false);
    assert.equal(chatPrompt.includes('project_context'), false);
    assert.equal(chatPrompt.includes('CHAT_SERVICE_AGENTS_SHOULD_NOT_APPEAR'), false);
    assert.equal(chatPrompt.includes(chatDir), false);
    assert.equal(chatPrompt.includes('协作规则（Weft）'), false);
    assert.match(chatPrompt, new RegExp(`Platform: ${platformName()}`));
    assert.match(chatPrompt, /Shell: bash \(use the bash tool\)/);

    const none = await kernel.createConversation({ title: 'no-cwd' });
    await say(kernel, store, none, 'no cwd');
    const nonePrompt = (await rendered(kernel, none.harnessId)).prompt;
    assert.equal(nonePrompt, mainPrompt({ skills }));
    assert.equal(nonePrompt.includes('Working directory:'), false);
    assert.equal(nonePrompt.includes('project_context'), false);
    assert.equal(nonePrompt.includes(process.cwd()), false);
    assert.equal(nonePrompt.includes('协作规则（Weft）'), false);
    assert.match(nonePrompt, /Shell: bash \(use the bash tool\)/);
    assert.match(skills, new RegExp(`^${SKILL_LIST_INTRO}`));
    assert.match(skills, /^- commit-message: /m);
  } finally {
    if (opened) {
      await opened.kernel.close();
      opened.store.close();
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('rendered sub-agent prompt has environment and project context only', { timeout: 90000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-prompt-child-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const taskText = 'Apply the project rules and report';
  const script = path.join(dataDir, 'child.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { when: 'dispatch child', tool: 'delegate', args: { task: taskText } },
      { when: 'dispatch child', text: 'parent-done' },
      { when: taskText, text: 'CHILD_OK' },
    ],
  }));
  let opened = null;
  try {
    opened = await openKernel(dataDir, {
      WEFT_FAUX_TEXT: '',
      WEFT_FAUX_SCRIPT: script,
      WEFT_FAUX_RECORD: record,
    });
    const { store, kernel } = opened;
    const project = await makeProject(store, kernel, dataDir, 'child-ws');
    const agents = 'rules the child should see\n';
    await writeFile(path.join(project.wsPath, 'AGENTS.md'), agents);
    await say(kernel, store, project.conv, 'dispatch child');
    const parent = await rendered(kernel, project.conv.harnessId);
    assert.equal(parent.prompt.includes(PREAMBLE_TEXT), true);
    assert.equal(parent.prompt.includes('rules the child should see'), true);

    const live = await store.getConversation(project.conv.id);
    const child = (await kernel.listSubagents(live)).find((agent) => agent.mode === 'foreground');
    assert.ok(child, 'foreground child missing');
    const marker = ':sub:';
    const childId = Number(String(child.id).slice(String(child.id).lastIndexOf(marker) + marker.length));
    const childView = await rendered(kernel, childId);
    const expected = childPrompt({ cwd: project.root, project: projectBlock(agents) });
    assert.deepEqual(sectionKeys(childView.systems[0]), ['environment', 'project_context', 'instructions']);
    assert.equal(childView.prompt, expected);
    assert.equal(childView.prompt.includes(PREAMBLE_TEXT), false);
    assert.equal(childView.prompt.includes('Be concise in your responses'), false);
    assert.equal(childView.prompt.includes(SKILL_LIST_INTRO), false);
    assert.equal(childView.prompt.includes('<skills>'), false);
    assert.match(childView.prompt, /You are a subagent dispatched to complete one task independently/);

    const rows = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const parentCall = rows.find((row) => (row.tools || []).includes('delegate'));
    const childCall = rows.find((row) => (
      !(row.tools || []).includes('delegate')
      && (row.users || []).some((text) => String(text).includes(taskText))
    ));
    assert.ok(parentCall, JSON.stringify(rows.map((row) => row.tools)));
    assert.ok(childCall, JSON.stringify(rows.map((row) => row.users)));
    assert.equal(parentCall.toolDescriptions.delegate.startsWith(`${DELEGATE_LEAD} `), true);
    assert.equal(parentCall.toolDescriptions.subagent.startsWith(`${DELEGATE_LEAD} `), true);
    assert.equal(parentCall.toolDescriptions.delegate, DELEGATE_DESCRIPTION);
    assert.equal(parentCall.toolDescriptions.subagent, SUBAGENT_DESCRIPTION);
    for (const name of ['delegate', 'subagent', 'skill']) {
      assert.equal((childCall.tools || []).includes(name), false, name);
    }
    assert.equal((childCall.tools || []).includes('bash'), true);
    assert.equal((childCall.tools || []).includes('read'), true);
  } finally {
    if (opened) {
      await opened.kernel.close();
      opened.store.close();
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
