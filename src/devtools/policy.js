'use strict';
/**
 * Main-process rules for removing one AI model or developer tool item.
 * Pure: main.js supplies the cached listing and writes the history.
 *
 * Order matters and mirrors docker-volumes.js:
 *   1. the user's explicit confirm, before anything else;
 *   2. the id must be in the listing main itself produced (the allowlist);
 *   3. a blocked item (loaded, running, pinned, unknown) is refused;
 * then main runs the item's paths through the clean guard, and the worker
 * re-detects the item before deleting it.
 */

const historyLog = require('../history-log');

const REFUSAL_TEXT = {
  'needs-confirmation': 'Spaci needs your confirmation for this. Nothing was removed.',
  'invalid-id': 'That is not something Spaci listed. Nothing was removed.',
  'unknown-item': 'Spaci no longer has this in its list. Check again, then retry.',
  blocked: 'Spaci left this alone.',
};

function findItem(listing, id) {
  for (const g of (listing && Array.isArray(listing.groups) ? listing.groups : [])) {
    for (const it of Array.isArray(g.items) ? g.items : []) if (it && it.id === id) return { group: g, item: it };
  }
  return null;
}

/** { ok: true, item, group } or { ok: false, error, message }. */
function removalDecision(id, opts, listing) {
  if (!opts || typeof opts !== 'object' || opts.confirmed !== true) return { ok: false, error: 'needs-confirmation', message: REFUSAL_TEXT['needs-confirmation'] };
  if (typeof id !== 'string' || !id || id.length > 4096) return { ok: false, error: 'invalid-id', message: REFUSAL_TEXT['invalid-id'] };
  const hit = findItem(listing, id);
  if (!hit) return { ok: false, error: 'unknown-item', message: REFUSAL_TEXT['unknown-item'] };
  if (hit.item.blocked) return { ok: false, error: 'blocked', message: hit.item.blocked };
  return { ok: true, item: hit.item, group: hit.group };
}

/** The history item describing this removal. */
function historyItem(item, outcome, extra = {}) {
  return {
    path: (item.paths && item.paths[0]) || item.label,
    kind: 'other',
    outcome,
    bytes: extra.bytes || 0,
    reversible: item.tier === 'C' ? 'none' : 'rebuild',
    reason: extra.reason,
    code: extra.code,
    restoreHint: item.restoreHint || undefined,
  };
}

function label(group, item) {
  return (group && group.title ? group.title + ': ' : '') + item.label;
}

/** History v2 entries for one removal: started (before) and finished (after). */
function startedEntry({ id, at, group, item }) {
  return historyLog.startedEntry({
    id, at, scope: 'devtools', label: label(group, item), requested: 1,
    pending: [{ path: historyItem(item, 'failed').path, kind: 'other', reversible: item.tier === 'C' ? 'none' : 'rebuild' }],
  });
}

function finishedEntry({ id, at, finishedAt, group, item, result }) {
  const ok = Boolean(result && result.ok);
  const it = historyItem(item, ok ? 'removed' : 'failed', {
    bytes: result && result.freed,
    reason: ok ? undefined : (result && (result.error || result.message)) || 'Not removed.',
    code: ok ? undefined : result && result.code,
  });
  return historyLog.finishedEntry({ id, at, finishedAt, scope: 'devtools', label: label(group, item), requested: 1, items: [it] });
}

/** A refusal that never touched anything, as a history entry. */
function refusedEntry({ id, at, group, item, reason }) {
  const it = historyItem(item, 'refused', { reason });
  return historyLog.finishedEntry({ id, at, finishedAt: at, scope: 'devtools', label: label(group, item), requested: 1, items: [it] });
}

module.exports = { REFUSAL_TEXT, removalDecision, findItem, historyItem, startedEntry, finishedEntry, refusedEntry };
