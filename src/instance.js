'use strict';
// Single-instance decisions, kept free of Electron so node --test covers them.
//
// Electron's lock is per user-data dir, so a copy started with
// --user-data-dir=<other> (a release candidate tested in isolation) gets its
// own lock and runs alongside; a second launch on the same dir hands over to
// the running copy and exits before creating any window, tray or timer.

/** What to do at startup given the result of app.requestSingleInstanceLock(). */
function startupRole(lockObtained) {
  return lockObtained ? 'primary' : 'secondary';
}

/**
 * How the primary instance brings its main window forward when a second launch
 * arrives. Returns an ordered list of actions for the caller to run.
 * @param {{exists:boolean, destroyed?:boolean, minimized?:boolean}} w
 * @returns {Array<'create'|'restore'|'show'|'focus'>}
 */
function focusPlan(w = {}) {
  if (!w.exists || w.destroyed) return ['create', 'focus'];
  const plan = [];
  if (w.minimized) plan.push('restore');
  plan.push('show', 'focus');
  return plan;
}

module.exports = { startupRole, focusPlan };
