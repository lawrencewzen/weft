// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change } from './store';
import type { RightPaneValue } from './rightPaneContext';

/**
 * Regression tests for the right-pane diff effect (T50-B).
 *
 * `store.changes(cid)` returns a fresh array on every call. The provider used to
 * read it during render without memoizing, so `visibleChanges` got a new identity
 * on every render. The diff effect depends on `visibleChanges`, so it re-ran on
 * every render; while a diff was still loading that started the same request
 * again, and a fast answer kept the loop alive (84 duplicate `/diff` requests for
 * one click in the prototype).
 *
 * These tests pin both halves of the fix: a stable `visibleChanges` identity for
 * unrelated renders, and at most one in-flight request per path + signature.
 */

const hoisted = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('./session', () => ({
  useSession: () => hoisted.session,
}));

// Imported after the mock so the provider picks up the fake session.
import { RightPaneProvider, useRightPane } from './rightPaneContext';

type FakeStore = {
  changes: (cid: string) => Change[];
  toolsById: (cid: string) => Record<string, never>;
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
  bump: () => void;
};

function fakeStore(rows: Change[]): FakeStore {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    // Same shape as the real store: a fresh array per call.
    changes: () => rows.slice(),
    toolsById: () => ({}),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    bump() {
      version += 1;
      for (const listener of listeners) listener();
    },
  };
}

const CHANGES: Change[] = [
  { path: 'web/src/data/store.ts', added: 18, removed: 6, error: null, by: { kind: 'main' } },
  { path: 'web/src/data/store.test.ts', added: 64, removed: 0, error: null, by: { kind: 'subagent', agentId: 'c1:sub:1', name: 'scout' } },
];

const DIFF = {
  path: 'web/src/data/store.ts',
  added: 1,
  removed: 1,
  tooLarge: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        { op: 'ctx', text: 'function items(cid) {', oldLine: 1, newLine: 1 },
        { op: 'del', text: '  return ids.map(get);', oldLine: 2, newLine: null },
        { op: 'add', text: '  return ids.map(get).filter(Boolean);', oldLine: null, newLine: 2 },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root | null = null;
let latest: RightPaneValue | null = null;
let seenChanges: Change[][] = [];

function Probe() {
  latest = useRightPane();
  seenChanges.push(latest.visibleChanges);
  return null;
}

function renderProvider(store: FakeStore, cid: string) {
  hoisted.session = { store };
  return act(async () => {
    root = createRoot(container);
    root.render(createElement(RightPaneProvider, {
      conversationId: cid,
      workspaceId: 'ws-weft',
      lang: 'zh',
      onToast: () => {},
      children: createElement(Probe),
    }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  seenChanges = [];
  localStorage.clear();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container.remove();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('RightPaneProvider diff effect', () => {
  it('keeps visibleChanges identity across a render that does not touch the store', async () => {
    const store = fakeStore(CHANGES);
    await renderProvider(store, 'c1');
    const before = latest?.visibleChanges;
    expect(before).toHaveLength(2);

    // Local UI state (draft text, open paths, diffs) must not rebuild the change list.
    await act(async () => {
      latest?.setDraftText('half-typed edit');
    });

    expect(latest?.visibleChanges).toBe(before);
  });

  it('issues one diff request per path while the response is in flight', async () => {
    const store = fakeStore(CHANGES);
    let calls = 0;
    const resolve: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.includes('/diff')) {
        return new Promise<Response>((settle) => {
          resolve.push(() => settle(new Response(JSON.stringify(DIFF), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })));
        });
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }));

    await renderProvider(store, 'c1');
    // Changes default to expanded (<= 8 files, <= 300 lines), so each file initiates 1 diff request on mount.
    expect(calls).toBe(2);

    // An unrelated store upsert re-runs the effect while the diff is loading.
    await act(async () => {
      store.bump();
    });
    expect(calls).toBe(2);

    await act(async () => {
      for (const settle of resolve.splice(0)) settle();
    });
    expect(latest?.diffs['web/src/data/store.ts']).toMatchObject({ path: 'web/src/data/store.ts' });

    // Once loaded, further store updates must not re-request the same signature.
    await act(async () => {
      store.bump();
    });
    expect(calls).toBe(2);
  });

  it('default-expands diffs for <= 8 files with <= 300 changed lines', async () => {
    const store = fakeStore(CHANGES);
    await renderProvider(store, 'c1');
    expect(latest?.openPaths.has('web/src/data/store.ts')).toBe(true);
    expect(latest?.openPaths.has('web/src/data/store.test.ts')).toBe(true);

    // Clicking file pill collapses it
    await act(async () => {
      latest?.toggleChange('web/src/data/store.ts');
    });
    expect(latest?.openPaths.has('web/src/data/store.ts')).toBe(false);
  });

  it('defaults to collapsed when visibleChanges > 8 files', async () => {
    const manyChanges: Change[] = Array.from({ length: 9 }, (_, i) => ({
      path: `file-${i}.ts`,
      added: 5,
      removed: 2,
      error: null,
      by: null,
    }));
    const store = fakeStore(manyChanges);
    await renderProvider(store, 'c1');
    expect(latest?.openPaths.size).toBe(0);
  });

  it('defaults to collapsed for a single file with > 300 lines', async () => {
    const bigChanges: Change[] = [
      { path: 'small.ts', added: 10, removed: 5, error: null, by: null },
      { path: 'big.ts', added: 250, removed: 60, error: null, by: null }, // 310 > 300
    ];
    const store = fakeStore(bigChanges);
    await renderProvider(store, 'c1');
    expect(latest?.openPaths.has('small.ts')).toBe(true);
    expect(latest?.openPaths.has('big.ts')).toBe(false);
  });
});
