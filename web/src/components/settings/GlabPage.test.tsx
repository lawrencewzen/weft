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
    vi.useFakeTimers();
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
    vi.useRealTimers();
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
    await act(async () => {
      vi.advanceTimersByTime(500);
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
    await act(async () => {
      vi.advanceTimersByTime(500);
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
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(mockDetectGlab).toHaveBeenCalled();
  });

  it('PATCH 挂起时，点击 checkbox 后立即为 checked', async () => {
    mockGetGlabSettings.mockResolvedValue({
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: [],
      defaultConnectionId: null,
    });
    mockPatchGlabSettings.mockReturnValue(new Promise(() => {}));

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    const checkboxes = host!.querySelectorAll<HTMLInputElement>('[data-testid="next-glab-conn"]');
    expect(checkboxes[0].checked).toBe(false);

    await act(async () => {
      checkboxes[0].click();
    });

    expect(checkboxes[0].checked).toBe(true);
  });

  it('PATCH 失败时回滚为未勾选并调用 onToast', async () => {
    mockGetGlabSettings.mockResolvedValue({
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: [],
      defaultConnectionId: null,
    });
    mockPatchGlabSettings.mockRejectedValue(new Error('网络请求失败'));

    const onToast = vi.fn();
    await render(<GlabPage lang="zh" onToast={onToast} />);

    const checkboxes = host!.querySelectorAll<HTMLInputElement>('[data-testid="next-glab-conn"]');
    expect(checkboxes[0].checked).toBe(false);

    await act(async () => {
      checkboxes[0].click();
    });

    expect(checkboxes[0].checked).toBe(false);
    expect(onToast).toHaveBeenCalledWith('网络请求失败');
  });

  it('detectGlab 立即 resolve：499ms 时仍是「检测中…」，500ms 后变「✓ 已检测」，再 1500ms 恢复「检测」', async () => {
    const currentSettings: GlabSettings = {
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    };

    mockGetGlabSettings.mockResolvedValue(currentSettings);
    mockDetectGlab.mockResolvedValue(currentSettings);

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    const detectBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-glab-detect"]')!;
    expect(detectBtn.textContent).toBe('检测');
    expect(detectBtn.disabled).toBe(false);

    // 点击检测
    await act(async () => {
      detectBtn.click();
    });

    // 刚点击后处于检测中
    expect(detectBtn.textContent).toBe('正在检测…');
    expect(detectBtn.disabled).toBe(true);

    // 499ms 时仍是「检测中…」
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(detectBtn.textContent).toBe('正在检测…');
    expect(detectBtn.disabled).toBe(true);

    // 500ms 后变「✓ 已检测」并处于禁用状态
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(detectBtn.textContent).toBe('✓ 已检测');
    expect(detectBtn.disabled).toBe(true);

    // 1499ms（未满 1500ms）仍为「✓ 已检测」
    await act(async () => {
      vi.advanceTimersByTime(1499);
    });
    expect(detectBtn.textContent).toBe('✓ 已检测');
    expect(detectBtn.disabled).toBe(true);

    // 满 1500ms 后恢复「检测」并解除禁用
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(detectBtn.textContent).toBe('检测');
    expect(detectBtn.disabled).toBe(false);
  });

  it('检测结果为缺失时不出现「✓ 已检测」', async () => {
    const currentSettings: GlabSettings = {
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    };

    mockGetGlabSettings.mockResolvedValue(currentSettings);
    mockDetectGlab.mockResolvedValue({
      ...currentSettings,
      binary: { source: 'missing', version: '', path: '' },
    });

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    const detectBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-glab-detect"]')!;

    await act(async () => {
      detectBtn.click();
    });

    expect(detectBtn.textContent).toBe('正在检测…');

    // 500ms 后直接恢复「检测」，不出现「✓ 已检测」
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(detectBtn.textContent).toBe('检测');
    expect(detectBtn.disabled).toBe(false);

    // 再过 1500ms 依然是「检测」
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(detectBtn.textContent).toBe('检测');
  });

  it('testGlab 立即 resolve：499ms 时仍是「测试中…」', async () => {
    mockGetGlabSettings.mockResolvedValue({
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    });

    mockTestGlab.mockResolvedValue({
      ok: true,
      host: 'gitlab.intra.local',
      username: 'lawrence',
      output: '',
    });

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    const testBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-glab-test"]')!;
    expect(testBtn.disabled).toBe(false);

    await act(async () => {
      testBtn.click();
    });

    // 499ms 时仍是「测试中…」且禁用，未显示结果卡片
    await act(async () => {
      vi.advanceTimersByTime(499);
    });
    expect(testBtn.textContent).toBe('正在测试…');
    expect(testBtn.disabled).toBe(true);
    expect(host!.querySelector('[data-testid="next-glab-test-result"]')).toBeNull();

    // 500ms 后变为「测试」，解除禁用并显示结果
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(testBtn.textContent).toBe('测试');
    expect(testBtn.disabled).toBe(false);
    expect(host!.querySelector('[data-testid="next-glab-test-result"]')).toBeTruthy();
  });

  it('500ms 内卸载组件不报错、无 React 警告', async () => {
    const errorSpy = vi.spyOn(console, 'error');
    const warnSpy = vi.spyOn(console, 'warn');

    mockGetGlabSettings.mockResolvedValue({
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    });
    mockDetectGlab.mockResolvedValue({
      enabled: true,
      customPath: '',
      binary: { source: 'bundled', version: '1.46.1', path: '/usr/local/bin/glab' },
      connectionIds: ['gl-intra'],
      defaultConnectionId: 'gl-intra',
    });

    await render(<GlabPage lang="zh" onToast={vi.fn()} />);

    const detectBtn = host!.querySelector<HTMLButtonElement>('[data-testid="next-glab-detect"]')!;
    await act(async () => {
      detectBtn.click();
    });

    // 运行 200ms 后卸载
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    await cleanup();

    // 继续推移时间越过 500ms 和 1500ms
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    // 确认没有 setState 警告或未捕获错误
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
