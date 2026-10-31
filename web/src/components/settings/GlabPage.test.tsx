/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitConnection, GlabSettings, GlabTestResult } from '../../data/api';
import { GlabPage } from './GlabPage';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetGlabSettings = vi.fn();
const mockPatchGlabSettings = vi.fn();
const mockDetectGlab = vi.fn();
const mockTestGlab = vi.fn();
const mockUseExtensions = vi.fn();

vi.mock('../../data/api', () => ({
  getGlabSettings: (...args: unknown[]) => mockGetGlabSettings(...args),
  patchGlabSettings: (...args: unknown[]) => mockPatchGlabSettings(...args),
  detectGlab: (...args: unknown[]) => mockDetectGlab(...args),
  testGlab: (...args: unknown[]) => mockTestGlab(...args),
}));

vi.mock('../../data/useExtensions', () => ({
  useExtensions: () => mockUseExtensions(),
}));

async function render(node: Parameters<Root['render']>[0]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
}

async function cleanup() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (host?.parentNode) host.parentNode.removeChild(host);
  host = null;
}

const SAMPLE_CONNECTIONS: GitConnection[] = [
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
      at: '2026-10-31T00:00:00Z',
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
      username: 'lawrence-cloud',
      error: '',
      errorText: '',
      at: '2026-10-31T01:00:00Z',
    },
  },
];

describe('GlabPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseExtensions.mockReturnValue({
      gitConnections: SAMPLE_CONNECTIONS,
      ready: true,
      plugins: [],
      skills: [],
      status: 'connected',
    });
  });

  afterEach(async () => {
    await cleanup();
  });

  it('开关控制连接区域禁用状态', async () => {
    let currentSettings: GlabSettings = {
      enabled: false,
      customPath: '',
      binary: {
        source: 'bundled',
        version: '1.46.1',
        path: '/usr/local/bin/glab',
      },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    };

    mockGetGlabSettings.mockImplementation(async () => currentSettings);
    mockPatchGlabSettings.mockImplementation(async (patch: Partial<GlabSettings>) => {
      currentSettings = { ...currentSettings, ...patch };
      return currentSettings;
    });

    const onToast = vi.fn();
    await render(<GlabPage lang="zh" onToast={onToast} />);

    // 关闭状态：总开关 aria-pressed=false，连接区域带 is-disabled，复选框 disabled
    const switchBtn = host!.querySelector('[data-testid="next-glab-enabled"]') as HTMLButtonElement;
    expect(switchBtn).toBeTruthy();
    expect(switchBtn.getAttribute('aria-pressed')).toBe('false');

    const connSection = host!.querySelector('.ns-glab-connections');
    expect(connSection?.classList.contains('is-disabled')).toBe(true);

    const checkboxes = host!.querySelectorAll<HTMLInputElement>('[data-testid="next-glab-conn"]');
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].disabled).toBe(true);
    expect(checkboxes[1].disabled).toBe(true);

    // 点击总开关打开
    await act(async () => {
      switchBtn.click();
    });

    expect(mockPatchGlabSettings).toHaveBeenCalledWith({ enabled: true }, 'zh');
    expect(switchBtn.getAttribute('aria-pressed')).toBe('true');
    expect(connSection?.classList.contains('is-disabled')).toBe(false);
    expect(checkboxes[0].disabled).toBe(false);
  });

  it('单选时不出现默认主机，勾选多于一个时出现默认主机单选并可切换', async () => {
    let currentSettings: GlabSettings = {
      enabled: true,
      customPath: '',
      binary: {
        source: 'bundled',
        version: '1.46.1',
        path: '/usr/local/bin/glab',
      },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    };

    mockGetGlabSettings.mockImplementation(async () => currentSettings);
    mockPatchGlabSettings.mockImplementation(async (patch: Partial<GlabSettings>) => {
      currentSettings = { ...currentSettings, ...patch };
      return currentSettings;
    });

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    // 此时只勾选了 1 个连接，不应出现默认主机单选
    let defaultRadios = host!.querySelectorAll<HTMLInputElement>('[data-testid="next-glab-default"]');
    expect(defaultRadios.length).toBe(0);

    // 勾选第二个连接
    const checkboxes = host!.querySelectorAll<HTMLInputElement>('[data-testid="next-glab-conn"]');
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);

    await act(async () => {
      checkboxes[1].click();
    });

    expect(mockPatchGlabSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionIds: ['gl-intra', 'gl-com'],
      }),
      'zh',
    );

    // 两个都勾选后，出现默认主机单选框
    defaultRadios = host!.querySelectorAll<HTMLInputElement>('[data-testid="next-glab-default"]');
    expect(defaultRadios.length).toBe(2);
    expect(defaultRadios[0].checked).toBe(true); // gl-intra is default
    expect(defaultRadios[1].checked).toBe(false);

    // 切换默认主机到 gl-com
    await act(async () => {
      defaultRadios[1].click();
    });

    expect(mockPatchGlabSettings).toHaveBeenCalledWith(
      { defaultConnectionId: 'gl-com' },
      'zh',
    );
  });

  it('无 GitLab 连接时显示空状态与跳转按钮', async () => {
    mockUseExtensions.mockReturnValue({
      gitConnections: [
        {
          id: 'other-srv',
          name: '其他 Git 服务',
          kind: 'other',
          baseUrl: 'https://gitea.example.com',
          token: '',
          hasToken: false,
          allowHttp: false,
          caFile: '',
          lastTest: null,
        },
      ],
      ready: true,
      plugins: [],
      skills: [],
      status: 'connected',
    });

    mockGetGlabSettings.mockResolvedValue({
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: [],
      defaultConnectionId: null,
    });

    const onNavigate = vi.fn();
    await render(<GlabPage lang="zh" onToast={vi.fn()} onNavigate={onNavigate} />);

    const emptyBlock = host!.querySelector('[data-testid="next-glab-empty"]');
    expect(emptyBlock).toBeTruthy();
    expect(emptyBlock!.textContent).toContain('未配置 GitLab 连接');

    const gotoBtn = host!.querySelector('[data-testid="next-glab-goto-git"]') as HTMLButtonElement;
    expect(gotoBtn).toBeTruthy();

    await act(async () => {
      gotoBtn.click();
    });

    expect(onNavigate).toHaveBeenCalledWith('git');
  });

  it('测试按钮运行测试并正确显示成功或失败结果', async () => {
    mockGetGlabSettings.mockResolvedValue({
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    });

    mockTestGlab.mockResolvedValueOnce({
      ok: true,
      host: 'gitlab.intra.local',
      username: 'lawrence',
      output: 'Logged in to gitlab.intra.local as lawrence',
    } satisfies GlabTestResult);

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    const testBtn = host!.querySelector('[data-testid="next-glab-test"]') as HTMLButtonElement;
    expect(testBtn).toBeTruthy();
    expect(testBtn.disabled).toBe(false);

    // 点击测试，测试成功
    await act(async () => {
      testBtn.click();
    });

    expect(mockTestGlab).toHaveBeenCalledWith('zh');
    let resultBox = host!.querySelector('[data-testid="next-glab-test-result"]');
    expect(resultBox).toBeTruthy();
    expect(resultBox!.classList.contains('is-ok')).toBe(true);
    expect(resultBox!.textContent).toContain('lawrence @ gitlab.intra.local');

    // 模拟测试失败
    mockTestGlab.mockResolvedValueOnce({
      ok: false,
      host: 'gitlab.intra.local',
      username: '',
      output: 'Token expired or revoked',
    } satisfies GlabTestResult);

    await act(async () => {
      testBtn.click();
    });

    resultBox = host!.querySelector('[data-testid="next-glab-test-result"]');
    expect(resultBox).toBeTruthy();
    expect(resultBox!.classList.contains('is-ok')).toBe(false);
    expect(resultBox!.textContent).toContain('Token expired or revoked');
  });

  it('展开自定义路径并点击检测', async () => {
    let currentSettings: GlabSettings = {
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: [],
      defaultConnectionId: null,
    };

    mockGetGlabSettings.mockImplementation(async () => currentSettings);
    mockPatchGlabSettings.mockImplementation(async (patch: Partial<GlabSettings>) => {
      currentSettings = { ...currentSettings, ...patch };
      return currentSettings;
    });
    mockDetectGlab.mockImplementation(async () => {
      currentSettings.binary = {
        source: 'custom',
        version: '1.46.1',
        path: currentSettings.customPath,
      };
      return currentSettings;
    });

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    // 默认折叠，没有自定义路径输入框
    let pathInput = host!.querySelector<HTMLInputElement>('[data-testid="next-glab-path"]');
    expect(pathInput).toBeNull();

    // 点击展开
    const toggleBtn = host!.querySelector('.ns-adv-toggle') as HTMLButtonElement;
    await act(async () => {
      toggleBtn.click();
    });

    pathInput = host!.querySelector<HTMLInputElement>('[data-testid="next-glab-path"]');
    expect(pathInput).toBeTruthy();

    // 输入自定义路径
    await act(async () => {
      pathInput!.value = '/opt/glab/bin/glab';
      pathInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // 点击检测
    const detectBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-glab-detect"]');
    await act(async () => {
      detectBtn!.click();
    });

    expect(mockDetectGlab).toHaveBeenCalled();
  });
});
