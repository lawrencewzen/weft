import type { GitConnection, GitProject, Lang, Plugin, Skill } from './types';

const PLUGIN_MAIN_MISSING: Record<Lang, string> = {
  zh: '找不到插件 main 指向的 .mjs 文件',
  en: 'The plugin main .mjs file was not found',
};

export function pluginForLang(plugin: Plugin, lang: Lang): Plugin {
  if (plugin.errorCode !== 'err_plugin_main_missing') return plugin;
  return { ...plugin, error: PLUGIN_MAIN_MISSING[lang] };
}

const HOUR = 3_600_000;

export function seedPlugins(): Plugin[] {
  return [
    {
      id: 'echo',
      name: 'echo',
      description: '把输入原样返回，用来确认插件链路是通的。',
      version: '1.0.0',
      source: 'local',
      enabled: true,
      loaded: true,
      error: null,
      errorCode: null,
      tools: [{ name: 'echo', description: '原样返回输入文本' }],
    },
    {
      id: 'word-count',
      name: 'word-count',
      description: '统计文本的行数、字数和词数。',
      version: '1.2.0',
      source: 'bundled',
      enabled: true,
      loaded: true,
      error: null,
      errorCode: null,
      tools: [{ name: 'word_count', description: '统计一段文本' }],
    },
    {
      id: 'broken-loader',
      name: 'broken-loader',
      description: '故意写坏 main 路径的示例插件，用来演示加载失败。',
      version: '0.0.1',
      source: 'local',
      enabled: true,
      loaded: false,
      error: PLUGIN_MAIN_MISSING.zh,
      errorCode: 'err_plugin_main_missing',
      tools: [],
    },
  ];
}

export function seedSkills(): Skill[] {
  return [
    {
      id: 'release-notes',
      name: '发布说明',
      description: '按提交记录整理一版中文发布说明。',
      version: '1.0.0',
      source: 'user',
      enabled: true,
      deletable: true,
    },
    {
      id: 'code-review',
      name: '代码审查',
      description: '按仓库约定检查改动，只报问题，不改代码。',
      version: '1.0.0',
      source: 'bundled',
      enabled: true,
      deletable: false,
    },
  ];
}

export function seedGitConnections(now: number): GitConnection[] {
  return [
    {
      id: 'gl-intra',
      name: '内网 GitLab',
      kind: 'gitlab-self',
      baseUrl: 'http://gitlab.intra.local',
      token: 'glpat-…4d2a',
      hasToken: true,
      allowHttp: true,
      caFile: '',
      lastTest: {
        ok: true,
        username: 'lawrence',
        error: '',
        errorText: '',
        at: new Date(now - 2 * HOUR).toISOString(),
      },
    },
    {
      id: 'gl-com',
      name: 'GitLab.com',
      kind: 'gitlab-com',
      baseUrl: 'https://gitlab.com',
      token: 'glpat-…9b2c',
      hasToken: true,
      allowHttp: false,
      caFile: '',
      lastTest: {
        ok: true,
        username: 'lawrence',
        error: '',
        errorText: '',
        at: new Date(now - 1 * HOUR).toISOString(),
      },
    },
  ];
}

export function seedGitProjects(now: number): Record<string, GitProject[]> {
  return {
    'gl-intra': [
      {
        id: 41,
        path: 'infra/weft-deploy',
        description: '内网部署脚本和 compose 文件',
        defaultBranch: 'main',
        lastActivityAt: new Date(now - 3 * HOUR).toISOString(),
        httpUrl: 'http://gitlab.intra.local/infra/weft-deploy.git',
      },
      {
        id: 42,
        path: 'tools/excel-helper',
        description: '报表导出小工具',
        defaultBranch: 'master',
        lastActivityAt: new Date(now - 26 * HOUR).toISOString(),
        httpUrl: 'http://gitlab.intra.local/tools/excel-helper.git',
      },
    ],
    'gl-com': [
      {
        id: 901,
        path: 'lawrencewzen/weft-site',
        description: 'weft 的落地页',
        defaultBranch: 'main',
        lastActivityAt: new Date(now - 12 * HOUR).toISOString(),
        httpUrl: 'https://gitlab.com/lawrencewzen/weft-site.git',
      },
    ],
  };
}

/** Branches the mock reports for a project; the default one comes from the project row. */
export function branchesOf(project: GitProject): Array<{ name: string; default: boolean }> {
  const extra = project.defaultBranch === 'master' ? ['main', 'release'] : ['develop', 'feat/landing-page'];
  return [
    { name: project.defaultBranch, default: true },
    ...extra.map((name) => ({ name, default: false })),
  ];
}

export function tokenFails(token: string): boolean {
  return String(token || '').trim().toLowerCase().startsWith('bad');
}
