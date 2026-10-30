export const LEFT_OVERLAY_MAX = 860;
export const LEFT_W_MIN = 200;
export const LEFT_W_MAX = 420;
export const LEFT_W_DEFAULT = 264;

export const RIGHT_OVERLAY_MAX = 1180;
export const RIGHT_W_MIN = 320;
export const RIGHT_W_MAX = 900;
export const RIGHT_W_DEFAULT = 440;

export const LS_LEFT_OPEN = 'weft_next_left_open';
export const LS_LEFT_W = 'weft_next_left_w';
export const LS_OPEN_WORKSPACES = 'weft_next_open_workspaces';
export const LS_WORKSPACE_OPEN = 'weft_next_workspace_open';
export const LS_SUBAGENT_TREES = 'weft_next_subagent_trees';
export const LS_ACTIVE_WS = 'weft_next_active_ws';
export const LS_RIGHT_OPEN = 'weft_next_right_open';
export const LS_RIGHT_W = 'weft_next_right_w';
export const LS_RIGHT_TAB = 'weft_next_right_tab';

export type OpenRecord = Record<string, boolean>;

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
  const raw = storage()?.getItem(LS_LEFT_W);
  if (raw == null || raw === '') return LEFT_W_DEFAULT;
  const n = Number(raw);
  return clampNum(Number.isFinite(n) ? n : LEFT_W_DEFAULT, LEFT_W_MIN, LEFT_W_MAX);
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

export function isRightOverlayWidth(width: number): boolean {
  return width < RIGHT_OVERLAY_MAX;
}

export function defaultLeftOpen(viewportWidth: number): boolean {
  if (isOverlayWidth(viewportWidth)) return false;
  return readPref(LS_LEFT_OPEN, true);
}

export function persistLeftOpen(open: boolean, viewportWidth: number): void {
  if (!isOverlayWidth(viewportWidth)) writePref(LS_LEFT_OPEN, open);
}

export function readRightWidth(): number {
  const raw = storage()?.getItem(LS_RIGHT_W);
  if (raw == null || raw === '') return RIGHT_W_DEFAULT;
  const n = Number(raw);
  return clampNum(Number.isFinite(n) ? n : RIGHT_W_DEFAULT, RIGHT_W_MIN, RIGHT_W_MAX);
}

export function writeRightWidth(width: number): void {
  try {
    storage()?.setItem(LS_RIGHT_W, String(clampNum(width, RIGHT_W_MIN, RIGHT_W_MAX)));
  } catch {
    /* ignore quota */
  }
}

export function defaultRightOpen(viewportWidth: number): boolean {
  if (isRightOverlayWidth(viewportWidth)) return false;
  return readPref(LS_RIGHT_OPEN, true);
}

export function persistRightOpen(open: boolean, viewportWidth: number): void {
  if (!isRightOverlayWidth(viewportWidth)) writePref(LS_RIGHT_OPEN, open);
}

export type RightTab = 'changes' | 'files' | 'term' | 'subagents';

const RIGHT_TABS = new Set<RightTab>(['changes', 'files', 'term']);

export function readRightTab(): RightTab {
  const raw = storage()?.getItem(LS_RIGHT_TAB);
  return RIGHT_TABS.has(raw as RightTab) ? (raw as RightTab) : 'changes';
}

export function writeRightTab(tab: RightTab): void {
  try {
    storage()?.setItem(LS_RIGHT_TAB, tab);
  } catch {
    /* ignore quota */
  }
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

export function readBoolRecord(key: string): OpenRecord {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: OpenRecord = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeBoolRecord(key: string, record: OpenRecord): void {
  try {
    storage()?.setItem(key, JSON.stringify(record));
  } catch {
    /* ignore quota */
  }
}

export function readWorkspaceOpen(): OpenRecord {
  return readBoolRecord(LS_WORKSPACE_OPEN);
}

export function writeWorkspaceOpen(record: OpenRecord): void {
  writeBoolRecord(LS_WORKSPACE_OPEN, record);
}

export function readSubagentTrees(): OpenRecord {
  return readBoolRecord(LS_SUBAGENT_TREES);
}

export function writeSubagentTrees(record: OpenRecord): void {
  writeBoolRecord(LS_SUBAGENT_TREES, record);
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
