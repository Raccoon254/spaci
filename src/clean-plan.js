'use strict';
/**
 * What each clean job is, decided in the main process from Spaci's own scan
 * results. The renderer's `meta.reversible` is never read: whether a clean can
 * be undone or rebuilt is a property of the thing being cleaned.
 *
 * Also the confirmation gate: anything that is not a preselectable, rebuildable
 * cache (an unsafe or irreversible target, or a large file) is refused unless
 * the user accepted a confirm dialog for this clean (meta.confirmed === true).
 * This runs before clean-guard's enforceTargetRules and adds to it; it never
 * lets through anything the guard would refuse.
 *
 * Pure, so it is unit tested without Electron.
 */
const { keyOf } = require('./clean-guard');

const NEEDS_CONFIRMATION = 'needs-confirmation';

/**
 * Build the lookups once per clean.
 * targetIndex: clean-guard.buildTargetIndex(system.TARGETS).
 * projects: the last project scan ({ path, items: [{ path }] }).
 * largeFiles: paths from the last large-file scan.
 */
function buildPlanContext({ targetIndex = new Map(), projects = [], largeFiles = [], worktrees = null } = {}) {
  const targets = new Map();
  for (const [p, t] of targetIndex) targets.set(keyOf(p), t);
  const projectOf = new Map();
  for (const proj of projects || []) {
    for (const it of (proj && proj.items) || []) {
      if (it && typeof it.path === 'string' && it.path) projectOf.set(keyOf(it.path), proj.path);
    }
  }
  const large = new Set();
  for (const p of largeFiles || []) if (typeof p === 'string' && p) large.add(keyOf(p));
  // Linked git worktrees: removed only by `git worktree remove`, after a
  // confirm that names each one. Taken from the scan's repository records
  // unless the caller lists them.
  const worktreeOf = new Map();
  const wts = Array.isArray(worktrees) ? worktrees
    : (projects || []).flatMap((proj) => ((proj && proj.repo && Array.isArray(proj.repo.worktrees)) ? proj.repo.worktrees : [])
      .map((w) => ({ path: w && w.path, main: proj.repo.main || proj.path })));
  for (const w of wts) if (w && typeof w.path === 'string' && w.path) worktreeOf.set(keyOf(w.path), w.main || null);
  return { targets, projectOf, large, worktreeOf };
}

/**
 * { kind, reversible, target?, project?, needsConfirmation } for one path.
 * Order matches the guard: a system target wins, then a large file (the Trash
 * is the gentler outcome if a path were ever both), then a project artifact.
 */
function classifyJob(p, ctx) {
  const key = keyOf(p);
  const target = ctx.targets.get(key);
  if (target) {
    const reversible = target.reversible === false ? 'none' : 'rebuild';
    return {
      kind: target.id === 'trash' ? 'trash' : 'cache',
      reversible,
      target,
      needsConfirmation: target.safe === false || reversible === 'none',
    };
  }
  if (ctx.large.has(key)) return { kind: 'file', reversible: 'trash', needsConfirmation: true };
  if (ctx.projectOf.has(key)) return { kind: 'artifact', reversible: 'rebuild', project: ctx.projectOf.get(key), needsConfirmation: false };
  // A whole worktree is never cleaned without the user's yes (tier B), so
  // nothing unattended (auto-clean) can ever pass this gate with one.
  if (ctx.worktreeOf && ctx.worktreeOf.has(key)) return { kind: 'worktree', reversible: 'rebuild', project: ctx.worktreeOf.get(key), needsConfirmation: true };
  // Unknown: clean-guard refuses it. Never claim it can be undone.
  return { kind: 'other', reversible: 'none', needsConfirmation: false };
}

/**
 * Split jobs into { pass, refused } by the confirmation gate. `pass` keeps the
 * caller's job objects; refused entries use clean-guard's refused shape with
 * reason 'needs-confirmation'.
 */
function gateJobs(jobs, ctx, confirmed) {
  const pass = [];
  const refused = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job.path !== 'string' || job.path.length === 0) continue;
    const c = classifyJob(job.path, ctx);
    if (c.needsConfirmation && confirmed !== true) {
      refused.push({ path: job.path, ...(c.target ? { target: c.target.id } : {}), reason: NEEDS_CONFIRMATION });
      continue;
    }
    pass.push(job);
  }
  return { pass, refused };
}

module.exports = { NEEDS_CONFIRMATION, buildPlanContext, classifyJob, gateJobs };
