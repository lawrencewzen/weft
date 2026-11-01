export type PathChipRef = {
  path: string;
  line?: number;
};

/**
 * Read only data-path / data-line from a Markdown path chip.
 * Callers must pass `path` to GET /api/v2/workspaces/{id}/files — never build
 * another URL from the attribute.
 */
export function pathChipFromElement(el: Element | null | undefined): PathChipRef | null {
  if (!el || !(el instanceof Element)) return null;
  const chip = el.closest('.md-path');
  if (!chip) return null;
  const path = chip.getAttribute('data-path');
  if (path == null || path === '') return null;
  const raw = chip.getAttribute('data-line');
  const line = raw == null || raw === '' ? undefined : Number(raw);
  if (line != null && Number.isFinite(line) && line >= 1) return { path, line };
  return { path };
}

export function pathChipFromEvent(target: EventTarget | null | undefined): PathChipRef | null {
  return pathChipFromElement(target instanceof Element ? target : null);
}

const FILE_API = /\/api\/v2\/workspaces\/[^/]+\/files(?:\?|$)/;

/** True when a request is the workspace file endpoint (the only allowed destination for a chip click). */
export function isWorkspaceFileRequest(url: string): boolean {
  try {
    const parsed = new URL(url, 'http://weft.local');
    return FILE_API.test(parsed.pathname + (parsed.search ? '?' : ''));
  } catch {
    return FILE_API.test(url);
  }
}
