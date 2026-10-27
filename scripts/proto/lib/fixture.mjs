// Prototype fixtures: the workspaces, conversations, and files every captured
// state uses. Titles and file contents are fixed so two runs produce the same
// HTML.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { api } from '../../../tests/e2e/helpers/server.mjs';

const execFileP = promisify(execFile);

const PROTOTYPE_MD = [
  '# 原型截取',
  '',
  '- 用演示模型跑真实网页端',
  '- 用 Playwright 存 DOM 和 CSS',
  '- 输出单文件 HTML',
  '',
].join('\n');

const ARCHITECTURE_MD = [
  '# 架构',
  '',
  '对话和任务都交给 Pi Durable Harness；应用只保留视图和最近一次提交的 id。',
  '',
  '## 分层',
  '',
  '1. `src/kernel/`：Harness 适配、工具、子 Agent',
  '2. `src/v2/`：对外协议和视图模型',
  '3. `web/`：新网页端',
  '',
].join('\n');

const README_MD = [
  '# weft',
  '',
  '网页版个人 Agent。对话运行时是 Pi Durable Harness，应用数据在 SQLite。',
  '',
  '## 启动',
  '',
  '```bash',
  'npm ci',
  'npm start',
  '```',
  '',
].join('\n');

const COMPOSER_TSX = [
  "import { useState } from 'react';",
  '',
  'export function Composer(props: { onSend: (text: string) => void }) {',
  '  const [draft, setDraft] = useState(\'\');',
  '  return (',
  '    <footer className="center-composer">',
  '      <div className="composer-box">',
  '        <textarea',
  '          className="composer-textarea"',
  '          value={draft}',
  '          onChange={(event) => setDraft(event.target.value)}',
  '        />',
  '        <div className="composer-bar">',
  '          <button type="button" className="btn-send" onClick={() => props.onSend(draft)}>',
  '            发送',
  '          </button>',
  '        </div>',
  '      </div>',
  '    </footer>',
  '  );',
  '}',
  '',
].join('\n');

/** Workspaces shown in the sidebar. `key` is used by states, `name` on screen. */
export const WORKSPACES = [
  {
    key: 'weft',
    name: 'weft',
    files: {
      'README.md': README_MD,
      'docs/ARCHITECTURE.md': ARCHITECTURE_MD,
      'src/App.tsx': [
        "import { AppShell } from './components/AppShell';",
        '',
        'export function App() {',
        '  return <AppShell />;',
        '}',
        '',
      ].join('\n'),
      'src/components/Composer.tsx': COMPOSER_TSX,
      'src/components/Sidebar.tsx': 'export function Sidebar() {\n  return null;\n}\n',
      'web/vite.config.ts': "import { defineConfig } from 'vite';\n\nexport default defineConfig({});\n",
    },
    conversations: [
      { key: 'demo', title: '网页端原型截取' },
      { key: 'long', title: '重跑全部单元测试' },
      { key: 'tools', title: '排查构建失败' },
      { key: 'agents', title: '子 Agent 协作' },
      { key: 'settings', title: '设置面板间距' },
      { key: 'export', title: '导出对话为 Markdown' },
    ],
  },
  {
    key: 'website',
    name: 'website',
    files: {
      'index.html': '<!DOCTYPE html>\n<html lang="zh-CN">\n  <body>\n    <h1>weft</h1>\n  </body>\n</html>\n',
      'styles/main.css': 'body {\n  margin: 0;\n  font-family: system-ui;\n}\n',
    },
    conversations: [
      { key: 'landing', title: '首页改版方案' },
    ],
  },
];

/** The state that needs a server with no model configured uses this workspace. */
export const BARE_WORKSPACE = { key: 'sandbox', name: 'sandbox', files: {}, conversations: [{ key: 'bare', title: '没有模型的对话' }] };

async function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keeps the status bar on this workspace instead of the repo the temp dir sits in. */
async function initRepo(dir) {
  const run = (args) => execFileP('git', args, { cwd: dir, windowsHide: true, timeout: 20000 });
  const who = ['-c', 'user.name=weft', '-c', 'user.email=weft@test'];
  try {
    await run(['init', '-b', 'main']);
    await run([...who, 'add', '-A']);
    await run([...who, 'commit', '-m', 'init', '--no-gpg-sign']);
  } catch (err) {
    console.warn(`\n  ! ${path.basename(dir)} 初始化 git 失败（状态栏会没有分支信息）：${err.message}`);
  }
}

async function seed(srv, specs) {
  const map = { ws: {}, conv: {}, dir: {}, name: {}, order: [] };
  for (const spec of specs) {
    await writeFiles(spec.dir, spec.files);
    await initRepo(spec.dir);
    const ws = await api(srv.url, 'POST', '/workspaces', { name: spec.name, path: spec.dir });
    if (ws.status !== 201) throw new Error(`创建工作区 ${spec.name} 失败: ${ws.status}`);
    map.ws[spec.key] = ws.body.id;
    map.dir[spec.key] = spec.dir;
    map.name[spec.key] = spec.name;
    map.order.push({ kind: 'ws', id: ws.body.id });
    for (const conv of spec.conversations) {
      const created = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, {
        title: conv.title,
      });
      if (created.status !== 201) throw new Error(`创建对话 ${conv.title} 失败: ${created.status}`);
      map.conv[conv.key] = created.body.id;
      map.order.push({ kind: 'conv', id: created.body.id });
      // Keep `updatedAt` apart so the sidebar order is the creation order.
      await sleep(40);
    }
  }
  return map;
}

/** Seed the full sidebar for the demo server. */
export function seedMain(srv, prepared) {
  return seed(srv, WORKSPACES.map((spec, index) => ({ ...spec, dir: prepared.dirs[index] })));
}

/** Seed the bare server (no provider configured) in its own directory. */
export function seedBare(srv, prepared) {
  return seed(srv, [{ ...BARE_WORKSPACE, dir: prepared.dirs[1] }]);
}

/** Stable replacement for one captured id: ws/conv/agent ids become readable names. */
export function idAliases(map) {
  const aliases = [];
  const wsByKey = Object.entries(map.ws);
  for (const [key] of wsByKey) aliases.push([map.ws[key], `ws-${key}`]);
  for (const [key] of Object.entries(map.conv)) aliases.push([map.conv[key], `conv-${key}`]);
  return aliases;
}
