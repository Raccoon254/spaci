'use strict';
/**
 * Clean tiers: how much care each cleanable thing needs.
 *
 *   A  Safe       Developer build output and package caches. Regenerable, safe,
 *                 not user data. May be cleaned in bulk ("Clean all developer
 *                 files") and, opt-in, by auto-clean.
 *   B  Review     Regenerable but costly or owned by a running app: app and
 *                 browser caches, AI tool caches, simulator data, Docker
 *                 images and build cache, model stores, unverified project
 *                 folders. Cleaned one category at a time, with its own confirm.
 *   C  Permanent  Cannot be rebuilt: session history, the Trash, archives, logs,
 *                 saved state, Docker volumes and containers, large files.
 *                 Never in bulk; one item at a time, each confirmed.
 *
 * Tier A is an allowlist: a thing is A only when this file names it AND its own
 * flags say it is safe and reversible. Anything unknown falls to B or C, never
 * A. A project folder is A only when the scan verified it (git ignores it and
 * tracks nothing inside, which is what item.safe === true means) and its name
 * is known build output.
 *
 * Pure and Electron-free: main.js uses it for the tier map, the "Clean all"
 * plan and auto-clean; tests drive it directly. The clean path (clean-guard,
 * clean-plan) stays authoritative: a tier never lets anything through that the
 * guard would refuse.
 */

const TIERS = Object.freeze({ A: 'A', B: 'B', C: 'C' });

/** The badge each tier shows, the same three the app already uses. */
const BADGES = Object.freeze({
  A: Object.freeze({ cls: 'sp-badge-safe', text: 'Safe' }),
  B: Object.freeze({ cls: 'sp-badge-caution', text: 'Review' }),
  C: Object.freeze({ cls: 'sp-badge-warn', text: 'Permanent' }),
});

// ---- project artifacts ------------------------------------------------------

/**
 * Build output and dependency folders that are tier A once the scan verified
 * them. Each maps to the group it is summarised under and how it comes back.
 * Virtualenvs are not here: the scanner never marks them safe (packages
 * installed by hand are user state).
 */
const ARTIFACT_GROUPS = Object.freeze({
  node_modules: { group: 'node_modules', hint: 'npm ci, pnpm install, yarn or bun install' },
  '.next': { group: 'Framework build caches', hint: 'Rebuilt by the next dev server start or build' },
  '.nuxt': { group: 'Framework build caches', hint: 'Rebuilt by the next dev server start or build' },
  '.output': { group: 'Framework build caches', hint: 'Rebuilt by the next build' },
  '.svelte-kit': { group: 'Framework build caches', hint: 'Rebuilt by the next dev server start or build' },
  '.angular': { group: 'Framework build caches', hint: 'Rebuilt by the next build' },
  '.turbo': { group: 'Framework build caches', hint: 'Rebuilt by the next turbo run' },
  '.parcel-cache': { group: 'Framework build caches', hint: 'Rebuilt by the next Parcel build' },
  build: { group: 'Build output (build, dist, out)', hint: "Run the project's build" },
  dist: { group: 'Build output (build, dist, out)', hint: "Run the project's build" },
  out: { group: 'Build output (build, dist, out)', hint: "Run the project's build" },
  obj: { group: 'Build output (build, dist, out)', hint: 'dotnet build' },
  target: { group: 'Rust and Maven target', hint: 'cargo build or mvn package' },
  '.gradle': { group: 'Gradle and Android', hint: './gradlew build' },
  __pycache__: { group: 'Python caches', hint: 'Regenerates the next time Python runs' },
  '.pytest_cache': { group: 'Python caches', hint: 'Regenerates the next time the tool runs' },
  '.mypy_cache': { group: 'Python caches', hint: 'Regenerates the next time the tool runs' },
  '.ruff_cache': { group: 'Python caches', hint: 'Regenerates the next time the tool runs' },
  '.dart_tool': { group: 'Dart and Flutter', hint: 'flutter pub get or dart pub get' },
  Pods: { group: 'CocoaPods', hint: 'pod install' },
  DerivedData: { group: 'Xcode DerivedData', hint: 'Rebuilds on the next Xcode build' },
  vendor: { group: 'Vendored dependencies', hint: 'composer install, go mod vendor or bundle install' },
  coverage: { group: 'Test coverage reports', hint: 'Run the tests with coverage again' },
  '.terraform': { group: 'Terraform providers', hint: 'terraform init' },
});

function baseName(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Tier of one project item from the scanner ({ name, path, safe, reversible }).
 * @returns {{tier:string, reason:string}}
 */
function tierOfProjectItem(item) {
  if (!item || typeof item !== 'object') return { tier: TIERS.B, reason: 'Unknown item.' };
  if (item.reversible === false) return { tier: TIERS.C, reason: 'Cannot be rebuilt.' };
  const name = item.name || baseName(item.path);
  if (item.safe !== true) {
    return { tier: TIERS.B, reason: 'Spaci could not verify this is build output, so it is never cleaned in bulk.' };
  }
  if (!Object.prototype.hasOwnProperty.call(ARTIFACT_GROUPS, name)) {
    return { tier: TIERS.B, reason: 'Not a folder Spaci knows as build output.' };
  }
  return { tier: TIERS.A, reason: 'Build output git ignores. Rebuilds on the next install or build.' };
}

// ---- system targets ---------------------------------------------------------

/**
 * Developer package caches and build caches (system targets) that are tier A.
 * Every one is re-fetched or rebuilt by the tool that owns it. Listed by id so
 * a new target is never A until someone decides it is.
 */
const A_TARGETS = Object.freeze({
  npm: { group: 'Package caches', hint: 'Re-downloads on the next install' },
  yarn: { group: 'Package caches', hint: 'Re-downloads on the next install' },
  pnpm: { group: 'Package caches', hint: 'Re-downloads on the next install' },
  bun: { group: 'Package caches', hint: 'Re-downloads on the next install' },
  deno: { group: 'Package caches', hint: 'Re-downloads on the next run' },
  pip: { group: 'Package caches', hint: 'Re-downloads on the next install' },
  cargo: { group: 'Package caches', hint: 'Re-downloads on the next build' },
  go: { group: 'Package caches', hint: 'Re-downloads on the next build' },
  maven: { group: 'Package caches', hint: 'Re-downloads on the next build' },
  nuget: { group: 'Package caches', hint: 'Re-downloads on the next restore' },
  cocoapods: { group: 'Package caches', hint: 'Re-downloads on the next pod install' },
  pub: { group: 'Package caches', hint: 'Re-downloads on the next pub get' },
  gradle: { group: 'Gradle caches', hint: 'Re-downloads on the next build' },
  'gradle-wrapper': { group: 'Gradle caches', hint: 'Re-downloads on the next build' },
  'dart-server': { group: 'Editor analysis caches', hint: 'Rebuilds the next time your editor analyses code' },
  'xcode-derived': { group: 'Xcode DerivedData', hint: 'Rebuilds on the next Xcode build' },
});

/** Why a known safe target is still B. Anything else safe falls to the generic reason. */
const B_REASONS = Object.freeze({
  'user-caches': 'App caches. Apps rebuild them, but may be slow or signed out the first time.',
  'cli-cache': 'Mixed tool caches, some slow to fetch again.',
  'user-cache': 'Mixed tool caches, some slow to fetch again.',
  'xcode-devicesupport': 'Simulator and device data. Re-copied when a device on that version connects.',
  'simulator-caches': 'Simulator data. Rebuilt when a simulator boots, which takes a while.',
  huggingface: 'Downloaded AI models. Re-downloading can take hours.',
  thumbnails: 'App cache. Regenerated on demand.',
  'local-temp': 'Temporary files. Some may be in use by running apps.',
  'windows-temp': 'Temporary files. Some may be in use by running apps.',
});

/**
 * Tier of one system target ({ id, safe, reversible, tool, storyCategory }).
 * @returns {{tier:string, reason:string}}
 */
function tierOfTarget(t) {
  if (!t || typeof t !== 'object') return { tier: TIERS.B, reason: 'Unknown item.' };
  // AI tool history that is unsafe is permanent even when marked reversible:
  // the renderer has always shown it that way.
  if (t.reversible === false || (t.storyCategory === 'aitools' && t.safe === false)) {
    return { tier: TIERS.C, reason: 'Cannot be rebuilt once removed.' };
  }
  if (t.tool) return { tier: TIERS.B, reason: 'Belongs to an AI tool. Quit the tool before cleaning.' };
  if (t.category === 'Browsers' || t.storyCategory === 'browsers') {
    return { tier: TIERS.B, reason: 'Browser cache. Sites load slower once and some may sign you out.' };
  }
  if (t.safe === true && Object.prototype.hasOwnProperty.call(A_TARGETS, t.id)) {
    return { tier: TIERS.A, reason: 'Package or build cache. ' + A_TARGETS[t.id].hint + '.' };
  }
  return { tier: TIERS.B, reason: B_REASONS[t.id] || 'Rebuilds, but review what it holds first.' };
}

// ---- Docker -----------------------------------------------------------------

/**
 * Docker is cleaned by Docker (prune), never by path, so none of it is A.
 * Build cache and images come back by themselves: B. Containers and volumes
 * hold state nothing rebuilds: C.
 */
const DOCKER_TIERS = Object.freeze({
  'build-cache': { tier: TIERS.B, reason: 'Docker rebuilds it on your next build. Docker cleans it, one category at a time.' },
  'dangling-images': { tier: TIERS.B, reason: 'Untagged layers Docker removes itself.' },
  'unused-images': { tier: TIERS.B, reason: 'Downloaded or rebuilt the next time something needs them. A local-only build is gone.' },
  'stopped-containers': { tier: TIERS.C, reason: 'A container keeps changes made inside it.' },
  volume: { tier: TIERS.C, reason: 'Volumes hold databases and uploads.' },
});

function tierOfDockerKind(kind) {
  return DOCKER_TIERS[kind] || { tier: TIERS.C, reason: 'Unknown Docker data.' };
}

/** Files from the large-file scan: user data, always per item. */
function tierOfLargeFile() {
  return { tier: TIERS.C, reason: 'Your file. It goes to the Trash, one at a time.' };
}

// ---- whole-scan classification ----------------------------------------------

/**
 * Tiers for everything in a scan. The renderer passes what it shows; `trusted`
 * is main's own view (the current target catalog and the cached scan), which
 * wins wherever the two disagree, so a stale or altered renderer list can
 * never promote anything to A.
 *
 * @param {{projects?:object[], sysTargets?:object[]}} shown
 * @param {{targetsById?:Map<string,object>, itemsByPath?:Map<string,object>}} trusted
 */
function classifyScan(shown = {}, trusted = {}) {
  const targetsById = trusted.targetsById instanceof Map ? trusted.targetsById : null;
  const itemsByPath = trusted.itemsByPath instanceof Map ? trusted.itemsByPath : null;
  const system = {};
  for (const t of Array.isArray(shown.sysTargets) ? shown.sysTargets : []) {
    if (!t || typeof t.id !== 'string') continue;
    const cur = targetsById ? targetsById.get(t.id) : t;
    // A target main does not know is never A.
    const r = cur ? tierOfTarget({ ...t, ...pickFlags(cur) }) : { tier: TIERS.B, reason: 'Not in Spaci\'s catalog.' };
    system[t.id] = r;
  }
  const items = {};
  for (const p of Array.isArray(shown.projects) ? shown.projects : []) {
    for (const it of (p && Array.isArray(p.items)) ? p.items : []) {
      if (!it || typeof it.path !== 'string') continue;
      let r;
      if (itemsByPath) {
        const known = itemsByPath.get(it.path);
        r = known ? tierOfProjectItem(known) : { tier: TIERS.B, reason: 'Not in the last scan. Scan again.' };
      } else {
        r = tierOfProjectItem(it);
      }
      items[it.path] = r;
    }
  }
  const docker = {};
  for (const k of Object.keys(DOCKER_TIERS)) docker[k] = DOCKER_TIERS[k];
  return { system, items, docker };
}

function pickFlags(t) {
  const out = { safe: t.safe, reversible: t.reversible, category: t.category, storyCategory: t.storyCategory };
  if (t.tool) out.tool = t.tool;
  return out;
}

/**
 * Every tier A thing, as clean jobs plus a summary grouped by kind.
 * Only what `classifyScan` put in A is included, and only with a size.
 * count is things (a project folder or a cache), not jobs: one cache can have
 * several paths.
 * @returns {{jobs:object[], groups:object[], count:number, bytes:number, projects:number}}
 */
function planTierA(shown = {}, tiers = classifyScan(shown)) {
  const jobs = [];
  const groups = new Map();
  const touchedProjects = new Set();
  let count = 0;
  const add = (key, hint, bytes, label) => {
    if (!groups.has(key)) groups.set(key, { key, label: label || key, hint, count: 0, bytes: 0 });
    const g = groups.get(key);
    count++;
    g.count++;
    g.bytes += bytes;
  };
  for (const p of Array.isArray(shown.projects) ? shown.projects : []) {
    for (const it of (p && Array.isArray(p.items)) ? p.items : []) {
      if (!it || typeof it.path !== 'string') continue;
      const r = tiers.items[it.path];
      if (!r || r.tier !== TIERS.A) continue;
      const bytes = Number(it.size) || 0;
      if (bytes <= 0) continue;
      const name = it.name || baseName(it.path);
      const g = ARTIFACT_GROUPS[name];
      jobs.push({ path: it.path, isDir: it.isDir !== false, size: bytes, kind: 'artifact', project: p.path, name });
      touchedProjects.add(p.path);
      add(g.group, g.hint, bytes);
    }
  }
  for (const t of Array.isArray(shown.sysTargets) ? shown.sysTargets : []) {
    if (!t || typeof t.id !== 'string') continue;
    const r = tiers.system[t.id];
    if (!r || r.tier !== TIERS.A) continue;
    const paths = (Array.isArray(t.existingPaths) && t.existingPaths.length) ? t.existingPaths : (Array.isArray(t.paths) ? t.paths : []);
    const bytes = Number(t.size) || 0;
    if (!paths.length || bytes <= 0) continue;
    const g = A_TARGETS[t.id];
    // The size belongs to the target; spread nothing, so the total stays exact.
    paths.forEach((path, i) => jobs.push({ path, mode: 'contents', size: i === 0 ? bytes : 0, kind: 'cache', target: t.id, name: t.name }));
    add(g.group, g.hint, bytes);
  }
  const list = [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  const bytes = list.reduce((s, g) => s + g.bytes, 0);
  return { jobs, groups: list, count, bytes, projects: touchedProjects.size };
}

module.exports = {
  TIERS, BADGES, ARTIFACT_GROUPS, A_TARGETS, DOCKER_TIERS,
  tierOfProjectItem, tierOfTarget, tierOfDockerKind, tierOfLargeFile,
  classifyScan, planTierA, baseName,
};
