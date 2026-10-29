export const CONV_LAST_OPENED_STORAGE_KEY = 'weft_conv_last_opened';

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readLastOpenedMap(): Record<string, number> {
  try {
    const s = storage();
    if (!s) return {};
    const raw = s.getItem(CONV_LAST_OPENED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, number>;
    }
  } catch {
    // Fail gracefully: storage error -> no unread
  }
  return {};
}

export function writeLastOpened(convId: string, timestamp = Date.now()): void {
  try {
    const s = storage();
    if (!s || !convId) return;
    const map = readLastOpenedMap();
    map[convId] = timestamp;
    s.setItem(CONV_LAST_OPENED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Fail gracefully
  }
}

export function isConversationUnread(
  conv: { id: string; updatedAt?: number | string | null },
  activeConversationId: string | null,
  lastOpenedMap: Record<string, number>,
): boolean {
  if (!conv || !conv.id) return false;
  if (conv.id === activeConversationId) return false;
  const updated = Number(conv.updatedAt) || 0;
  if (updated <= 0) return false;
  const opened = lastOpenedMap[conv.id];
  if (typeof opened !== 'number' || !Number.isFinite(opened)) return false;
  return updated > opened;
}
