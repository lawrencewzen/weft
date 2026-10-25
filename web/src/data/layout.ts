export const LEFT_OVERLAY_MAX = 860;
export const LEFT_W_MIN = 200;
export const LEFT_W_MAX = 420;
export const LEFT_W_DEFAULT = 264;

export const LS_LEFT_OPEN = 'weft_next_left_open';
export const LS_LEFT_W = 'weft_next_left_w';
export const LS_OPEN_WORKSPACES = 'weft_next_open_workspaces';
export const LS_ACTIVE_WS = 'weft_next_active_ws';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function readPref(key: string, fallback: boolean): boolean {
  const raw = storage()?.getItem(key);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

export function writePref(key: string, value: boolean): void {
  try {
    storage()?.setItem(key, String(value));
  } catch {
    /* ignore quota */
  }
}

export function readLeftWidth(): number {
  const raw = Number(storage()?.getItem(LS_LEFT_W));
  return clampNum(Number.isFinite(raw) ? raw : LEFT_W_DEFAULT, LEFT_W_MIN, LEFT_W_MAX);
}

export function writeLeftWidth(width: number): void {
  try {
    storage()?.setItem(LS_LEFT_W, String(clampNum(width, LEFT_W_MIN, LEFT_W_MAX)));
  } catch {
    /* ignore quota */
  }
}

export function isOverlayWidth(width: number): boolean {
  return width <= LEFT_OVERLAY_MAX;
}

export function defaultLeftOpen(viewportWidth: number): boolean {
  if (isOverlayWidth(viewportWidth)) return false;
  return readPref(LS_LEFT_OPEN, true);
}

export function persistLeftOpen(open: boolean, viewportWidth: number): void {
  if (!isOverlayWidth(viewportWidth)) writePref(LS_LEFT_OPEN, open);
}

export function readOpenWorkspaces(): string[] {
  try {
    const raw = storage()?.getItem(LS_OPEN_WORKSPACES);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeOpenWorkspaces(ids: Iterable<string>): void {
  try {
    storage()?.setItem(LS_OPEN_WORKSPACES, JSON.stringify([...ids]));
  } catch {
    /* ignore quota */
  }
}

export function readActiveWorkspace(): string | null {
  return storage()?.getItem(LS_ACTIVE_WS) || null;
}

export function writeActiveWorkspace(id: string | null): void {
  try {
    const slot = storage();
    if (!slot) return;
    if (id) slot.setItem(LS_ACTIVE_WS, id);
    else slot.removeItem(LS_ACTIVE_WS);
  } catch {
    /* ignore quota */
  }
}
