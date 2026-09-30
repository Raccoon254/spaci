'use strict';
// Cleaning tiers from the storage spec (os-storage-spec.md, "Tier legend"):
//   A  regenerable, safe to bulk clean with one summary confirm
//   B  regenerable but costly or context dependent, confirm per category
//   C  user data or irreversible, never bulk, confirm per item
//   D  managed by the OS: explain only, never clean; show the OS's own command
//
// Every item the breakdown reports carries one. The breakdown never runs any
// `command`: it is text for the user to read.

const TIERS = Object.freeze({
  A: 'Regenerable, safe to clean',
  B: 'Regenerable, review first',
  C: 'Your data, item by item',
  D: 'Managed by the OS',
});

// How sure a number is. `upper-bound`: du counts APFS clones or hard links in
// full, so deleting frees less. `partial`: the walk timed out, bytes so far.
// `denied`: permission refused, so the real size is unknown. `estimate`: the
// OS's own estimate (purgeable). `cached`: from the previous measurement,
// a fresh one is running. `stale`: this run timed out below the last complete
// measurement, so that one is shown (labelled) instead of a smaller partial.
const CONFIDENCE = Object.freeze(['exact', 'upper-bound', 'partial', 'denied', 'estimate', 'cached', 'stale', 'count-only']);

/**
 * Build a storage item. `bytes` null means "exists but cannot be measured";
 * such items are named parts of the remainder, never counted as zero.
 */
function item(fields) {
  const f = fields || {};
  if (!TIERS[f.tier]) throw new Error('storage item ' + f.key + ' has no valid tier');
  const out = {
    key: String(f.key),
    label: String(f.label || f.key),
    tier: f.tier,
    bytes: f.bytes == null ? null : Math.max(0, Math.round(Number(f.bytes) || 0)),
    confidence: CONFIDENCE.includes(f.confidence) ? f.confidence : (f.bytes == null ? 'denied' : 'exact'),
  };
  for (const k of ['hint', 'command', 'commandNote', 'paths', 'group', 'count', 'freeableAtLeast', 'duBytes', 'lastUsedAt', 'settings', 'children', 'icon', 'additive']) {
    if (f[k] !== undefined && f[k] !== null) out[k] = f[k];
  }
  if (Array.isArray(out.paths)) out.paths = out.paths.filter(Boolean);
  // additive:false means "shown for information, already counted elsewhere"
  // (purgeable space, the backing file of a mount). Default true.
  if (out.additive === undefined) out.additive = true;
  return out;
}

/** Sum of the additive, measured items. */
function sumItems(items) {
  return (items || []).reduce((a, it) => a + (it && it.additive !== false && it.bytes ? it.bytes : 0), 0);
}

module.exports = { TIERS, CONFIDENCE, item, sumItems };
