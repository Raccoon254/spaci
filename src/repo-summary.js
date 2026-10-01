'use strict';
/**
 * Figures of a repository record (see repo-group.js), recomputed from its
 * items and worktrees. Pure, and free of git and disk walks, so the main
 * process can use it after a worktree is removed or pruned.
 */
const { projectFigures } = require('./reclaimable');
const { keyOf } = require('./clean-guard');

const bytes = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Recompute a repository record's figures from its items and worktrees, in
 * place: reclaimable totals, worktree sizes (nested ones counted once), and
 * what removal of the eligible worktrees would free.
 */
function summarizeRepo(record) {
  if (!record || !record.repo) return record;
  const r = record.repo;
  const f = projectFigures(record.items);
  record.cleanableSize = f.cleanableSize;
  record.unverifiedSize = f.unverifiedSize;
  const worktrees = Array.isArray(r.worktrees) ? r.worktrees : [];
  const existing = worktrees.filter((w) => w && w.exists);
  const worktreeBytes = existing.reduce((s, w) => s + bytes(w.size), 0);
  const nested = existing.filter((w) => w.nested).reduce((s, w) => s + bytes(w.size), 0);
  const removable = worktrees.filter((w) => w && w.eligibility && w.eligibility.ok);
  r.worktreeCount = worktrees.length;
  r.worktreeBytes = worktreeBytes;
  r.nestedWorktreeBytes = nested;
  r.externalWorktreeBytes = worktreeBytes - nested;
  const du = typeof r.mainDu === 'number' ? r.mainDu : null;
  r.mainSize = du == null ? null : Math.max(0, du - nested);
  // The main folder's du already holds nested worktrees (.claude/worktrees);
  // only worktrees that live elsewhere are added.
  r.totalBytes = du == null ? null : du + (worktreeBytes - nested);
  r.removable = {
    count: removable.length,
    bytes: removable.reduce((s, w) => s + bytes(w.size), 0),
    // What removal frees beyond the build output already counted as Safe.
    extraBytes: removable.reduce((s, w) => s + Math.max(0, bytes(w.size) - bytes(w.artifactBytes)), 0),
  };
  r.missing = worktrees.filter((w) => w && !w.exists).length;
  return record;
}

/**
 * A copy of `record` without the given worktrees (removed, or pruned when
 * missing) and without the items that lived inside them.
 */
function dropWorktrees(record, paths) {
  if (!record || !record.repo) return record;
  const gone = new Set((Array.isArray(paths) ? paths : []).map((p) => keyOf(p)));
  const r = record.repo;
  const removed = (r.worktrees || []).filter((w) => gone.has(keyOf(w.path)));
  const nestedGone = removed.filter((w) => w.nested).reduce((s, w) => s + bytes(w.size), 0);
  const next = {
    ...record,
    items: (record.items || []).filter((it) => !(it && it.checkout && gone.has(keyOf(it.checkout)))),
    repo: {
      ...r,
      worktrees: (r.worktrees || []).filter((w) => !gone.has(keyOf(w.path))),
      // A nested worktree's bytes leave the main folder with it.
      mainDu: typeof r.mainDu === 'number' ? Math.max(0, r.mainDu - nestedGone) : r.mainDu,
    },
  };
  return summarizeRepo(next);
}

module.exports = { summarizeRepo, dropWorktrees };
