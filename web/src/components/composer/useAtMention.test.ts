/** @vitest-environment jsdom */

import { act, createElement, useRef, useState, type KeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getWorkspaceTree } from '../../data/api';
import { AtMentionMenu } from './AtMentionMenu';
import { useAtMention, type UseAtMentionResult } from './useAtMention';

vi.mock('../../data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/api')>();
  return {
    ...actual,
    getWorkspaceTree: vi.fn(),
  };
});

const TREE_FILES = [
  'README.md',
  'web/src/data/store.ts',
  'web/src/data/store.test.ts',
  'web/src/styles/app.css',
  'src/kernel/index.mjs',
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: {
  at: UseAtMentionResult;
  draft: string;
  setDraft: (value: string) => void;
  setFocused: (value: boolean) => void;
  fileRefs: string[];
} | null = null;

function Host(props: { workspaceId?: string | null; locked?: boolean }) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRefs = useRef<string[]>([]);
  const at = useAtMention({
    workspaceId: props.workspaceId === undefined ? 'ws-1' : props.workspaceId,
    draft,
    setDraft,
    locked: props.locked ?? false,
    focused,
    setFocused,
    textareaRef,
    onResize: () => {},
    addFileRef: (relPath) => {
      fileRefs.current.push(relPath);
    },
    addProjectFile: (relPath) => {
      fileRefs.current.push(`project:${relPath}`);
      setDraft((current) => `${current} @${relPath} `.trimStart());
    },
  });
  latest = {
    at,
    draft,
    setDraft,
    setFocused,
    fileRefs: fileRefs.current,
  };
  return createElement(
    'div',
    null,
    at.atOpen
      ? createElement(AtMentionMenu, {
          lang: 'zh',
          treeError: at.treeError,
          treeLoading: at.treeLoading,
          matchedFiles: at.matchedFiles,
          atActiveIndex: at.atActiveIndex,
          onPick: at.pickAtFile,
        })
      : null,
    createElement('textarea', { ref: textareaRef, value: draft, readOnly: true }),
  );
}

async function renderHost(props: { workspaceId?: string | null; locked?: boolean } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(Host, props));
  });
}

async function cleanup() {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  if (host && host.parentNode) {
    host.parentNode.removeChild(host);
  }
  root = null;
  host = null;
  latest = null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function keyEvent(key: string): KeyboardEvent<HTMLTextAreaElement> {
  const native = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  Object.defineProperty(native, 'nativeEvent', { value: { isComposing: false } });
  Object.defineProperty(native, 'keyCode', { value: key === 'Enter' || key === 'Tab' ? 13 : 0 });
  return native as unknown as KeyboardEvent<HTMLTextAreaElement>;
}

async function openAt(query = '') {
  await act(async () => {
    latest!.setDraft(`@${query}`);
    latest!.at.setCursorPos(query.length + 1);
    latest!.setFocused(true);
  });
  await flush();
}

describe('useAtMention', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(getWorkspaceTree).mockReset();
    vi.mocked(getWorkspaceTree).mockResolvedValue({
      entries: [
        ...TREE_FILES.map((path) => ({ path, type: 'file' as const })),
        { path: 'src', type: 'dir' },
      ],
      truncated: false,
    });
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('opens the @ menu when the cursor sits after a trigger', async () => {
    await renderHost();
    expect(latest!.at.atOpen).toBe(false);
    await openAt();
    expect(latest!.at.atOpen).toBe(true);
    expect(latest!.at.matchedFiles).toEqual(TREE_FILES);
    expect(host!.querySelector('[data-testid="next-composer-at-menu"]')).not.toBeNull();
  });

  it('does not trigger when the cursor is not in an @ token', async () => {
    await renderHost();
    await act(async () => {
      latest!.setDraft('hello @file');
      latest!.at.setCursorPos(4);
    });
    await flush();
    expect(latest!.at.atOpen).toBe(false);
    expect(latest!.at.matchedFiles).toEqual([]);
  });

  it('filters files by the query after @', async () => {
    await renderHost();
    await openAt('store');
    expect(latest!.at.matchedFiles).toEqual([
      'web/src/data/store.ts',
      'web/src/data/store.test.ts',
    ]);
    const items = [...host!.querySelectorAll('[data-testid="next-composer-at-item"]')];
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining('store.ts'),
      expect.stringContaining('store.test.ts'),
    ]);
  });

  it('moves the active index with ArrowDown and ArrowUp and wraps', async () => {
    await renderHost();
    await openAt('store');
    expect(latest!.at.atActiveIndex).toBe(0);
    await act(async () => {
      latest!.at.handleKeyDown(keyEvent('ArrowDown'));
    });
    expect(latest!.at.atActiveIndex).toBe(1);
    await act(async () => {
      latest!.at.handleKeyDown(keyEvent('ArrowDown'));
    });
    expect(latest!.at.atActiveIndex).toBe(0);
    await act(async () => {
      latest!.at.handleKeyDown(keyEvent('ArrowUp'));
    });
    expect(latest!.at.atActiveIndex).toBe(1);
  });

  it('inserts the active file on Enter and advances the cursor', async () => {
    await renderHost();
    await openAt('store');
    await act(async () => {
      latest!.at.handleKeyDown(keyEvent('ArrowDown'));
    });
    await act(async () => {
      latest!.at.handleKeyDown(keyEvent('Enter'));
    });
    expect(latest!.draft).toBe('@web/src/data/store.test.ts ');
    expect(latest!.at.cursorPos).toBe('@web/src/data/store.test.ts '.length);
    expect(latest!.fileRefs).toEqual(['web/src/data/store.test.ts']);
    expect(latest!.at.atOpen).toBe(false);
  });

  it('closes the menu on Escape without inserting', async () => {
    await renderHost();
    await openAt('store');
    await act(async () => {
      latest!.at.handleKeyDown(keyEvent('Escape'));
    });
    expect(latest!.at.atOpen).toBe(false);
    expect(latest!.draft).toBe('@store');
    expect(host!.querySelector('[data-testid="next-composer-at-menu"]')).toBeNull();
  });

  it('tracks cursorPos and uses it to compute the trigger', async () => {
    await renderHost();
    await act(async () => {
      latest!.setDraft('see @app and more');
      latest!.at.setCursorPos(7);
    });
    await flush();
    expect(latest!.at.cursorPos).toBe(7);
    expect(latest!.at.atOpen).toBe(true);
    expect(latest!.at.matchedFiles).toEqual(['web/src/styles/app.css']);
    await act(async () => {
      latest!.at.setCursorPos(0);
    });
    expect(latest!.at.atOpen).toBe(false);
  });

  it('insertFileAt drops @ at the cursor so the menu can open', async () => {
    await renderHost();
    await act(async () => {
      latest!.at.insertFileAt();
    });
    await flush();
    expect(latest!.draft).toBe('@');
    expect(latest!.at.cursorPos).toBe(1);
    expect(latest!.at.atOpen).toBe(true);
  });
});
