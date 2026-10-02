'use strict';
/**
 * History log v2: what a clean asked for and what really happened to each item.
 *
 * A clean writes a 'started' entry before anything is deleted and replaces it
 * with the finished one afterwards. If Spaci dies in between, the next launch
 * turns the leftover 'started' entry into 'interrupted', so the log never
 * claims a clean finished when it did not. Entries written before v2 (no `v`)
 * are kept untouched; the renderer reads both.
 *
 * Pure: no fs, no Electron. main.js reads and writes the file.
 */

const HISTORY_VERSION = 2;
const MAX_ENTRIES = 200;
const MAX_ITEMS = 1000;

const OUTCOMES = new Set(['removed', 'trashed', 'failed', 'refused']);
const KINDS = new Set(['artifact', 'cache', 'file', 'trash', 'other']);
const REVERSIBLE = new Set(['rebuild', 'trash', 'none']);

const INTERRUPTED_REASON = 'Spaci closed before this finished. It may be partly removed.';

function bytesOf(n) {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** One history item, with every field forced into its allowed set. */
function buildItem(src = {}) {
  const item = {
    path: String(src.path || ''),
    kind: KINDS.has(src.kind) ? src.kind : 'other',
    outcome: OUTCOMES.has(src.outcome) ? src.outcome : 'failed',
    bytes: bytesOf(src.bytes),
    reversible: REVERSIBLE.has(src.reversible) ? src.reversible : 'none',
  };
  if (src.project) item.project = String(src.project);
  if (src.reason) item.reason = String(src.reason);
  if (src.code) item.code = String(src.code);
  // Cleaned by the tool's own command: what ran and how it exited.
  if (typeof src.command === 'string' && src.command) item.command = src.command.slice(0, 200);
  if (Number.isInteger(src.exitCode)) item.exitCode = src.exitCode;
  if (src.via === 'native' || src.via === 'stop-then-folder' || src.via === 'folder') item.via = src.via;
  // Only part of it moved (an auto-clean roll back that could not finish).
  if (src.partial === true) item.partial = true;
  // Refused items were never touched, so there is nothing to restore. A failed
  // item may be partly gone, and the same command rebuilds it.
  if (src.restoreHint && item.outcome !== 'refused') item.restoreHint = String(src.restoreHint);
  return item;
}

/**
 * Tally items. count is what Spaci actually removed or trashed, never the
 * number of jobs it was allowed to try.
 */
function tally(items) {
  let count = 0, failedCount = 0, refusedCount = 0, freed = 0, trashedBytes = 0;
  for (const it of items) {
    if (it.outcome === 'removed' || it.outcome === 'trashed') count++;
    else if (it.outcome === 'failed') failedCount++;
    else if (it.outcome === 'refused') refusedCount++;
    // Trashed files still occupy the disk until the Trash is emptied, so they
    // are tallied apart and never counted as freed.
    if (it.outcome === 'trashed') { trashedBytes += it.bytes || 0; continue; }
    // A failed job may still have freed part of its tree; that space is real.
    freed += it.bytes || 0;
  }
  return { count, failedCount, refusedCount, freed, trashedBytes };
}

function capItems(items) {
  if (items.length <= MAX_ITEMS) return { items };
  return { items: items.slice(0, MAX_ITEMS), itemsTruncated: items.length - MAX_ITEMS };
}

/**
 * The entry written before deleting. `pending` lists what is about to be
 * cleaned, so an interrupted clean can still say what it was working on.
 */
function startedEntry({ id, at, scope, label, requested, refused = [], pending = [] }) {
  const items = refused.map((r) => buildItem({ ...r, outcome: 'refused' }));
  const pend = pending.map((p) => buildItem({ ...p, outcome: 'failed', bytes: 0 }));
  const entry = {
    v: HISTORY_VERSION, id: String(id), at, status: 'started',
    scope: scope || 'projects', label: label || '',
    requested: Number.isFinite(requested) ? requested : items.length + pend.length,
    ...tally(items),
    ...capItems(items),
    // incompleteReason: what an interruption means for this item (a
    // non-atomic native command: "Incomplete: run the clean again ...").
    pending: pend.slice(0, MAX_ITEMS).map(({ path, kind, reversible, project }, i) => {
      const why = pending[i] && typeof pending[i].incompleteReason === 'string' ? pending[i].incompleteReason.slice(0, 300) : null;
      return { path, kind, reversible, ...(project ? { project } : {}), ...(why ? { incompleteReason: why } : {}) };
    }),
  };
  return entry;
}

/** The finished entry that replaces the 'started' one. */
function finishedEntry({ id, at, finishedAt, status = 'done', scope, label, requested, items = [], extra = {} }) {
  const built = items.map(buildItem);
  return {
    v: HISTORY_VERSION, id: String(id), at, finishedAt,
    status: status === 'interrupted' ? 'interrupted' : 'done',
    scope: scope || 'projects', label: label || '',
    requested: Number.isFinite(requested) ? requested : built.length,
    ...tally(built),
    ...capItems(built),
    ...extra,
  };
}

/**
 * A 'started' entry that never finished: its pending items become failed
 * with an honest reason, and the counts are recomputed.
 */
function interruptEntry(entry, now) {
  const done = Array.isArray(entry.items) ? entry.items : [];
  const pend = (Array.isArray(entry.pending) ? entry.pending : [])
    .map((p) => buildItem({ ...p, outcome: 'failed', bytes: 0, reason: p.incompleteReason || INTERRUPTED_REASON }));
  const items = [...done, ...pend];
  const next = { ...entry, status: 'interrupted', finishedAt: entry.finishedAt || now, ...tally(items), ...capItems(items) };
  if (!next.itemsTruncated) delete next.itemsTruncated;
  delete next.pending;
  return next;
}

/** On launch: every entry still 'started' becomes 'interrupted'. Returns { history, changed }. */
function markInterrupted(history, now = Date.now()) {
  if (!Array.isArray(history)) return { history: [], changed: false };
  let changed = false;
  const out = history.map((e) => {
    if (e && e.v === HISTORY_VERSION && e.status === 'started') { changed = true; return interruptEntry(e, now); }
    return e;
  });
  return { history: out, changed };
}

/** Put `entry` in place of the entry with the same id, or on top. Keeps MAX_ENTRIES. */
function upsertEntry(history, entry, max = MAX_ENTRIES) {
  const list = Array.isArray(history) ? history.slice() : [];
  const idx = entry && entry.id != null ? list.findIndex((e) => e && e.id === entry.id) : -1;
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);
  return list.slice(0, max);
}

/**
 * A Docker prune. Docker reports only the total, so there are no items.
 * spec: the PRUNE_KINDS entry. restoreHint: from restore-hints.dockerRestoreHint.
 */
function dockerEntry({ id, at, finishedAt, spec, freed, restoreHint }) {
  const entry = {
    v: HISTORY_VERSION, id: String(id), at, finishedAt: finishedAt || at, status: 'done',
    scope: 'docker', label: (spec && spec.name) || 'Docker',
    requested: 1, count: 1, failedCount: 0, refusedCount: 0,
    freed: bytesOf(freed), items: [],
    // An explicit reversible flag wins; older specs without one fall back to safe.
    reversible: (spec && (typeof spec.reversible === 'boolean' ? spec.reversible : spec.safe)) ? 'rebuild' : 'none',
  };
  if (restoreHint) entry.restoreHint = restoreHint;
  return entry;
}

/**
 * One Docker volume removed with `docker volume rm`. Permanent: a volume holds
 * data nothing can rebuild, so reversible is 'none' and there is no hint.
 * bytes is the size Docker reported for it in the listing the user confirmed.
 */
function dockerVolumeEntry({ id, at, finishedAt, name, project = null, bytes }) {
  const item = buildItem({ path: `docker volume ${name}`, kind: 'other', outcome: 'removed', bytes, reversible: 'none', project: project || undefined });
  return {
    v: HISTORY_VERSION, id: String(id), at, finishedAt: finishedAt || at, status: 'done',
    scope: 'docker', label: `Docker volume ${name}`,
    requested: 1, ...tally([item]), items: [item],
    reversible: 'none',
  };
}

module.exports = {
  HISTORY_VERSION, MAX_ENTRIES, MAX_ITEMS, INTERRUPTED_REASON,
  buildItem, tally, startedEntry, finishedEntry, interruptEntry, markInterrupted, upsertEntry, dockerEntry, dockerVolumeEntry,
};
