'use strict';
/**
 * macOS: a Spaci started from Downloads or a mounted DMG cannot update itself
 * reliably (a translocated or read-only copy) and disappears with the DMG. On
 * the first packaged launch outside /Applications, offer to move it there,
 * once. The answer is remembered in prefs.moveToApplicationsAnswer.
 *
 * Pure: main.js supplies the Electron calls.
 */

const PREF = 'moveToApplicationsAnswer';
const ANSWERS = new Set(['moved', 'declined', 'failed']);

/** Offer the move? Only on a packaged macOS build outside Applications, never asked before. */
function shouldOfferMove({ platform, isPackaged, inApplications, prefs } = {}) {
  if (platform !== 'darwin' || !isPackaged || inApplications !== false) return false;
  const answer = prefs && prefs[PREF];
  return !ANSWERS.has(answer);
}

/**
 * Electron's conflictHandler: replace an older copy that is not running, never
 * quit a copy that is running (it holds the user's own session).
 */
function conflictChoice(type) {
  return type !== 'existsAndRunning';
}

/**
 * Run the offer. `ask()` returns true for "Move", `move()` performs it (and
 * relaunches on success). Records the answer before moving, so a crash or a
 * refused move never asks again on every launch.
 * @returns {'moved'|'declined'|'failed'|null} null when nothing was offered
 */
function offerMove({ platform, isPackaged, inApplications, prefs, ask, move, save, log = () => {} }) {
  if (!shouldOfferMove({ platform, isPackaged, inApplications, prefs })) return null;
  let yes = false;
  try { yes = Boolean(ask()); } catch (e) { log(`move prompt failed: ${e && e.message}`); yes = false; }
  if (!yes) { save({ [PREF]: 'declined' }); return 'declined'; }
  save({ [PREF]: 'moved' });
  try {
    if (move()) return 'moved';
  } catch (e) {
    log(`moveToApplicationsFolder failed: ${e && e.message}`);
  }
  save({ [PREF]: 'failed' });
  return 'failed';
}

module.exports = { PREF, shouldOfferMove, conflictChoice, offerMove };
