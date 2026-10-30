/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlusMenu, type PlusMenuProps } from './PlusMenu';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function menuProps(overrides: Partial<PlusMenuProps> = {}): PlusMenuProps {
  return {
    lang: 'zh',
    locked: false,
    supportsImages: true,
    setHint: vi.fn(),
    addImageFiles: vi.fn(),
    uploadFiles: vi.fn(),
    insertFileAt: vi.fn(),
    ...overrides,
  };
}

async function render(props: PlusMenuProps) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(PlusMenu, props));
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
}

describe('PlusMenu', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('opens the plus menu with image, file and @ items', async () => {
    await render(menuProps());
    expect(host!.querySelector('[data-testid="next-composer-plus-menu"]')).toBeNull();
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-attach"]')?.click();
    });
    const menu = host!.querySelector('[data-testid="next-composer-plus-menu"]');
    expect(menu).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-plus-image"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-plus-file"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-plus-at"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-composer-attach"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('calls insertFileAt from the @ item and closes the menu', async () => {
    const insertFileAt = vi.fn();
    await render(menuProps({ insertFileAt }));
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-attach"]')?.click();
    });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-plus-at"]')?.click();
    });
    expect(insertFileAt).toHaveBeenCalledTimes(1);
    expect(host!.querySelector('[data-testid="next-composer-plus-menu"]')).toBeNull();
  });

  it('sets a no_vision hint when picking images without vision support', async () => {
    const setHint = vi.fn() as PlusMenuProps['setHint'];
    await render(menuProps({ supportsImages: false, setHint }));
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-attach"]')?.click();
    });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-plus-image"]')?.click();
    });
    expect(setHint).toHaveBeenCalledWith({ kind: 'no_vision' });
  });

  it('clicks the hidden image input when the model supports images', async () => {
    await render(menuProps());
    const imageInput = host!.querySelector<HTMLInputElement>('[data-testid="next-composer-attach-input"]');
    const click = vi.spyOn(imageInput!, 'click');
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-attach"]')?.click();
    });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-plus-image"]')?.click();
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('disables the plus button when locked', async () => {
    await render(menuProps({ locked: true }));
    const btn = host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-attach"]');
    expect(btn?.disabled).toBe(true);
    await act(async () => {
      btn?.click();
    });
    expect(host!.querySelector('[data-testid="next-composer-plus-menu"]')).toBeNull();
  });

  it('closes on outside mousedown and Escape', async () => {
    await render(menuProps());
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-attach"]')?.click();
    });
    expect(host!.querySelector('[data-testid="next-composer-plus-menu"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(host!.querySelector('[data-testid="next-composer-plus-menu"]')).toBeNull();

    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="next-composer-attach"]')?.click();
    });
    expect(host!.querySelector('[data-testid="next-composer-plus-menu"]')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host!.querySelector('[data-testid="next-composer-plus-menu"]')).toBeNull();
  });
});
