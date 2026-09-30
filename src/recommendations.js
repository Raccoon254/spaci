'use strict';
/**
 * Recommendation cards (the 'recommendations' IPC). Pure: Docker's policy
 * (reclaimSuggestions, PRUNE_KINDS) is passed in, so node --test covers it.
 *
 * Every savings figure is what the matching action would really remove
 * (issue #13):
 *   - a project card counts only its safe items, the ones a project clean
 *     passes to the cleaner; unverified bytes ride along as unverifiedSize;
 *   - a system card counts a safe target's own size (its paths are cleaned);
 *   - a Docker card counts what that prune frees. Dangling images are sized
 *     from per-image detail; without it their size is unknown and no card is
 *     shown rather than a guess. Volumes and stopped containers never get a
 *     card here.
 */
const { projectFigures } = require('./reclaimable');

const MAX_PROJECT_RECS = 5;
const MAX_SYSTEM_RECS = 4;
const MIN_SYSTEM_BYTES = 500 * 1024 * 1024;
const HIGH_SYSTEM_BYTES = 3 * 1024 ** 3;

function fmt(b) {
  if (!(b > 0)) return '0 B';
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(1)} ${u[i]}`;
}

const DOCKER_COPY = {
  'build-cache': (s) => `${s.unused} of ${s.total} cached build layers are not in use. Docker rebuilds them the next time you build.`,
  'dangling-images': (s) => `${s.unused} untagged images are left behind by rebuilds and no container uses them. Cleaning removes only those.`,
  'desktop-disk': (s) => [s.message, s.sizeNote, s.guidance].filter(Boolean).join(' '),
};
const DOCKER_TITLE = {
  'build-cache': 'Docker build cache',
  'dangling-images': 'Dangling Docker images',
  'desktop-disk': 'Docker disk image',
};

/**
 * Docker cards. `info` is the Docker summary; when the worker precomputed
 * `suggestions` (with per-image detail) those are used as they are.
 */
function dockerRecommendations(info, { reclaimSuggestions = () => [], pruneKinds = {} } = {}) {
  if (!info) return [];
  const suggestions = Array.isArray(info.suggestions) ? info.suggestions : reclaimSuggestions(info);
  return (Array.isArray(suggestions) ? suggestions : [])
    // Unknown kinds are dropped rather than crashing the list; an estimated
    // dangling size would promise more than the prune frees.
    .filter((s) => s && DOCKER_COPY[s.kind] && !(s.kind === 'dangling-images' && s.estimated))
    .map((s) => {
      const informational = s.kind === 'desktop-disk';
      const spec = pruneKinds[s.kind] || null;
      return {
        id: 'docker:' + s.kind,
        kind: 'docker',
        savings: informational ? 0 : (s.savings || 0),
        severity: s.severity,
        icon: 'box',
        title: `${DOCKER_TITLE[s.kind]} · ${fmt(informational ? s.bytes : s.savings)}`,
        body: DOCKER_COPY[s.kind](s),
        // What the action does to the data, decided here, not by the renderer.
        safe: informational ? true : Boolean(spec && spec.safe),
        reversible: informational ? true : Boolean(spec && spec.reversible === true),
        // The disk image is explained, not cleaned: pruning needs a running engine.
        action: informational ? { type: 'none' } : { type: 'docker-prune', kind: s.kind },
      };
    });
}

function buildRecommendations(projects, sysTargets, prefs, dockerInfo, docker = {}, now = Date.now()) {
  const recs = [];
  const staleMs = ((prefs && prefs.staleDays) || 60) * 86400000;

  // Big reclaimable projects, by what a clean of their safe items frees.
  const sized = (Array.isArray(projects) ? projects : [])
    .filter((p) => p && typeof p.path === 'string')
    .map((p) => ({ p, f: projectFigures(p.items) }))
    .filter(({ f }) => f.cleanableSize > 0)
    .sort((a, b) => b.f.cleanableSize - a.f.cleanableSize);
  for (const { p, f } of sized.slice(0, MAX_PROJECT_RECS)) {
    const stale = now - (p.mtime || 0) > staleMs;
    const names = p.items.filter((i) => i && i.safe === true).map((i) => i.name).slice(0, 3);
    recs.push({
      id: 'proj:' + p.path,
      kind: 'project',
      savings: f.cleanableSize,
      unverifiedSize: f.unverifiedSize,
      itemCount: f.cleanableCount,
      severity: stale ? 'high' : 'normal',
      icon: stale ? 'clock' : 'broom',
      title: `${p.name} · ${fmt(f.cleanableSize)} reclaimable`,
      body: stale
        ? `Not modified in ${Math.round((now - p.mtime) / 86400000)} days. Its build artifacts are likely safe to remove.`
        : `${f.cleanableCount} artifact folder${f.cleanableCount === 1 ? '' : 's'} (${names.join(', ')}${f.cleanableCount > 3 ? ', …' : ''}).`,
      action: { type: 'open-project', path: p.path },
    });
  }
  // Big system caches
  const bigSys = (Array.isArray(sysTargets) ? sysTargets : []).filter((t) => t && t.safe === true && t.size > MIN_SYSTEM_BYTES).sort((a, b) => b.size - a.size);
  for (const t of bigSys.slice(0, MAX_SYSTEM_RECS)) {
    recs.push({
      id: 'sys:' + t.id,
      kind: 'cache',
      savings: t.size,
      severity: t.size > HIGH_SYSTEM_BYTES ? 'high' : 'normal',
      icon: t.icon, title: `${t.name} · ${fmt(t.size)}`,
      body: t.description, action: { type: 'select-system', id: t.id },
    });
  }
  // Docker is invisible to a filesystem scan, so it is easily the biggest thing
  // a dev machine is unaware of. Rank it with everything else by size.
  recs.push(...dockerRecommendations(dockerInfo, docker));
  return recs.sort((a, b) => (b.savings || 0) - (a.savings || 0));
}

module.exports = { buildRecommendations, dockerRecommendations, fmt };
