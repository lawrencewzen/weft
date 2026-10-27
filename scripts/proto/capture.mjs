#!/usr/bin/env node
/**
 * 从真实网页端截取原型。
 *
 * 用演示模型（faux script）把真实服务和新网页端跑起来，用 Playwright 把每个状态的
 * DOM 存下来，和应用 CSS 一起写成单文件 `design/prototype/index.html`。
 * 状态定义在 `states/`，还没实现的设计提案在 `proposals/`，规则见 README。
 *
 * 前提：先跑过 `npm run build:web`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { prepareWorkspaces, startServer } from '../../tests/e2e/helpers/server.mjs';
import { createProviderModels, loginNext } from '../../tests/e2e/helpers/next.mjs';
import { seedBare, seedMain, idAliases } from './lib/fixture.mjs';
import { assertSelfContained, buildDocument, inlineAssets } from './lib/html.mjs';
import { convUrl, draftUrl, normalizeHtml, openPage, readRoot, typeAndSend } from './lib/page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'design', 'prototype');
const OUT_FILE = path.join(OUT_DIR, 'index.html');
const STATE_FILES = ['chat.mjs', 'agents.mjs', 'panes.mjs', 'composer.mjs'];
const VIEWPORT = { width: 1440, height: 900 };
const CONTEXT_WINDOW = '200000';

async function loadModule(file) {
  return import(pathToFileURL(file).href);
}

async function readStates() {
  const states = [];
  for (const name of STATE_FILES) {
    const mod = await loadModule(path.join(ROOT, 'scripts', 'proto', 'states', name));
    const list = mod.states || mod.default;
    if (!Array.isArray(list)) throw new Error(`states/${name} 没有导出 states 数组`);
    for (const state of list) states.push(state);
  }
  return states;
}

async function readProposals() {
  const dir = path.join(ROOT, 'scripts', 'proto', 'proposals');
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.mjs')).sort();
  const proposals = [];
  for (const name of names) {
    const mod = await loadModule(path.join(dir, name));
    const proposal = mod.proposal || mod.default;
    if (!proposal) throw new Error(`proposals/${name} 没有导出 proposal`);
    proposals.push(proposal);
  }
  return proposals;
}

function checkDefinition(item) {
  for (const field of ['id', 'title', 'note']) {
    if (!item[field]) throw new Error(`状态定义缺少 ${field}: ${JSON.stringify(item.id || item)}`);
  }
  if (typeof item.prepare !== 'function' && typeof item.apply !== 'function') {
    throw new Error(`状态 ${item.id} 缺少 prepare()`);
  }
}

/**
 * A conversation's script is indexed by its assistant-message count, so a second
 * user turn has to start at that index. `runs` therefore pads earlier slots with
 * empty turns; they are never picked, they just keep the next run aligned.
 */
function stateRuns(state) {
  if (Array.isArray(state.runs)) return state.runs;
  if (state.script) return [{ send: state.send, script: state.script }];
  return [];
}

/** 每条没有 `when` 的 turn 归到发起它的那句 user 消息，多个对话共用一个剧本文件。 */
function buildTurns(states) {
  const turns = [];
  for (const state of states) {
    let used = 0;
    for (const run of stateRuns(state)) {
      if (!run.send) throw new Error(`状态 ${state.id} 的 run 缺少 send`);
      for (let i = 0; i < used; i += 1) turns.push({ when: run.send, end: true });
      for (const turn of run.script || []) {
        const next = { ...turn };
        if (next.when == null) next.when = run.send;
        turns.push(next);
      }
      used += (run.script || []).length;
    }
  }
  return turns;
}

async function readAppCss() {
  const dir = path.join(ROOT, 'public-next', 'assets');
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.css')).sort();
  if (!names.length) throw new Error('public-next/assets 里没有 CSS，先跑 npm run build:web');
  const parts = [];
  for (const name of names) parts.push(await fs.readFile(path.join(dir, name), 'utf8'));
  return parts.join('\n');
}

function createContext(session, prepared) {
  const { srv, page, fx } = session;
  const roots = [[prepared.root, '/work']];
  for (const [key, dir] of Object.entries(fx.dir)) roots.push([dir, `/work/${fx.name[key] || key}`]);
  roots.push([srv.dataDir, '/weft-data']);
  return {
    session,
    srv,
    page,
    fx,
    openConv: (key) => openPage(page, convUrl(srv, fx.conv[key])),
    openDraft: (wsKey) => openPage(page, draftUrl(srv, fx.ws[wsKey])),
    send: (text) => typeAndSend(page, text),
    async capture() {
      const html = await readRoot(page);
      return inlineAssets(normalizeHtml(html, { roots, aliases: session.aliases }), ROOT);
    },
  };
}

async function main() {
  const started = Date.now();
  const buildIndex = path.join(ROOT, 'public-next', 'index.html');
  if (!(await fs.stat(buildIndex).catch(() => null))) {
    throw new Error('找不到 public-next/index.html，先运行 npm run build:web');
  }

  const appCss = await readAppCss();
  const states = await readStates();
  for (const state of states) checkDefinition(state);

  const ids = new Set();
  for (const state of states) {
    if (ids.has(state.id)) throw new Error(`状态 id 重复: ${state.id}`);
    ids.add(state.id);
  }

  const proposals = await readProposals();
  for (const proposal of proposals) {
    checkDefinition(proposal);
    if (!ids.has(proposal.base)) throw new Error(`提案 ${proposal.id} 指向不存在的基线 ${proposal.base}`);
    if (ids.has(proposal.id)) throw new Error(`提案 id 和基线重复: ${proposal.id}`);
    ids.add(proposal.id);
    proposal.group = 'proposal';
    proposal.prepare = async (ctx) => {
      await states.find((state) => state.id === proposal.base).prepare(ctx);
      await proposal.apply(ctx);
    };
  }

  const prepared = await prepareWorkspaces(['weft', 'website']);
  const scriptPath = path.join(prepared.root, 'proto-script.json');
  await fs.writeFile(scriptPath, `${JSON.stringify({ turns: buildTurns(states) }, null, 2)}\n`);

  const browser = await chromium.launch();
  const sessions = new Map();
  const killAll = [];

  async function startSession(key) {
    const baseEnv = { WEFT_WORKSPACE_ROOT: prepared.root };
    let srv;
    let fx;
    if (key === 'bare') {
      srv = await startServer({
        extraEnv: { ...baseEnv, WEFT_LLM: '', LLM_API: '', WEFT_FAUX_SCRIPT: '' },
      });
      fx = await seedBare(srv, prepared);
    } else if (key === 'main') {
      srv = await startServer({
        script: 'basic.json',
        extraEnv: {
          ...baseEnv,
          WEFT_FAUX_SCRIPT: scriptPath,
          LLM_CONTEXT_WINDOW: CONTEXT_WINDOW,
        },
      });
      fx = await seedMain(srv, prepared);
      await createProviderModels(srv, { contextWindow: Number(CONTEXT_WINDOW) });
    } else {
      throw new Error(`未知的 server: ${key}`);
    }
    killAll.push(srv);
    const context = await browser.newContext({ viewport: VIEWPORT, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await loginNext(page, srv);
    const session = { srv, page, context, fx, aliases: idAliases(fx) };
    return session;
  }

  const getSession = async (key) => {
    if (!sessions.has(key)) sessions.set(key, startSession(key));
    return sessions.get(key);
  };

  const results = [];
  try {
    for (const state of [...states, ...proposals]) {
      const serverKey = state.server || 'main';
      const session = await getSession(serverKey);
      const ctx = createContext(session, prepared);
      const label = `${state.id.padEnd(18)}`;
      process.stdout.write(`· ${label}`);
      try {
        await state.prepare(ctx);
      } catch (err) {
        throw new Error(`状态 ${state.id} 准备失败：${err.message}`);
      }
      let html;
      try {
        html = await ctx.capture();
      } catch (err) {
        throw new Error(`状态 ${state.id} 截取失败：${err.message}`);
      }
      assertSelfContained(html, state.id);
      results.push({
        id: state.id,
        title: state.title,
        note: state.note,
        group: state.group === 'proposal' ? 'proposal' : 'baseline',
        html,
      });
      process.stdout.write(`ok ${(html.length / 1024).toFixed(0)}KB\n`);
    }
  } finally {
    await browser.close().catch(() => {});
    for (const srv of killAll) await srv.kill().catch(() => {});
  }

  const proposalCss = proposals
    .filter((proposal) => proposal.css)
    .map((proposal) => `/* ===== 提案 ${proposal.id}（未实现） ===== */\n${proposal.css}`)
    .join('\n');
  const doc = buildDocument({ css: `${appCss}\n${proposalCss}`, states: results });
  assertSelfContained(doc, '原型文件');
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_FILE, doc);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${results.length} 个状态 → design/prototype/index.html（${(doc.length / 1024).toFixed(0)}KB，${seconds}s）`);
}

main().catch((err) => {
  console.error(`\n截取失败：${err.message}`);
  process.exitCode = 1;
});
