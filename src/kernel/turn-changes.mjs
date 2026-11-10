// Per-turn file list for the thread card.
// The right pane stays the cumulative worktree diff. A turn stores the
// difference between that cumulative list at the start of the run and at
// the end, in the conversation document TurnChanges. Bash and subagent
// edits are in the worktree, so they show up here even when tool details
// have no path. Conversations that never recorded a turn have no card.
import { defineDoc } from '@earendil-works/pi-durable';
import { TURN_CHANGES_DOC_KIND } from './ids.mjs';

export const TurnChanges = defineDoc({
  kind: TURN_CHANGES_DOC_KIND,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => true,
  initial: () => ({ pending: null, turns: [] }),
});

export function turnChangesItemId(anchorId) {
  return `tc-${String(anchorId ?? '')}`;
}

function normPath(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function plainBy(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.kind === 'main') return { kind: 'main' };
  if (value.kind === 'subagent') {
    const agentId = String(value.agentId ?? '');
    const name = String(value.name ?? '');
    if (!agentId) return null;
    return { kind: 'subagent', agentId, name };
  }
  return null;
}

/** Contract Change, minus fields the row does not have. */
export function plainChange(row) {
  if (!row || typeof row !== 'object') return null;
  const filePath = normPath(row.path);
  if (!filePath) return null;
  const view = {
    path: filePath,
    added: num(row.added),
    removed: num(row.removed),
    error: row.error == null || row.error === '' ? null : String(row.error),
    by: plainBy(row.by),
  };
  if (row.status === 'added' || row.status === 'modified' || row.status === 'deleted' || row.status === 'renamed') {
    view.status = row.status;
    view.oldPath = row.status === 'renamed' && row.oldPath ? normPath(row.oldPath) : null;
  }
  return view;
}

export function plainChanges(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    const view = plainChange(row);
    if (!view || seen.has(view.path)) continue;
    seen.add(view.path);
    out.push(view);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function signature(row) {
  return [
    num(row?.added),
    num(row?.removed),
    row?.error == null ? '' : String(row.error),
    row?.status == null ? '' : String(row.status),
    normPath(row?.oldPath),
  ].join('\0');
}

/**
 * Files whose cumulative change row differs between two snapshots.
 * New paths keep their counts. A further edit uses the non-negative
 * difference of the line counts. A path that returned to the session
 * baseline is listed as this turn undoing it.
 */
export function diffChangeRows(before, after) {
  const beforeMap = new Map();
  for (const row of before || []) {
    const view = plainChange(row);
    if (view && !beforeMap.has(view.path)) beforeMap.set(view.path, view);
  }
  const afterMap = new Map();
  for (const row of after || []) {
    const view = plainChange(row);
    if (view && !afterMap.has(view.path)) afterMap.set(view.path, view);
  }
  const out = [];
  for (const [filePath, row] of afterMap) {
    const prev = beforeMap.get(filePath);
    if (!prev) {
      out.push(row);
      continue;
    }
    if (signature(prev) === signature(row)) continue;
    const added = num(row.added) - num(prev.added);
    const removed = num(row.removed) - num(prev.removed);
    if (added >= 0 && removed >= 0 && (added !== 0 || removed !== 0)) {
      out.push({ ...row, added, removed });
      continue;
    }
    out.push(row);
  }
  for (const [filePath, prev] of beforeMap) {
    if (afterMap.has(filePath)) continue;
    const undone = {
      path: filePath,
      added: num(prev.removed),
      removed: num(prev.added),
      error: null,
      by: null,
    };
    if (prev.status === 'added') {
      undone.status = 'deleted';
      undone.oldPath = null;
    } else if (prev.status) {
      undone.status = 'modified';
      undone.oldPath = null;
    }
    out.push(undone);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export function hasPendingBaseline(state) {
  const pending = state?.pending;
  return Boolean(pending) && typeof pending === 'object';
}

/**
 * Assistant entry the card hangs on. The run's answer wins when that
 * message is visible. Otherwise the last assistant after the user entry
 * that opened the turn.
 */
export function pickTurnAnchor(messages, userEntryId, preferred) {
  const want = preferred == null || preferred === '' ? '' : String(preferred);
  if (want) {
    const hit = (messages || []).find((message) => (
      String(message?.id ?? '') === want
      && message?.role === 'assistant'
      && String(message?.text || '').trim()
    ));
    if (hit) return want;
  }
  const since = userEntryId == null || userEntryId === '' ? null : Number(userEntryId);
  let last = '';
  for (const message of messages || []) {
    if (message?.role !== 'assistant' || !String(message?.text || '').trim()) continue;
    const id = String(message?.id ?? '');
    if (!id) continue;
    const n = Number(id);
    if (since != null && Number.isFinite(since) && Number.isFinite(n) && n <= since) continue;
    last = id;
  }
  return last;
}

export function normalizeStoredTurns(state) {
  if (!state || !Array.isArray(state.turns)) return [];
  const out = [];
  const seen = new Set();
  for (const row of state.turns) {
    if (!row || typeof row !== 'object') continue;
    const anchorId = row.anchorId == null ? '' : String(row.anchorId);
    if (!anchorId || seen.has(anchorId)) continue;
    const changes = plainChanges(row.changes);
    if (!changes.length) continue;
    seen.add(anchorId);
    out.push({
      id: row.id == null || row.id === '' ? turnChangesItemId(anchorId) : String(row.id),
      anchorId,
      changes,
    });
  }
  return out;
}
