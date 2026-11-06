// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SystemNote } from './SystemNote';
import type { components } from '../../../src/v2/contract.gen';

type Item = components['schemas']['ThreadItemSystemNote'];

describe('SystemNote (T105-2)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
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
  });

  it('always uses next-item-system-note and does not use next-auto-continue-note', async () => {
    const item: Item = {
      kind: 'system_note',
      id: 'sn-1',
      text: '系统提示说明',
      noteKind: 'note',
    };

    await act(async () => {
      root!.render(<SystemNote item={item} />);
    });

    const el = host!.querySelector('[data-testid="next-item-system-note"]');
    expect(el).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-auto-continue-note"]')).toBeNull();
  });
});
