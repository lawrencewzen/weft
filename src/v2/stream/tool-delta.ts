/** Shared live-buffer helpers for SSE `tool.delta` (append / set / trimStart). */

export const TOOL_DELTA_MS = 100;

export type ToolLive = {
  text: string;
  published: string;
  timer: ReturnType<typeof setTimeout> | null;
};

export type ToolDeltaPublish =
  | { set: string }
  | { offset: number; append: string; trimStart?: number };

export function createToolLive(seed = ''): ToolLive {
  return { text: seed, published: seed, timer: null };
}

export function clearToolLiveTimer(live: ToolLive): void {
  if (!live.timer) return;
  clearTimeout(live.timer);
  live.timer = null;
}

/** Apply a kernel `tool.delta` payload onto the retained window. */
export function applyKernelToolDelta(live: ToolLive, data: Record<string, unknown>): void {
  if (typeof data.set === 'string') {
    live.text = data.set;
    return;
  }
  const trim = Number(data.trimStart);
  if (Number.isFinite(trim) && trim > 0) {
    live.text = live.text.slice(trim);
  }
  if (typeof data.append === 'string' && data.append) {
    live.text += data.append;
  }
}

/** Diff `published` → `text` into one SSE payload. `null` when nothing new. */
export function deltaFromLive(live: ToolLive): ToolDeltaPublish | null {
  const current = live.text;
  const published = live.published;
  if (current === published) return null;
  if (current.startsWith(published)) {
    return { offset: published.length, append: current.slice(published.length) };
  }
  // Trimming the entire published window is a replacement, not a prefix trim.
  for (let trimStart = 1; trimStart < published.length; trimStart += 1) {
    const rest = published.slice(trimStart);
    if (!current.startsWith(rest)) continue;
    const payload: ToolDeltaPublish = {
      offset: rest.length,
      append: current.slice(rest.length),
    };
    if (trimStart) payload.trimStart = trimStart;
    return payload;
  }
  return { set: current };
}

export function markPublished(live: ToolLive): void {
  live.published = live.text;
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function overlayToolLives<T extends { id: string; output: { preview?: string; text?: string; truncated: boolean; totalLines: number } }>(
  tools: T[],
  lives: Map<string, ToolLive>,
): T[] {
  if (!lives.size) return tools;
  return tools.map((tool) => {
    const live = lives.get(tool.id);
    if (!live) return tool;
    const preview = typeof tool.output.preview === 'string' ? tool.output.preview : '';
    return {
      ...tool,
      output: {
        ...tool.output,
        text: live.text,
        truncated: tool.output.truncated || live.text.length > preview.length,
        totalLines: lineCount(live.text) || tool.output.totalLines,
      },
    };
  });
}
