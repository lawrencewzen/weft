/** Shared live-buffer helpers for SSE `text.delta` (append-only coalesce). */

export const TEXT_DELTA_MS = 50;

export type TextLive = {
  text: string;
  published: number;
  timer: unknown;
};

export type TextDeltaPublish = { offset: number; append: string };

export function createTextLive(seed = ''): TextLive {
  return { text: seed, published: seed.length, timer: null };
}

export function publishedText(live: TextLive): string {
  return live.text.slice(0, live.published);
}

export function unpublishedText(live: TextLive): string {
  return live.text.slice(live.published);
}

export function clearTextLiveTimer(
  live: TextLive,
  cancel: (handle: unknown) => void = (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
): void {
  if (live.timer == null) return;
  cancel(live.timer);
  live.timer = null;
}

/** Diff `published` → `text` into one SSE payload. `null` when nothing new. */
export function takeTextDelta(live: TextLive): TextDeltaPublish | null {
  const append = live.text.slice(live.published);
  if (!append) return null;
  const offset = live.published;
  live.published = live.text.length;
  return { offset, append };
}
