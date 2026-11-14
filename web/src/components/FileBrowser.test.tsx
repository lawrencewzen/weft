/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBrowser } from './FileBrowser';
import { IDLE_SAVE } from '../data/fileConflict';
import * as rightPaneContext from '../data/rightPaneContext';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

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
  if (host && host.parentNode) {
    host.parentNode.removeChild(host);
    host = null;
  }
}

describe('FileBrowser tree rows', () => {
  const toggleDirMock = vi.fn();
  const openFileMock = vi.fn();

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
    toggleDirMock.mockReset();
    openFileMock.mockReset();

    vi.spyOn(rightPaneContext, 'useRightChanges').mockReturnValue({
      conversationId: 'c1',
      hasChanges: false,
      visibleChanges: [],
      totals: { added: 0, removed: 0 },
      diffs: {},
      openPaths: new Set(),
      toggleChange: vi.fn(),
    });

    vi.spyOn(rightPaneContext, 'useRightActions').mockReturnValue({
      openFile: openFileMock,
      openChangeDiff: vi.fn(),
      showFiles: vi.fn(),
      copyPath: vi.fn(),
      openInTerminal: vi.fn(async () => {}),
      onToast: vi.fn(),
    });

    vi.spyOn(rightPaneContext, 'useRightFiles').mockReturnValue({
      workspaceId: 'ws-test',
      tree: [
        { path: 'package.json', type: 'file' },
        { path: 'secret.log', type: 'file', ignored: true },
        { path: 'dist', type: 'dir', ignored: true },
        { path: 'dist/bundle.js', type: 'file' },
        { path: 'src', type: 'dir' },
        { path: 'src/main.ts', type: 'file' },
      ],
      treeTruncated: false,
      treeReady: true,
      expandedDirs: new Set(['dist', 'src']),
      toggleDirectory: toggleDirMock,
      file: null,
      activeFilePath: 'secret.log',
      editorMode: 'preview',
      setEditorMode: vi.fn(),
      draftText: '',
      setDraftText: vi.fn(),
      saveFile: vi.fn(async () => {}),
      saveState: IDLE_SAVE,
      reloadFile: vi.fn(async () => {}),
      fileTargetLine: null,
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('adds is-ignored class only to ignored rows, and retains active class when active', async () => {
    await render(<FileBrowser lang="zh" workspaceLabel="test-workspace" />);

    const packageJson = host!.querySelector('[data-testid="next-file-node"][data-path="package.json"]') as HTMLElement;
    expect(packageJson).not.toBeNull();
    expect(packageJson.classList.contains('is-ignored')).toBe(false);

    const srcDir = host!.querySelector('[data-testid="next-file-node"][data-path="src"]') as HTMLElement;
    expect(srcDir).not.toBeNull();
    expect(srcDir.classList.contains('is-ignored')).toBe(false);

    const srcMain = host!.querySelector('[data-testid="next-file-node"][data-path="src/main.ts"]') as HTMLElement;
    expect(srcMain).not.toBeNull();
    expect(srcMain.classList.contains('is-ignored')).toBe(false);

    // Ignored file
    const secretLog = host!.querySelector('[data-testid="next-file-node"][data-path="secret.log"]') as HTMLElement;
    expect(secretLog).not.toBeNull();
    expect(secretLog.classList.contains('is-ignored')).toBe(true);
    // Active ignored file also has active class
    expect(secretLog.classList.contains('active')).toBe(true);

    // Ignored directory
    const distDir = host!.querySelector('[data-testid="next-file-node"][data-path="dist"]') as HTMLElement;
    expect(distDir).not.toBeNull();
    expect(distDir.classList.contains('is-ignored')).toBe(true);

    // Subitem under ignored directory inherits is-ignored
    const distBundle = host!.querySelector('[data-testid="next-file-node"][data-path="dist/bundle.js"]') as HTMLElement;
    expect(distBundle).not.toBeNull();
    expect(distBundle.classList.contains('is-ignored')).toBe(true);
  });

  it('clicking rows triggers select callbacks', async () => {
    await render(<FileBrowser lang="zh" workspaceLabel="test-workspace" />);

    const secretLog = host!.querySelector('[data-testid="next-file-node"][data-path="secret.log"]') as HTMLElement;
    await act(async () => {
      secretLog.click();
    });
    expect(openFileMock).toHaveBeenCalledWith('secret.log');

    const distDir = host!.querySelector('[data-testid="next-file-node"][data-path="dist"]') as HTMLElement;
    await act(async () => {
      distDir.click();
    });
    expect(toggleDirMock).toHaveBeenCalledWith('dist');
  });

  it('renders no-workspace placeholder instead of loading state when workspaceId is null', async () => {
    vi.spyOn(rightPaneContext, 'useRightFiles').mockReturnValue({
      workspaceId: null,
      tree: [],
      treeTruncated: false,
      treeReady: false,
      expandedDirs: new Set(),
      toggleDirectory: toggleDirMock,
      file: null,
      activeFilePath: null,
      editorMode: 'preview',
      setEditorMode: vi.fn(),
      draftText: '',
      setDraftText: vi.fn(),
      saveFile: vi.fn(async () => {}),
      saveState: IDLE_SAVE,
      reloadFile: vi.fn(async () => {}),
      fileTargetLine: null,
    });

    await render(<FileBrowser lang="zh" workspaceLabel="" />);

    const placeholder = host!.querySelector('[data-testid="next-file-no-workspace"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toBe('暂未选择项目');
    expect(host!.querySelector('[data-testid="next-file-tree"]')).toBeNull();
    expect(host!.textContent).not.toContain('正在读取文件');
  });
});
