/** @vitest-environment jsdom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  FileRefAttachment,
  ImageAttachment,
  PasteAttachment,
  UploadAttachment,
} from '../../data/attachments';
import { ComposerTags, type ComposerTagsProps } from './ComposerTags';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const image: ImageAttachment = {
  id: 'img-1',
  kind: 'image',
  name: 'shot.png',
  size: 2048,
  mediaType: 'image/png',
  data: 'abc',
  previewUrl: 'blob:shot',
};

const fileRef: FileRefAttachment = {
  id: 'file-src/app.ts',
  kind: 'file',
  path: 'src/app.ts',
};

const uploadDone: UploadAttachment = {
  id: 'up-1',
  kind: 'upload',
  name: 'notes.txt',
  size: 12,
  status: 'done',
  uploaded: { path: 'uploads/notes.txt', name: 'notes.txt', bytes: 12, mediaType: 'text/plain' },
};

const uploadError: UploadAttachment = {
  id: 'up-err',
  kind: 'upload',
  name: 'big.bin',
  size: 99,
  status: 'error',
  error: 'big.bin 超过 20MB，不能发送',
};

const paste: PasteAttachment = {
  id: 'paste-1',
  kind: 'paste',
  text: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight',
  lines: 8,
  chars: 40,
  name: 'one',
};

function tagsProps(overrides: Partial<ComposerTagsProps> = {}): ComposerTagsProps {
  return {
    lang: 'zh',
    images: [],
    visibleFileRefs: [],
    uploads: [],
    pastes: [],
    pastePeekId: null,
    setPastePeekId: vi.fn(),
    removeImage: vi.fn(),
    removeUpload: vi.fn(),
    removePaste: vi.fn(),
    removeFile: vi.fn(),
    restorePaste: vi.fn(),
    ...overrides,
  };
}

async function render(props: ComposerTagsProps) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(ComposerTags, props));
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

describe('ComposerTags', () => {
  afterEach(async () => {
    await cleanup();
  });

  it('renders image, file, upload and paste tags', async () => {
    await render(tagsProps({
      images: [image],
      visibleFileRefs: [fileRef],
      uploads: [uploadDone, uploadError],
      pastes: [paste],
    }));

    const img = host!.querySelector('[data-testid="next-attach-image"]');
    expect(img).not.toBeNull();
    expect(img?.textContent).toContain('shot.png');
    expect(host!.querySelector('.composer-tag-thumb')?.getAttribute('src')).toBe('blob:shot');

    const file = host!.querySelector('[data-testid="next-attach-file"]');
    expect(file?.textContent).toContain('src/app.ts');

    const uploadTags = host!.querySelectorAll('[data-testid="next-attach-upload"]');
    expect(uploadTags).toHaveLength(2);
    expect(uploadTags[0].getAttribute('data-status')).toBe('done');
    expect(uploadTags[1].getAttribute('data-status')).toBe('error');
    expect(host!.querySelector('[data-testid="next-upload-error"]')?.textContent).toContain('big.bin');

    const pasteTag = host!.querySelector('[data-testid="next-attach-paste"]');
    expect(pasteTag?.textContent).toContain('one');
    expect(pasteTag?.textContent).toContain('8 行');
    expect(host!.querySelector('[data-testid="next-paste-peek"]')).toBeNull();
  });

  it('shows paste peek when pastePeekId matches and restore calls restorePaste', async () => {
    const restorePaste = vi.fn();
    await render(tagsProps({
      pastes: [paste],
      pastePeekId: paste.id,
      restorePaste,
    }));
    const peek = host!.querySelector('[data-testid="next-paste-peek"]');
    expect(peek).not.toBeNull();
    expect(host!.querySelector('[data-testid="next-paste-peek-head"]')?.textContent).toContain('one');

    await act(async () => {
      host!.querySelector('[data-testid="next-paste-peek-restore"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(restorePaste).toHaveBeenCalledWith(paste.id);
  });

  it('remove buttons call the matching handlers', async () => {
    const removeImage = vi.fn();
    const removeFile = vi.fn();
    const removeUpload = vi.fn();
    const removePaste = vi.fn();
    await render(tagsProps({
      images: [image],
      visibleFileRefs: [fileRef],
      uploads: [uploadDone],
      pastes: [paste],
      removeImage,
      removeFile,
      removeUpload,
      removePaste,
    }));

    const buttons = [...host!.querySelectorAll('[data-testid="next-attach-remove"]')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(4);
    await act(async () => {
      buttons[0].click();
      buttons[1].click();
      buttons[2].click();
      buttons[3].click();
    });
    expect(removeImage).toHaveBeenCalledWith('img-1');
    expect(removeFile).toHaveBeenCalledWith('src/app.ts');
    expect(removeUpload).toHaveBeenCalledWith('up-1');
    expect(removePaste).toHaveBeenCalledWith('paste-1');
  });
});
