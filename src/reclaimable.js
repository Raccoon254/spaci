'use strict';
/**
 * Reclaimable figures that count only what a clean would really remove
 * (issue #13). Pure, shared by the scanner (worker), the cache loader and the
 * recommendations.
 *
 * Projects: a clean passes only items marked safe === true to the cleaner.
 * Items Spaci could not verify as build output (git does not ignore them, no
 * manifest beside a `target`, a virtualenv) are never cleaned from a project
 * card, so their bytes are reported apart as unverifiedSize, never inside
 * cleanableSize.
 *
 * Docker: the headline counts what the prunes Spaci offers can free (build
 * cache and unused images). Volumes are only ever removed one at a time after
 * review and stopped containers are opt-in, so their bytes are reported apart
 * and never in the total.
 */

const bytes = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** { cleanableSize, unverifiedSize } for a project's items. */
function projectFigures(items) {
  let cleanableSize = 0;
  let unverifiedSize = 0;
  let cleanableCount = 0;
  let unverifiedCount = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    if (it.safe === true) { cleanableSize += bytes(it.size); cleanableCount++; }
    else { unverifiedSize += bytes(it.size); unverifiedCount++; }
  }
  return { cleanableSize, unverifiedSize, cleanableCount, unverifiedCount };
}

/** The project with cleanableSize and unverifiedSize recomputed from its items. */
function withProjectFigures(p) {
  if (!p || typeof p !== 'object') return p;
  const f = projectFigures(p.items);
  return { ...p, cleanableSize: f.cleanableSize, unverifiedSize: f.unverifiedSize };
}

/** The items a project clean would pass to the cleaner. */
function cleanableItems(p) {
  return ((p && Array.isArray(p.items)) ? p.items : []).filter((it) => it && it.safe === true);
}

/** System targets that are cleaned without an extra confirmation. */
function systemReclaimable(targets) {
  return (Array.isArray(targets) ? targets : []).filter((t) => t && t.safe === true).reduce((s, t) => s + bytes(t.size), 0);
}

/**
 * Docker figures from the category totals, plus the per-image detail when the
 * inventory has it (dangling images are sized from it; without it their size
 * is unknown, not guessed).
 * @returns {{ bytes, buildCache, images, danglingImages, danglingKnown, notCounted: { volumes, containers } }}
 */
function dockerFigures(categories, images = null) {
  const c = categories || {};
  const rec = (k) => bytes(c[k] && c[k].reclaimable);
  const detail = Array.isArray(images) && images.length > 0;
  const dangling = detail
    ? images.filter((i) => i && i.dangling && i.containers === 0).reduce((s, i) => s + bytes(i.uniqueBytes || i.bytes), 0)
    : null;
  return {
    bytes: rec('buildCache') + rec('images'),
    buildCache: rec('buildCache'),
    images: rec('images'),
    danglingImages: dangling,
    danglingKnown: detail,
    notCounted: { volumes: rec('volumes'), containers: rec('containers') },
  };
}

/** Everything a clean-all would free: project items, safe system targets, and Docker's offered prunes. */
function grandTotal({ projects = [], system = [], docker = null } = {}) {
  const proj = (Array.isArray(projects) ? projects : []).reduce((s, p) => s + projectFigures(p && p.items).cleanableSize, 0);
  const dockerBytes = docker && docker.ok && docker.cleanable ? bytes(docker.cleanable.bytes) : 0;
  return proj + systemReclaimable(system) + dockerBytes;
}

module.exports = { projectFigures, withProjectFigures, cleanableItems, systemReclaimable, dockerFigures, grandTotal };
