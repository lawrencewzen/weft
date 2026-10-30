/** @vitest-environment jsdom */

import { act, createElement, useRef, useState, type ClipboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, uploadWorkspaceFile } from '../../data/api';
import * as attachments from '../../data/attachments';
import {
  PASTE_THRESHOLD_CHARS,
  PASTE_THRESHOLD_LINES,
  UPLOAD_MAX_BYTES,
  type ComposerHint,
} from '../../data/attachments';
import {
  useComposerAttachments,
  type UseComposerAttachmentsResult,
} from './useComposerAttachments';

vi.mock('../../data/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../data/api')>();
  return {
    ...actual,
    uploadWorkspaceFile: vi.fn(),
    getWorkspaceTree: vi.fn(),
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: UseComposerAttachmentsResult | null = null;
let latestDraft = '';
let latestHint: ComposerHint | null = null;

function pngFile(name = 'shot.png') {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

function pasteEvent(text: string): ClipboardEvent<HTMLTextAreaElement> {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      files: [],
      items: [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
  return event as unknown as ClipboardEvent<HTMLTextAreaElement>;
}

function nLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line-${i + 1}`).join('\n');
}

function Host(props: { supportsImages?: boolean; workspaceId?: string | null }) {
  const [draft, setDraft] = useState('');
  const [, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<ComposerHint | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const att = useComposerAttachments({
    lang: 'zh',
    workspaceId: props.workspaceId === undefined ? 'ws-1' : props.workspaceId,
    workspacePath: '/tmp/ws',
    supportsImages: props.supportsImages ?? true,
    allowAttach: true,
    locked: false,
    draft,
    setDraft,
    setError,
    setHint,
    textareaRef,
    onResize: () => {},
  });
  latest = att;
  latestDraft = draft;
  latestHint = hint;
  return createElement('textarea', { ref: textareaRef, value: draft, readOnly: true });
}

async function renderHost(props: { supportsImages?: boolean; workspaceId?: string | null } = {}) {
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
    root = null;
  }
  if (host && host.parentNode) {
    host.parentNode.removeChild(host);
    host = null;
  }
  latest = null;
}

describe('useComposerAttachments', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(uploadWorkspaceFile).mockReset();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(attachments, 'readAsBase64').mockResolvedValue('aGk=');
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('adds an image file', async () => {
    await renderHost();
    await act(async () => {
      await latest!.addImageFiles([pngFile('a.png')]);
    });
    expect(latest!.images).toHaveLength(1);
    expect(latest!.images[0].name).toBe('a.png');
    expect(latest!.images[0].previewUrl).toBe('blob:test-preview');
    expect(latestHint).toBeNull();
  });

  it('folds paste at the line and char thresholds', async () => {
    await renderHost();
    const short = pasteEvent(nLines(PASTE_THRESHOLD_LINES - 1));
    await act(async () => {
      latest!.onPaste(short);
    });
    expect(short.defaultPrevented).toBe(false);
    expect(latest!.pastes).toHaveLength(0);

    const longLines = pasteEvent(nLines(PASTE_THRESHOLD_LINES));
    await act(async () => {
      latest!.onPaste(longLines);
    });
    expect(longLines.defaultPrevented).toBe(true);
    expect(latest!.pastes).toHaveLength(1);
    expect(latest!.pastes[0].lines).toBe(PASTE_THRESHOLD_LINES);

    const longChars = pasteEvent('x'.repeat(PASTE_THRESHOLD_CHARS));
    await act(async () => {
      latest!.onPaste(longChars);
    });
    expect(longChars.defaultPrevented).toBe(true);
    expect(latest!.pastes).toHaveLength(2);
    expect(latest!.pastes[1].chars).toBe(PASTE_THRESHOLD_CHARS);
  });

  it('removes images, pastes, file refs and uploads', async () => {
    await renderHost();
    await act(async () => {
      await latest!.addImageFiles([pngFile('rm.png')]);
      latest!.addProjectFile('src/app.ts');
      latest!.onPaste(pasteEvent(nLines(PASTE_THRESHOLD_LINES)));
    });
    const big = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX_BYTES + 1 });
    await act(async () => {
      await latest!.uploadFiles([big]);
    });

    expect(latest!.images).toHaveLength(1);
    expect(latest!.pastes).toHaveLength(1);
    expect(latest!.fileRefs).toHaveLength(1);
    expect(latestDraft).toContain('@src/app.ts');
    expect(latest!.uploads).toHaveLength(1);

    const imageId = latest!.images[0].id;
    const pasteId = latest!.pastes[0].id;
    const uploadId = latest!.uploads[0].id;
    await act(async () => {
      latest!.removeImage(imageId);
      latest!.removePaste(pasteId);
      latest!.removeFile('src/app.ts');
      latest!.removeUpload(uploadId);
    });
    expect(latest!.images).toEqual([]);
    expect(latest!.pastes).toEqual([]);
    expect(latest!.fileRefs).toEqual([]);
    expect(latest!.uploads).toEqual([]);
    expect(latestDraft).not.toContain('@src/app.ts');
  });

  it('marks an upload as error when the request fails', async () => {
    vi.mocked(uploadWorkspaceFile).mockRejectedValueOnce(new Error('network down'));
    await renderHost();
    await act(async () => {
      await latest!.uploadFiles([new File(['hi'], 'notes.txt', { type: 'text/plain' })]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest!.uploads[0]?.status).toBe('error');
    expect(latest!.uploads[0].error).toBe('network down');
    expect(latest!.hasUploadError).toBe(true);
  });

  it('marks an oversized upload as error without calling the api', async () => {
    await renderHost();
    const big = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX_BYTES + 8 });
    await act(async () => {
      await latest!.uploadFiles([big]);
    });
    expect(uploadWorkspaceFile).not.toHaveBeenCalled();
    expect(latest!.uploads[0].status).toBe('error');
    expect(latest!.uploads[0].error).toMatch(/huge\.bin/);
  });

  it('marks 413 as too large', async () => {
    vi.mocked(uploadWorkspaceFile).mockRejectedValueOnce(new ApiError('too big', { status: 413 }));
    await renderHost();
    await act(async () => {
      await latest!.uploadFiles([new File(['hi'], 'a.txt', { type: 'text/plain' })]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest!.uploads[0]?.status).toBe('error');
    expect(latest!.uploads[0].error).toMatch(/a\.txt/);
  });

  it('reset clears attachments and revokes image previews', async () => {
    await renderHost();
    await act(async () => {
      await latest!.addImageFiles([pngFile('keep.png')]);
      latest!.addProjectFile('README.md');
      latest!.onPaste(pasteEvent(nLines(PASTE_THRESHOLD_LINES)));
    });
    expect(latest!.hasTagItems).toBe(true);
    await act(async () => {
      latest!.reset();
    });
    expect(latest!.images).toEqual([]);
    expect(latest!.fileRefs).toEqual([]);
    expect(latest!.uploads).toEqual([]);
    expect(latest!.pastes).toEqual([]);
    expect(latest!.pastePeekId).toBeNull();
    expect(latest!.dragging).toBe(false);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
