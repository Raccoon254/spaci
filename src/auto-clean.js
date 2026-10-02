'use strict';
/**
 * Auto-clean: opt-in, unattended cleaning of a narrow slice of tier A.
 *
 * Off by default. When on, a scheduled run (scheduler.js) may move away:
 *   - verified build output (node_modules, .next, target, ...) of projects
 *     nobody has touched for `staleDays`,
 *   - developer package caches bigger than `minCacheBytes`,
 * and nothing else. Every run is capped (`maxRunBytes`, `maxItems`), runs only
 * on AC power while the machine is idle, and skips anything whose owning tool
 * is running. If a check cannot answer, the item is skipped: this fails closed.
 *
 * The first run after the rules are set is a dry run: it only reports what it
 * would clean and waits for the user to approve the rules in History.
 *
 * Nothing is deleted outright. Items are renamed into a staging folder on the
 * same volume and kept for 24 hours, so a run can be undone from History; after
 * that the staging folder is purged. Moves are journaled (see createStaging) so
 * a crash at any point leaves every item either in place or in staging, and
 * the next launch knows which.
 *
 * Policy (settings, gate, selection) is pure. The fs and process layers are
 * injected, so node --test drives all of it on temp folders.
 */
const nodeFs = require('fs');
const nodePath = require('path');
const { execFile } = require('child_process');
const tiers = require('./clean-tiers');
const nativeSpecs = require('./native-cleanup-specs');

// Tier A caches auto-clean hands to their tool's gentle command (pnpm store
// prune, uv cache prune, go clean -cache ...) instead of staging: the tool
// knows what is in use, and a folder move would not free hard-linked stores.
// Not undoable, so each is only run when its tool is idle.
const NATIVE_AUTO = new Set(Object.keys(nativeSpecs.SPECS).filter((id) => Array.isArray(nativeSpecs.SPECS[id].autoRun)));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const STAGING_TTL_MS = DAY;
const KEEP_MARKER = '.spaci-keep';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  staleDays: 30,
  minCacheBytes: 1 * GB,
  maxRunBytes: 20 * GB,
  maxItems: 200,
  idleMinutes: 10,
  excludes: [],
  // Set when the user approves a dry run. It holds the rule fingerprint it was
  // given for: changing a rule means a new dry run before anything is moved.
  approved: null,
  pendingPreview: null,
});

function clampNum(v, lo, hi, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Every setting forced into range. Unknown keys are dropped. */
function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  const excludes = Array.isArray(r.excludes)
    ? Array.from(new Set(r.excludes.filter((p) => typeof p === 'string' && p && nodePath.isAbsolute(p)))).slice(0, 200)
    : [];
  const out = {
    enabled: r.enabled === true,
    staleDays: Math.round(clampNum(r.staleDays, 7, 365, d.staleDays)),
    minCacheBytes: Math.round(clampNum(r.minCacheBytes, 100 * MB, 500 * GB, d.minCacheBytes)),
    maxRunBytes: Math.round(clampNum(r.maxRunBytes, 1 * GB, 2000 * GB, d.maxRunBytes)),
    maxItems: Math.round(clampNum(r.maxItems, 1, 1000, d.maxItems)),
    idleMinutes: Math.round(clampNum(r.idleMinutes, 5, 240, d.idleMinutes)),
    excludes,
    approved: null,
    // The dry run waiting for approval, if any (a history entry id).
    pendingPreview: typeof r.pendingPreview === 'string' && r.pendingPreview ? r.pendingPreview : null,
  };
  if (r.approved && typeof r.approved === 'object' && typeof r.approved.rules === 'string' && Number.isFinite(r.approved.at)) {
    out.approved = { at: r.approved.at, rules: r.approved.rules, previewId: typeof r.approved.previewId === 'string' ? r.approved.previewId : null };
  }
  return out;
}

/** What the user approves: the rules, not the run. */
function rulesFingerprint(s) {
  const x = sanitizeSettings(s);
  return JSON.stringify([x.staleDays, x.minCacheBytes, x.maxRunBytes, x.maxItems, [...x.excludes].sort()]);
}

/** Approved rules, given for a preview the user saw (approvalCheck: never an empty one). */
function isApproved(s) {
  const x = sanitizeSettings(s);
  return Boolean(x.approved && x.approved.previewId && x.approved.rules === rulesFingerprint(x));
}

// ---- gate -------------------------------------------------------------------

/**
 * Should a scheduled auto-clean start now? Pure: the caller passes Electron's
 * powerMonitor readings. `force` is never used by the scheduler for this task;
 * a user-started preview bypasses power and idle only.
 * @returns {{run:boolean, reason:string}}
 */
function autoCleanGate({ settings, onboarded = true, busy = false, onBattery = null, idleSeconds = null,
  thermalState = 'unknown', force = false } = {}) {
  const s = sanitizeSettings(settings);
  if (!s.enabled) return { run: false, reason: 'disabled' };
  if (!onboarded) return { run: false, reason: 'not-onboarded' };
  if (busy) return { run: false, reason: 'busy' };
  if (force) return { run: true, reason: 'forced' };
  // Unknown power state is not AC power.
  if (onBattery !== false) return { run: false, reason: 'on-battery' };
  if (thermalState === 'serious' || thermalState === 'critical') return { run: false, reason: 'thermal' };
  if (typeof idleSeconds !== 'number' || !Number.isFinite(idleSeconds) || idleSeconds < s.idleMinutes * 60) {
    return { run: false, reason: 'not-idle' };
  }
  return { run: true, reason: 'due' };
}

// ---- what may run unattended ------------------------------------------------

/**
 * Project folders auto-clean may move (spec 6.1). A narrower list than tier A:
 * every name here is tier A, never the reverse. `needs` names a file that must
 * sit beside the folder.
 */
const AUTO_ARTIFACTS = Object.freeze({
  node_modules: {}, '.next': {}, '.nuxt': {}, '.turbo': {}, '.parcel-cache': {},
  dist: {}, build: {}, target: {}, '.gradle': {},
  Pods: { needs: ['Podfile.lock'] },
  __pycache__: {}, '.pytest_cache': {}, '.mypy_cache': {},
});

/**
 * Process names by the tool family that owns a cache. A cache is left alone
 * while any process of its family runs. Node scripts (npm, pnpm, yarn) run as
 * `node <script>`, so a process is known by its executable and by its script.
 */
const TOOL_FAMILIES = Object.freeze({
  node: ['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bun', 'bunx', 'corepack', 'deno'],
  jvm: ['java', 'gradle', 'gradlew', 'mvn', 'mvnw', 'kotlin-daemon'],
  rust: ['cargo', 'rustc', 'rust-analyzer'],
  python: ['pip', 'pip3', 'uv', 'poetry', 'pipenv'],
  go: ['go', 'gopls'],
  apple: ['Xcode', 'xcodebuild', 'pod', 'swift-build', 'XCBBuildService'],
  dart: ['dart', 'flutter', 'dartaotruntime'],
  dotnet: ['dotnet', 'nuget'],
});

const TARGET_FAMILY = Object.freeze({
  npm: 'node', yarn: 'node', pnpm: 'node', bun: 'node', deno: 'node',
  gradle: 'jvm', 'gradle-wrapper': 'jvm',
  cargo: 'rust', pip: 'python', 'uv-cache': 'python', go: 'go', 'go-modcache': 'go',
  cocoapods: 'apple', 'xcode-derived': 'apple',
  pub: 'dart', 'dart-server': 'dart', nuget: 'dotnet',
});

/** Anything that builds or runs code: its cwd inside a project keeps that project. */
const DEV_PROCESS_NAMES = new Set([
  'node', 'next', 'vite', 'webpack', 'tsc', 'turbo', 'nuxt', 'esbuild',
  'python', 'python3', 'pytest', 'mypy', 'ruby', 'bundle', 'php', 'composer', 'docker', 'docker-compose',
  ...Object.values(TOOL_FAMILIES).flat(),
  // Editors' extension hosts run language servers and watchers on the project.
  'Code Helper (Plugin)', 'Code - Insiders Helper (Plugin)', 'Cursor Helper (Plugin)', 'Windsurf Helper (Plugin)', 'tsserver',
]);

// AI coding CLIs run builds inside projects. While one runs, no project is
// touched: its child processes come and go faster than a snapshot can see.
const AI_CODING_TOOLS = new Set(['claude', 'codex', 'opencode', 'gemini', 'grok']);

const CLOUD_SEGMENTS = ['/Library/Mobile Documents/', '/Library/CloudStorage/', '/iCloud Drive/'];

// Folder names sync clients create. Any ancestor named like this is cloud.
// Skipping by mistake is harmless; moving a synced folder is not (the client
// would delete it from every other device too).
const CLOUD_NAMES = [
  /^Dropbox( \(.+\))?$/i, // Dropbox, Dropbox (Personal), Dropbox (Team)
  /^OneDrive( - .+)?$/i, // OneDrive, OneDrive - Contoso
  /^Google Drive$/i, /^GoogleDrive-/i, /^My Drive$/i, /^Shared drives$/i,
  /^iCloud Drive/i, /^com~apple~CloudDocs$/i, /^Mobile Documents$/,
];
// Box's folder name is too common to match anywhere: only right under a home.
const BOX_RE = /^(?:[a-z]:)?\/(?:users|home)\/[^/]+\/box( sync)?(\/|$)/i;
// Windows sets these to the OneDrive roots, whatever the folder is called.
const ONEDRIVE_ENV = ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer'];
// Set on folders a macOS File Provider (iCloud Desktop & Documents, Dropbox,
// Google Drive, OneDrive, Box) syncs.
const FILE_PROVIDER_XATTR = 'com.apple.file-provider-domain-id';

function envCloudRoots(env = process.env) {
  return ONEDRIVE_ENV.map((k) => env && env[k]).filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

function isInsideOrSame(parent, child) {
  if (!parent || !child) return false;
  const api = /^[a-zA-Z]:[\\/]/.test(parent) || parent.includes('\\') ? nodePath.win32 : nodePath.posix;
  const rel = api.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

/** Pure: a reason when the path is in a cloud-synced folder or on an external volume. */
function cloudOrExternal(p, { cloudRoots = envCloudRoots() } = {}) {
  const s = String(p);
  const fwd = s.replace(/\\/g, '/');
  const segs = fwd.split('/').filter(Boolean);
  if (CLOUD_SEGMENTS.some((seg) => fwd.includes(seg)) || segs.some((seg) => CLOUD_NAMES.some((re) => re.test(seg)))
    || BOX_RE.test(fwd) || cloudRoots.some((r) => isInsideOrSame(r, s) || isInsideOrSame(r.toLowerCase(), s.toLowerCase()))) {
    return 'It is in a cloud-synced folder.';
  }
  if (s.startsWith('/Volumes/') || s.startsWith('/media/') || s.startsWith('/mnt/') || s.startsWith('/run/media/')) return 'It is on an external or network volume.';
  return null;
}

/**
 * The fs half of the cloud check: the path's real location (a symlink into
 * iCloud Drive or ~/Library/CloudStorage) and, on macOS, the File Provider
 * xattr on the path or any ancestor (iCloud Desktop & Documents keeps
 * ~/Documents in place but marks it). Never rejects. `cache` is shared across
 * calls so a run asks about each folder once. `attr` is for tests only: macOS
 * does not let a user process set the File Provider attribute.
 * @returns {Promise<string|null>}
 */
async function cloudReason(p, { fs = nodeFs, exec = execFile, platform = process.platform, cloudRoots = envCloudRoots(), cache = new Map(), timeout = 3000, attr = FILE_PROVIDER_XATTR } = {}) {
  const pure = cloudOrExternal(p, { cloudRoots });
  if (pure) return pure;
  const fsp = fs.promises;
  // The nearest existing ancestor's real path, plus whatever did not exist yet.
  let real = null;
  let cur = String(p);
  let rest = '';
  for (let i = 0; i < 64 && cur; i++) {
    try { real = nodePath.join(await fsp.realpath(cur), rest); break; } catch { /* go up */ }
    const up = nodePath.dirname(cur);
    if (up === cur) break;
    rest = nodePath.join(nodePath.basename(cur), rest);
    cur = up;
  }
  if (real && real !== p) {
    const r = cloudOrExternal(real, { cloudRoots });
    if (r) return r;
  }
  if (platform !== 'darwin') return null;
  const dirs = [];
  for (const start of new Set([String(p), real].filter(Boolean))) {
    let d = start;
    for (let i = 0; i < 64; i++) {
      dirs.push(d);
      const up = nodePath.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  for (const d of new Set(dirs)) {
    if (d === '/') continue;
    if (!cache.has(d)) {
      cache.set(d, new Promise((resolve) => {
        try {
          exec('xattr', ['-p', attr, d], { timeout, windowsHide: true }, (err) => resolve(!err));
        } catch { resolve(false); }
      }));
    }
    if (await cache.get(d)) return 'It is in a cloud-synced folder.';
  }
  return null;
}

/** cloudReason for many paths: Map of path -> reason, for the ones that have one. */
async function cloudReasons(paths, opts = {}) {
  const cache = opts.cache || new Map();
  const out = new Map();
  for (const p of new Set(paths)) {
    if (typeof p !== 'string' || !p) continue;
    const r = await cloudReason(p, { ...opts, cache });
    if (r) out.set(p, r);
  }
  return out;
}

/**
 * A process snapshot: { ok, list: [{ pid, names: [..], cwd: string|null, args?: string }] }.
 * ok is false when the snapshot itself failed.
 */
function familyRunning(procs, family) {
  const names = new Set(TOOL_FAMILIES[family] || []);
  return procs.list.some((p) => p.names.some((n) => names.has(n)));
}

const PATH_CHAR = /[A-Za-z0-9._~\/\\-]/;

/** True when the command line names the project folder or a path inside it. */
function argsMention(args, projectPath) {
  if (typeof args !== 'string' || !args || !projectPath) return false;
  const norm = (x) => x.replace(/\\/g, '/').toLowerCase();
  const a = norm(args);
  const p = norm(projectPath).replace(/\/+$/, '');
  if (!p) return false;
  for (let i = a.indexOf(p); i !== -1; i = a.indexOf(p, i + 1)) {
    const before = i === 0 ? '' : a[i - 1];
    const after = a[i + p.length];
    if (before && PATH_CHAR.test(before)) continue;
    if (after === undefined || after === '/' || !PATH_CHAR.test(after)) return true;
  }
  return false;
}

/** { blocked: reason|null } for one project, from the snapshot. */
function projectBusy(procs, projectPath) {
  for (const p of procs.list) {
    if (!p.names.some((n) => DEV_PROCESS_NAMES.has(n))) continue;
    if (argsMention(p.args, projectPath)) return `${p.names[0]} is working on files in this project.`;
    if (p.cwd == null) return 'A developer tool is running and Spaci could not tell where.';
    if (isInsideOrSame(projectPath, p.cwd)) return `${p.names[0]} is running in this project.`;
  }
  return null;
}

/**
 * The run's candidates, in the order they will be moved, and why everything
 * else was left. Pure.
 *
 * @param {object} o
 * @param {object[]} o.projects       cached project scan
 * @param {object[]} o.system         cached system scan
 * @param {object}   o.settings
 * @param {number}   o.now
 * @param {Map<string,{lastActivity:number|null, keep:boolean}>} o.evidence  per project
 * @param {Map<string,{nearFiles:string[], keep:boolean}>} o.itemEvidence     per item path
 * @param {{ok:boolean, list:object[]}} o.procs
 * @param {{ok:boolean, running:string[]}} o.aiTools
 * @param {{ok:boolean, running:number}} [o.docker]  running containers (fails closed when absent)
 * @param {(p:string) => string|null} [o.cloudOf]     the fs cloud check (cloudReasons), per path
 * @param {(p:string) => boolean|null} [o.sameDisk]   false when a path is not on the staging volume
 * @param {string[]} [o.cloudRoots]                   OneDrive roots from the environment
 */
function selectCandidates({ projects = [], system = [], settings, now, evidence = new Map(), itemEvidence = new Map(), procs = { ok: false, list: [] }, aiTools = { ok: false, running: [] },
  docker = { ok: false, running: 0 }, cloudOf = null, sameDisk = null, cloudRoots = envCloudRoots(), nativeTargets = null }) {
  const s = sanitizeSettings(settings);
  const staleMs = s.staleDays * DAY;
  const out = [];
  const skipped = [];
  const skip = (path, reason, extra = {}) => skipped.push({ path, reason, ...extra });
  const excluded = (p) => s.excludes.some((x) => isInsideOrSame(x, p));
  const aiRunning = (aiTools.running || []).filter((t) => AI_CODING_TOOLS.has(t));
  const whereOf = (p) => cloudOrExternal(p, { cloudRoots }) || (typeof cloudOf === 'function' ? cloudOf(p) : null);
  const OFF_DISK = 'It is on another disk than Spaci\'s staging folder, so it cannot be set aside for undo.';
  const offDisk = (p) => typeof sameDisk === 'function' && sameDisk(p) === false;

  for (const proj of Array.isArray(projects) ? projects : []) {
    if (!proj || typeof proj.path !== 'string') continue;
    const a = (Array.isArray(proj.items) ? proj.items : []).filter((it) => it && tiers.tierOfProjectItem(it).tier === 'A');
    if (!a.length) continue;
    const skipAll = (reason) => a.forEach((it) => skip(it.path, reason, { project: proj.path }));
    if (excluded(proj.path)) { skipAll('You excluded this folder.'); continue; }
    const where = whereOf(proj.path);
    if (where) { skipAll(where); continue; }
    const ev = evidence.get(proj.path);
    if (!ev) { skipAll('Spaci could not check when this project was last used.'); continue; }
    if (ev.keep) { skipAll('The project has a .spaci-keep file.'); continue; }
    if (ev.lastActivity == null) { skipAll('Spaci could not check when this project was last used.'); continue; }
    if (now - ev.lastActivity < staleMs) {
      a.forEach((it) => skip(it.path, `Used in the last ${s.staleDays} days.`, { project: proj.path, quiet: true }));
      continue;
    }
    if (!procs.ok) { skipAll('Spaci could not check which tools are running.'); continue; }
    if (aiRunning.length) { skipAll('An AI coding tool is running.'); continue; }
    const busy = projectBusy(procs, proj.path);
    if (busy) { skipAll(busy); continue; }
    if (ev.compose) {
      // A compose project's containers may bind-mount its node_modules or build output.
      if (!docker || !docker.ok) { skipAll('It has a Docker Compose file and Spaci could not check whether containers are running.'); continue; }
      if (docker.running > 0) { skipAll('It has a Docker Compose file and Docker containers are running.'); continue; }
    }
    const idleDays = Math.floor((now - ev.lastActivity) / DAY);
    for (const it of a) {
      const name = it.name || tiers.baseName(it.path);
      const rule = AUTO_ARTIFACTS[name];
      if (!rule) { skip(it.path, 'Auto-clean leaves this kind of folder to you.', { project: proj.path }); continue; }
      if (excluded(it.path)) { skip(it.path, 'You excluded this folder.', { project: proj.path }); continue; }
      const iev = itemEvidence.get(it.path);
      if (!iev) { skip(it.path, 'Spaci could not check this folder.', { project: proj.path }); continue; }
      if (iev.keep) { skip(it.path, 'It has a .spaci-keep file.', { project: proj.path }); continue; }
      if (rule.needs && !rule.needs.some((f) => iev.nearFiles.includes(f))) {
        skip(it.path, `No ${rule.needs.join(' or ')} beside it, so it may not come back the same.`, { project: proj.path });
        continue;
      }
      const bytes = Number(it.size) || 0;
      if (bytes <= 0) continue;
      if (offDisk(it.path)) { skip(it.path, OFF_DISK, { project: proj.path, offDisk: true }); continue; }
      out.push({
        path: it.path, kind: 'artifact', name, project: proj.path, bytes,
        rule: `${name} in a project unused for ${idleDays} days`,
        group: tiers.ARTIFACT_GROUPS[name].group,
      });
    }
  }

  for (const t of Array.isArray(system) ? system : []) {
    if (!t || typeof t.id !== 'string') continue;
    if (tiers.tierOfTarget(t).tier !== 'A') continue;
    const paths = (Array.isArray(t.existingPaths) && t.existingPaths.length) ? t.existingPaths : [];
    const bytes = Number(t.size) || 0;
    if (!paths.length || bytes <= 0) continue;
    const skipT = (reason) => paths.forEach((p) => skip(p, reason, { target: t.id }));
    if (bytes < s.minCacheBytes) { paths.forEach((p) => skip(p, 'Smaller than your auto-clean minimum.', { target: t.id, quiet: true })); continue; }
    if (t.meta && t.meta.partial) { skipT('Its size was not fully measured.'); continue; }
    if (paths.some(excluded)) { skipT('You excluded this folder.'); continue; }
    const where = paths.map(whereOf).find(Boolean);
    if (where) { skipT(where); continue; }
    const native = nativeTargets instanceof Set && nativeTargets.has(t.id);
    // A native command frees in place: it never needs the staging volume.
    if (!native && paths.some(offDisk)) { paths.forEach((p) => skip(p, OFF_DISK, { target: t.id, offDisk: true })); continue; }
    if (!procs.ok) { skipT('Spaci could not check which tools are running.'); continue; }
    const fam = TARGET_FAMILY[t.id];
    if (!fam) { skipT('Auto-clean leaves this cache to you.'); continue; }
    if (familyRunning(procs, fam)) { skipT(`A ${fam === 'node' ? 'package manager' : fam + ' tool'} is running.`); continue; }
    // The size belongs to the whole target; the first path carries it.
    const cmd = native ? nativeSpecs.commandLine(nativeSpecs.specFor(t.id), 'auto') : null;
    paths.forEach((p, i) => out.push({
      path: p, kind: 'cache', target: t.id, name: t.name, bytes: i === 0 ? bytes : 0, mode: 'contents',
      rule: `${t.name} larger than ${Math.round(s.minCacheBytes / MB)} MB` + (cmd ? `, cleaned with ${cmd}` : ''),
      group: tiers.A_TARGETS[t.id].group,
      ...(native ? { native: true } : {}),
    }));
  }

  // Biggest first, then fit under the caps. A target's paths stay together.
  const units = [];
  for (const c of out) {
    const last = units[units.length - 1];
    if (c.kind === 'cache' && last && last[0].kind === 'cache' && last[0].target === c.target) last.push(c);
    else units.push([c]);
  }
  const unitBytes = (u) => u.reduce((x, c) => x + c.bytes, 0);
  units.sort((x, y) => unitBytes(y) - unitBytes(x));
  const chosen = [];
  let total = 0;
  let items = 0;
  for (const u of units) {
    const b = unitBytes(u);
    if (total + b > s.maxRunBytes || items + 1 > s.maxItems) {
      u.forEach((c) => skip(c.path, 'Over this run\'s size or item cap. A later run may take it.', { cap: true }));
      continue;
    }
    total += b;
    items++;
    chosen.push(...u);
  }
  return { candidates: chosen, skipped, bytes: total, count: items };
}

// ---- evidence (fs) ----------------------------------------------------------

// Folders that never count as "the project was used": build output changes
// on every build, and .git objects are touched by fetches.
const IGNORED_FOR_ACTIVITY = new Set([
  ...Object.keys(tiers.ARTIFACT_GROUPS), 'venv', '.venv', '.git', '.svn', '.hg', '.idea', '.vscode', '.DS_Store',
]);

const COMPOSE_RE = /^(docker-)?compose[^/\\]*\.ya?ml$/i;

/**
 * mtimes that say git was used here: HEAD, index, the reflog, refs, and every
 * linked worktree's HEAD and index. A linked worktree (.git is a file) also
 * counts its main repository's, and the main repository counts its worktrees',
 * so committing in one keeps the other.
 */
async function gitActivityTimes(dir, fsp, refBudget = 2000) {
  const times = [];
  const see = async (p) => { try { times.push((await fsp.stat(p)).mtimeMs); } catch { /* absent */ } };
  const dotGit = nodePath.join(dir, '.git');
  const gitDirs = [];
  let st = null;
  try { st = await fsp.lstat(dotGit); } catch { return times; }
  if (st.isDirectory()) gitDirs.push(dotGit);
  else if (st.isFile()) {
    try {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fsp.readFile(dotGit, 'utf8'));
      if (m) {
        const own = nodePath.resolve(dir, m[1]);
        gitDirs.push(own);
        try {
          const common = (await fsp.readFile(nodePath.join(own, 'commondir'), 'utf8')).trim();
          if (common) gitDirs.push(nodePath.resolve(own, common));
        } catch { /* not a linked worktree */ }
      }
    } catch { /* unreadable .git file */ }
  }
  for (const g of new Set(gitDirs)) {
    for (const f of ['HEAD', 'index', 'FETCH_HEAD', 'ORIG_HEAD', nodePath.join('logs', 'HEAD')]) await see(nodePath.join(g, f));
    // refs: every folder and loose ref, bounded.
    let left = refBudget;
    const stack = [nodePath.join(g, 'refs')];
    while (stack.length && left > 0) {
      const d = stack.pop();
      await see(d);
      let ents;
      try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (--left <= 0) break;
        const full = nodePath.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else await see(full);
      }
    }
    await see(nodePath.join(g, 'packed-refs'));
    let wts = [];
    try { wts = await fsp.readdir(nodePath.join(g, 'worktrees')); } catch { /* none */ }
    for (const w of wts.slice(0, 200)) {
      for (const f of ['HEAD', 'index', nodePath.join('logs', 'HEAD')]) await see(nodePath.join(g, 'worktrees', w, f));
    }
  }
  return times;
}

/**
 * When was a project last used? The newest mtime of any file or folder in it,
 * leaving out build output, plus git activity (gitActivityTimes). Stops as
 * soon as it finds something newer than `staleMs`. If the walk runs past its
 * budget without deciding, lastActivity is null (inconclusive: skip the
 * project). `compose` is true when a Docker Compose file sits at its root.
 * @returns {Promise<{lastActivity:number|null, keep:boolean, compose:boolean}>}
 */
async function projectEvidence(dir, { fs = nodeFs, now = Date.now(), staleMs, budget = 40000, maxDepth = 14 } = {}) {
  const fsp = fs.promises;
  const exists = (p) => fsp.lstat(p).then(() => true, () => false);
  if (await exists(nodePath.join(dir, KEEP_MARKER))) return { lastActivity: null, keep: true, compose: false };
  const top = await fsp.readdir(dir).catch(() => []);
  const compose = top.some((n) => COMPOSE_RE.test(n));
  let newest = 0;
  const cutoff = now - staleMs;
  const see = (ms) => { if (typeof ms === 'number' && ms > newest) newest = ms; };
  try { see((await fsp.stat(dir)).mtimeMs); } catch { return { lastActivity: null, keep: false, compose }; }
  for (const t of await gitActivityTimes(dir, fsp)) see(t);
  if (newest > cutoff) return { lastActivity: newest, keep: false, compose };
  let seen = 0;
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > budget) return { lastActivity: null, keep: false, compose };
      if (IGNORED_FOR_ACTIVITY.has(e.name) || e.isSymbolicLink()) continue;
      const full = nodePath.join(d, e.name);
      try { see((await fsp.lstat(full)).mtimeMs); } catch { continue; }
      if (newest > cutoff) return { lastActivity: newest, keep: false, compose };
      if (e.isDirectory() && depth < maxDepth) stack.push({ d: full, depth: depth + 1 });
    }
  }
  return { lastActivity: newest || null, keep: false, compose };
}

/** The files beside an artifact (for lockfile rules) and its keep markers. */
async function itemEvidence(itemPath, { fs = nodeFs } = {}) {
  const fsp = fs.promises;
  const nearFiles = await fsp.readdir(nodePath.dirname(itemPath)).catch(() => null);
  if (!nearFiles) return null;
  const inside = await fsp.lstat(nodePath.join(itemPath, KEEP_MARKER)).then(() => true, () => false);
  return { nearFiles, keep: inside || nearFiles.includes(KEEP_MARKER) };
}

// ---- process snapshot -------------------------------------------------------

// Runtimes that run a script: the script's name counts too (node npm-cli.js
// is npm). Editor helpers are Electron running as node (tsserver, eslint).
const SCRIPT_HOSTS = /^(node|bun|deno|python3?|.* Helper \(Plugin\))$/i;
const cleanName = (t) => nodePath.basename(String(t).replace(/\\/g, '/')).replace(/\.(c|m)?js$/i, '').replace(/\.exe$/i, '');

/**
 * Names for a process from its executable (`ps -o comm=`, which keeps spaces)
 * and its command line (`ps -o args=`) for the script a runtime runs.
 */
function namesFrom(comm, args) {
  const names = [];
  const exe = String(comm || '').trim();
  if (exe) names.push(cleanName(exe));
  const a = String(args || '').trim();
  if (names[0] && SCRIPT_HOSTS.test(names[0]) && a) {
    // What follows the executable: strip it by its full path when args starts
    // with it, else by argv[0]'s first word.
    let rest = a.startsWith(exe) ? a.slice(exe.length) : a.replace(/^\S+/, '');
    rest = rest.trim();
    // A script path may hold spaces: take it up to its extension when it has one.
    const first = rest.split(/\s+/)[0];
    const withExt = /^(.+?\.(?:[cm]?js|[cm]?ts|py))(?=\s|$)/.exec(rest);
    const tok = first && !first.startsWith('-') && withExt ? withExt[1] : first;
    if (tok && !tok.startsWith('-')) {
      const sName = cleanName(tok).replace(/-cli$/, '');
      if (sName) names.push(sName);
    }
  }
  return names.filter(Boolean);
}

/**
 * Names from a command line alone (Windows image names, old callers). A macOS
 * app executable keeps its spaces ("Code Helper (Plugin)").
 */
function namesOf(args) {
  const a = String(args || '').trim();
  const app = /^(\/.*?\.app\/Contents\/(?:MacOS|Frameworks)\/.*?)(?=\s+[-/]|$)/.exec(a);
  if (app) return namesFrom(app[1], a);
  const exe = a.split(/\s+/)[0] || '';
  return namesFrom(exe, a);
}

/**
 * Parse `ps -axo pid=,uid=,comm=` (and, when given, `ps -axo pid=,args=` for
 * the command lines). With `uid`, only that user's processes are kept: another
 * user's process cannot be asked for its cwd, and cannot be running a build in
 * this user's projects without sudo. Without `argsOut` the third column is
 * taken as a command line (older callers).
 */
function parsePs(stdout, uid = null, argsOut = null) {
  const argsBy = new Map();
  if (argsOut != null) {
    for (const line of String(argsOut).split('\n')) {
      const m = line.match(/^\s*(\d+)\s(.*)$/);
      if (m) argsBy.set(Number(m[1]), m[2].trim());
    }
  }
  const list = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    if (uid != null && Number(m[2]) !== uid) continue;
    const pid = Number(m[1]);
    if (argsOut == null) { list.push({ pid, names: namesOf(m[3]), cwd: null, args: m[3].trim() }); continue; }
    const args = argsBy.has(pid) ? argsBy.get(pid) : null;
    list.push({ pid, names: namesFrom(m[3].trim(), args), cwd: null, args });
  }
  return list;
}

/** Parse `lsof -a -d cwd -p <pids> -Fpn`: p<pid> then n<path> lines. */
function parseLsofCwd(stdout) {
  const map = new Map();
  let pid = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid != null) map.set(pid, line.slice(1));
  }
  return map;
}

function run(exec, cmd, args, timeout) {
  return new Promise((resolve) => {
    try {
      exec(cmd, args, { timeout, maxBuffer: 16 * MB, windowsHide: true }, (err, stdout) => resolve({ err, stdout: String(stdout || '') }));
    } catch (err) { resolve({ err, stdout: '' }); }
  });
}

/**
 * Which developer tools run, where, and with what command line. Never rejects.
 * @returns {Promise<{ok:boolean, list:{pid:number,names:string[],cwd:string|null,args:string|null}[]}>}
 */
async function snapshotProcesses({ platform = process.platform, exec = execFile, fs = nodeFs, timeout = 8000, selfPid = process.pid,
  uid = typeof process.getuid === 'function' ? process.getuid() : null, names = DEV_PROCESS_NAMES } = {}) {
  const wanted = (p) => p.names.some((n) => names.has(n));
  try {
    if (platform === 'win32') {
      const r = await run(exec, 'tasklist', ['/fo', 'csv', '/nh'], timeout);
      if (r.err) return { ok: false, list: [] };
      const list = [];
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (m) list.push({ pid: Number(m[2]), names: namesOf(m[1]), cwd: null });
      }
      // Windows gives no cwd without admin: a dev process makes projects inconclusive.
      return { ok: true, list: list.filter(wanted) };
    }
    const [r, ra] = await Promise.all([
      run(exec, 'ps', ['-axo', 'pid=,uid=,comm='], timeout),
      run(exec, 'ps', ['-axo', 'pid=,args='], timeout),
    ]);
    if (r.err || ra.err) return { ok: false, list: [] };
    const dev = parsePs(r.stdout, uid, ra.stdout).filter((p) => p.pid !== selfPid && wanted(p));
    if (!dev.length) return { ok: true, list: [] };
    if (platform === 'linux') {
      await Promise.all(dev.map(async (p) => { p.cwd = await fs.promises.readlink(`/proc/${p.pid}/cwd`).catch(() => null); }));
    } else {
      const l = await run(exec, 'lsof', ['-a', '-d', 'cwd', '-p', dev.map((p) => p.pid).join(','), '-Fpn'], timeout);
      // lsof exits 1 when some pids vanished; whatever it printed still counts.
      // A process of ours that it could not answer for keeps cwd null, which
      // selection treats as "a tool runs somewhere": projects are skipped.
      const cwds = parseLsofCwd(l.stdout);
      for (const p of dev) p.cwd = cwds.get(p.pid) || null;
    }
    return { ok: true, list: dev };
  } catch {
    return { ok: false, list: [] };
  }
}

// ---- staging ----------------------------------------------------------------

/** Write JSON so that a crash leaves either the old or the new file, complete. */
function writeJsonDurable(fs, file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value));
    try { fs.fsyncSync(fd); } catch { /* not supported on this fs */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(nodePath.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } catch { /* directories cannot be fsynced on Windows */ }
    fs.closeSync(dfd);
  } catch { /* best effort */ }
}

const RUN_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

/**
 * The staging area: root/<runId>/manifest.json and root/<runId>/items/<n>/<name>.
 *
 * Each move is journaled before and after the rename:
 *   entry 'moving'  (written)  ->  rename(src, dst)  ->  entry 'moved' (written)
 * and each restore the same way ('restoring' -> rename back -> 'restored').
 * rename is atomic on one volume, so after a crash recover() can always tell
 * where an item is by looking at which of src and dst exists.
 *
 * @param {object} o
 * @param {string} o.root  on the same volume as what it stages (checked per item)
 * @param {(p:string) => Promise<any>} o.removeTree  deletes a staged tree (cleaner.deletePath)
 */
function createStaging({ root, fs = nodeFs, now = () => Date.now(), ttlMs = STAGING_TTL_MS, removeTree, log = console }) {
  const fsp = fs.promises;
  const manifestPath = (runId) => nodePath.join(root, runId, 'manifest.json');
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

  function readManifest(runId) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath(runId), 'utf8'));
      return m && m.runId === runId && Array.isArray(m.entries) ? m : null;
    } catch { return null; }
  }
  function save(m) { writeJsonDurable(fs, manifestPath(m.runId), m); }

  function runIds() {
    let names = [];
    try { names = fs.readdirSync(root); } catch { return []; }
    return names.filter((n) => RUN_ID_RE.test(n));
  }

  function rootDev() {
    fs.mkdirSync(root, { recursive: true });
    return fs.statSync(root).dev;
  }

  /** Start a run. Its manifest exists before anything moves. */
  function beginRun(runId, meta = {}) {
    if (!RUN_ID_RE.test(runId)) throw new Error('bad run id');
    fs.mkdirSync(nodePath.join(root, runId, 'items'), { recursive: true });
    const t = now();
    const m = { v: 1, runId, createdAt: t, expiresAt: t + ttlMs, state: 'active', meta, entries: [] };
    save(m);
    return m;
  }

  /**
   * Move one path into the run. Never throws.
   * @returns {{ok:boolean, entry?:object, reason?:string, code?:string}}
   */
  function stage(m, src, info = {}) {
    let st;
    try { st = fs.lstatSync(src); } catch (e) { return { ok: false, reason: 'It is already gone.', code: e.code }; }
    if (st.isSymbolicLink()) return { ok: false, reason: 'It is a symbolic link.', code: 'ELINK' };
    let dev;
    try { dev = rootDev(); } catch (e) { return { ok: false, reason: 'Spaci could not prepare its staging folder.', code: e.code }; }
    if (st.dev !== dev) return { ok: false, reason: 'It is on a different volume than Spaci\'s staging folder.', code: 'EXDEV' };
    const n = m.entries.length + 1;
    const dst = nodePath.join(root, m.runId, 'items', String(n), nodePath.basename(src));
    const entry = { n, src, dst, bytes: Math.max(0, Number(info.bytes) || 0), state: 'moving', ...pickInfo(info) };
    m.entries.push(entry);
    try {
      fs.mkdirSync(nodePath.dirname(dst), { recursive: true });
      save(m); // intent first
    } catch (e) {
      m.entries.pop();
      return { ok: false, reason: 'Spaci could not write its staging journal.', code: e.code };
    }
    try {
      fs.renameSync(src, dst);
    } catch (e) {
      entry.state = 'failed';
      entry.code = e.code;
      try { save(m); } catch { /* recover() settles it: src still exists */ }
      return { ok: false, entry, reason: e.code === 'EXDEV' ? 'It is on a different volume.' : 'Spaci could not move it.', code: e.code };
    }
    entry.state = 'moved';
    try { save(m); } catch (e) { log.warn && log.warn('[auto-clean] journal write after move failed', e && e.message); }
    return { ok: true, entry };
  }

  /**
   * Put back entries this run just moved (a cache whose later child failed),
   * newest first, journaled like an undo. Never throws.
   * @returns {{restored:object[], failed:object[]}}
   */
  function unstage(m, entries) {
    const res = { restored: [], failed: [] };
    for (const e of [...entries].reverse()) {
      if (e.state !== 'moved') continue;
      if (exists(e.src)) { e.reason = 'Something new took its place, so it stayed staged.'; res.failed.push(e); continue; }
      e.state = 'restoring';
      try { save(m); } catch { /* recover() settles it by looking at src and dst */ }
      try {
        fs.renameSync(e.dst, e.src);
        e.state = 'restored';
        e.rolledBack = true;
        res.restored.push(e);
      } catch (err) {
        e.state = 'moved';
        e.code = err.code;
        res.failed.push(e);
      }
      try { save(m); } catch (err) { log.warn && log.warn('[auto-clean] journal write after roll back failed', err && err.message); }
    }
    if (res.failed.length) {
      // What stays is only part of the measured size, and which part is unknown:
      // count none of it rather than all of it.
      for (const e of res.failed) e.bytes = 0;
      try { save(m); } catch { /* sizes are informational */ }
    }
    return res;
  }

  /** Is p on the staging folder's volume? null when either cannot be checked. */
  function sameDisk(p) {
    try { return fs.lstatSync(p).dev === rootDev(); } catch { return null; }
  }

  function pickInfo(info) {
    const o = {};
    for (const k of ['kind', 'project', 'target', 'group', 'name', 'rule']) if (typeof info[k] === 'string') o[k] = info[k];
    return o;
  }

  /** Settle entries left half-way by a crash. Returns what changed. */
  function recoverRun(m) {
    let changed = false;
    for (const e of m.entries) {
      if (e.state === 'moving') {
        const s = exists(e.src); const d = exists(e.dst);
        e.state = d ? 'moved' : s ? 'skipped' : 'missing';
        changed = true;
      } else if (e.state === 'restoring') {
        const s = exists(e.src); const d = exists(e.dst);
        e.state = d ? 'moved' : s ? 'restored' : 'missing';
        changed = true;
      } else if (e.state === 'failed' && !exists(e.dst) && exists(e.src)) {
        // The rename never happened; nothing to settle.
      }
    }
    if (m.state === 'restoring') {
      m.state = m.entries.some((e) => e.state === 'moved') ? 'active' : 'restored';
      changed = true;
    }
    return changed;
  }

  /** On launch: settle every run. Never throws. */
  function recover() {
    const out = [];
    for (const id of runIds()) {
      const m = readManifest(id);
      if (!m) { out.push({ runId: id, state: 'unreadable' }); continue; }
      try { if (recoverRun(m)) save(m); } catch (e) { log.error && log.error('[auto-clean] recover failed', id, e && e.message); }
      out.push({ runId: id, state: m.state });
    }
    return out;
  }

  const holdsData = (e) => e.state === 'moved' || e.state === 'conflict';

  /**
   * Put a run back. An item whose original place has been filled again (the
   * user reinstalled) is not overwritten: it stays staged as a conflict and is
   * purged with the run. A missing parent folder is not recreated.
   */
  function restore(runId) {
    const res = { ok: false, restored: [], conflicts: [], failed: [] };
    if (!RUN_ID_RE.test(String(runId))) return { ...res, error: 'Unknown auto-clean run.' };
    const m = readManifest(runId);
    if (!m) return { ...res, error: 'Spaci has no staged items for this run.' };
    if (m.state === 'purged' || m.state === 'purging') return { ...res, error: 'This run was already cleaned up and cannot be undone.' };
    if (now() >= m.expiresAt) return { ...res, error: 'The 24 hours to undo this run have passed.' };
    m.state = 'restoring';
    save(m);
    for (const e of m.entries) {
      if (e.state !== 'moved') continue;
      if (exists(e.src)) { e.state = 'conflict'; e.reason = 'It was rebuilt since, so the new one was kept.'; res.conflicts.push(e); save(m); continue; }
      if (!exists(nodePath.dirname(e.src))) { e.state = 'conflict'; e.reason = 'Its folder no longer exists.'; res.conflicts.push(e); save(m); continue; }
      e.state = 'restoring';
      save(m);
      try {
        fs.renameSync(e.dst, e.src);
        e.state = 'restored';
        res.restored.push(e);
      } catch (err) {
        e.state = 'moved';
        e.code = err.code;
        res.failed.push(e);
      }
      save(m);
    }
    m.state = m.entries.some((e) => e.state === 'moved') ? 'active' : 'restored';
    m.restoredAt = now();
    save(m);
    res.ok = res.failed.length === 0;
    res.state = m.state;
    return res;
  }

  /**
   * Delete expired runs (and runs with nothing left to hold). The manifest is
   * marked 'purging' first, so a crash mid-purge simply resumes next time.
   * @returns {Promise<{runId:string, bytes:number, entries:object[]}[]>}
   */
  async function purge({ force = false } = {}) {
    const done = [];
    for (const id of runIds()) {
      const m = readManifest(id);
      if (!m) continue; // never delete what we cannot account for
      const empty = !m.entries.some(holdsData);
      const expired = now() >= m.expiresAt;
      if (!(force || expired || m.state === 'purging' || (empty && m.state !== 'active'))) continue;
      if (m.state !== 'purging') { m.state = 'purging'; save(m); }
      const bytes = m.entries.filter(holdsData).reduce((s, e) => s + (e.bytes || 0), 0);
      const purgedEntries = m.entries.filter(holdsData);
      try {
        await removeTree(nodePath.join(root, id, 'items'));
      } catch (e) {
        log.error && log.error('[auto-clean] purge failed', id, e && e.message);
        continue;
      }
      if (exists(nodePath.join(root, id, 'items'))) continue; // partly removed; retry later
      try { await fsp.rm(nodePath.join(root, id), { recursive: true, force: true }); } catch { /* retried next time */ }
      done.push({ runId: id, bytes, entries: purgedEntries, restored: m.entries.filter((e) => e.state === 'restored').length });
    }
    return done;
  }

  function status(runId) {
    const m = readManifest(runId);
    if (!m) return null;
    const held = m.entries.filter(holdsData);
    return {
      runId, state: m.state, createdAt: m.createdAt, expiresAt: m.expiresAt,
      held: held.length, heldBytes: held.reduce((s, e) => s + (e.bytes || 0), 0),
      canUndo: m.state === 'active' && now() < m.expiresAt && m.entries.some((e) => e.state === 'moved'),
    };
  }

  function list() { return runIds().map(status).filter(Boolean); }

  /** True when p is the staging area or inside it (scans must skip it). */
  function contains(p) { return isInsideOrSame(root, p); }

  return { root, beginRun, stage, unstage, sameDisk, recover, restore, purge, status, list, contains, readManifest };
}

// ---- the run ----------------------------------------------------------------

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Math.max(0, Number(n) || 0);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}

/**
 * Does `dir` hold something that must survive: a protected basename at any
 * depth, or an excluded path? Then it is left in place whole. A walk that runs
 * past its budget answers yes (fail closed).
 */
async function holdsProtected(dir, { protect, excludes, fs = nodeFs, budget = 50000 }) {
  if (excludes.some((x) => isInsideOrSame(dir, x))) return true;
  if (!protect.size) return false;
  if (protect.has(nodePath.basename(dir).toLowerCase())) return true;
  const fsp = fs.promises;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) {
      if (d === dir && e && e.code === 'ENOTDIR') return false;
      continue;
    }
    for (const e of ents) {
      if (++seen > budget) return true;
      if (protect.has(e.name.toLowerCase())) return true;
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(nodePath.join(d, e.name));
    }
  }
  return false;
}

/** The preview a user may approve: a dry run that found something, for the current rules. */
function approvalCheck(settings, entry, previewId) {
  const s = sanitizeSettings(settings);
  if (!s.pendingPreview || s.pendingPreview !== previewId) return { ok: false, error: 'This preview is out of date. A new one runs with your current rules.' };
  const a = entry && entry.autoClean;
  if (!a || !a.dryRun || a.rules !== rulesFingerprint(s)) return { ok: false, clearPending: true, error: 'Your rules changed since this preview. A new one runs with your current rules.' };
  if (!(Number(a.previewCount) > 0)) return { ok: false, clearPending: true, error: 'This preview found nothing to move, so there is nothing to approve yet. A new preview runs later.' };
  return { ok: true };
}

/**
 * One scheduled run. Every dependency is injected (see main.js for the real
 * ones). Returns a scheduler status: 'ok' | 'partial' | 'skipped' | 'failed'.
 *
 * deps: getSettings, saveSettings, getScan, gatherEvidence, snapshot,
 *   aiToolStatus, dockerStatus() -> {ok, running}, cloudCheck(paths) -> Map,
 *   guard(jobs) -> {allowed, refused}, staging, historyLog,
 *   putHistory(entry), notify(title, body), stillOk() -> reason|null,
 *   listChildren(dir), restoreHint(candidate), now, newId, onStaged(paths), fs
 */
async function runAutoClean(deps) {
  const {
    getSettings, saveSettings, getScan, gatherEvidence, snapshot, aiToolStatus, guard,
    staging, historyLog, putHistory, notify = () => {}, stillOk = () => null,
    listChildren, restoreHint = () => null, now = () => Date.now(), newId, onStaged = () => {},
    nativeClean = null,
    dockerStatus = async () => ({ ok: false, running: 0 }),
    cloudCheck = (paths) => cloudReasons(paths),
    fs = nodeFs,
  } = deps;
  const settings = sanitizeSettings(getSettings());
  if (!settings.enabled) return { status: 'skipped', reason: 'disabled' };
  const scan = getScan() || {};
  const t0 = now();
  const scanPaths = [
    ...(scan.projects || []).map((p) => p && p.path),
    ...(scan.system || []).flatMap((t) => (t && Array.isArray(t.existingPaths) ? t.existingPaths : [])),
  ].filter((p) => typeof p === 'string');
  const [ev, procs, ai, docker, cloud] = await Promise.all([
    gatherEvidence(scan.projects || [], settings),
    snapshot(),
    aiToolStatus().catch(() => ({ ok: false, running: [] })),
    Promise.resolve().then(dockerStatus).catch(() => ({ ok: false, running: 0 })),
    // A failed cloud check leaves every path unknown, which fails closed below.
    Promise.resolve().then(() => cloudCheck(scanPaths)).catch(() => null),
  ]);
  const cloudOf = cloud instanceof Map ? (p) => cloud.get(p) || null : () => 'Spaci could not check whether it is in a cloud-synced folder.';
  const sameDisk = typeof staging.sameDisk === 'function' ? (p) => staging.sameDisk(p) : null;
  const sel = selectCandidates({
    projects: scan.projects || [], system: scan.system || [], settings, now: t0,
    evidence: ev.evidence, itemEvidence: ev.itemEvidence, procs, aiTools: ai, docker, cloudOf, sameDisk,
    nativeTargets: typeof nativeClean === 'function' ? NATIVE_AUTO : null,
  });

  // ---- dry run: report, touch nothing, wait for approval ----
  if (!isApproved(settings)) {
    // An empty preview is not offered for approval: approving "nothing" would
    // let the first real run move whatever matches later, unseen.
    if (!sel.count) {
      saveSettings({ ...settings, pendingPreview: null });
      return { status: 'ok', dryRun: true, historyId: null, count: 0, bytes: 0 };
    }
    const id = newId();
    const preview = sel.candidates.map((c) => ({ path: c.path, bytes: c.bytes, kind: c.kind, rule: c.rule, group: c.group, ...(c.project ? { project: c.project } : {}) }));
    const entry = historyLog.finishedEntry({
      id, at: t0, finishedAt: now(), status: 'done', scope: 'auto-clean', label: 'Auto-clean preview',
      requested: 0, items: [],
      extra: { autoClean: { dryRun: true, rules: rulesFingerprint(settings), previewCount: sel.count, previewBytes: sel.bytes, preview: preview.slice(0, 500), skippedCount: sel.skipped.filter((x) => !x.quiet).length } },
    });
    putHistory(entry);
    saveSettings({ ...settings, pendingPreview: id });
    notify('Auto-clean preview', `It would move ${fmtBytes(sel.bytes)} from ${sel.count} ${sel.count === 1 ? 'item' : 'items'}. Nothing was removed. Approve it in History.`);
    return { status: 'ok', dryRun: true, historyId: id, count: sel.count, bytes: sel.bytes };
  }
  if (!sel.candidates.length) return { status: 'ok', count: 0, bytes: 0 };

  // ---- the guard: main's clean rules stay authoritative ----
  const jobs = sel.candidates.map((c) => ({ path: c.path, ...(c.mode ? { mode: c.mode } : {}) }));
  let guarded;
  try { guarded = await guard(jobs); } catch (e) { return { status: 'failed', error: e && e.message }; }
  const allowedBy = new Map(guarded.allowed.map((j) => [j.path, j]));
  const refused = guarded.refused || [];

  const runId = newId();
  const byPath = new Map(sel.candidates.map((c) => [c.path, c]));
  const describe = (c) => ({
    path: c.path, kind: c.kind === 'artifact' ? 'artifact' : 'cache', reversible: 'rebuild',
    ...(c.project ? { project: c.project } : {}),
    restoreHint: 'Undo from History within 24 hours. ' + (restoreHint(c) || ''),
  });
  const refusedItems = refused.map((r) => ({ ...describe(byPath.get(r.path) || { path: r.path, kind: 'cache' }), outcome: 'refused', bytes: 0, reason: r.reason }));
  const pending = sel.candidates.filter((c) => allowedBy.has(c.path)).map(describe);
  const stagedUntil = t0 + STAGING_TTL_MS;
  const acMeta = { runId, stagedUntil, rules: rulesFingerprint(settings) };
  const started = { id: runId, at: t0, scope: 'auto-clean', label: 'Auto-clean', requested: sel.candidates.length };
  putHistory({ ...historyLog.startedEntry({ ...started, refused: refusedItems, pending }), autoClean: acMeta });

  let m;
  try { m = staging.beginRun(runId, { at: t0 }); } catch (e) {
    const items = [...refusedItems, ...pending.map((p) => ({ ...p, outcome: 'failed', bytes: 0, reason: 'Spaci could not prepare its staging folder.' }))];
    putHistory(historyLog.finishedEntry({ ...started, finishedAt: now(), items, extra: { autoClean: acMeta } }));
    return { status: 'failed', error: e && e.message };
  }

  const items = [...refusedItems];
  const leave = (c, reason) => items.push({ ...describe(c), outcome: 'refused', bytes: 0, reason });
  const userExcludes = settings.excludes;
  let stopped = null;
  const movedBy = new Map(); // candidate path -> entries still staged
  const nativeDone = new Set(); // target ids already handed to their tool
  let nativeFreed = 0;
  let nativeCount = 0;
  for (const c of sel.candidates) {
    const job = allowedBy.get(c.path);
    if (!job) continue;
    if (c.native && nativeDone.has(c.target)) continue;
    if (stopped) { items.push({ ...describe(c), outcome: 'failed', bytes: 0, reason: 'Not moved: ' + stopped }); continue; }
    const why = stillOk();
    if (why) { stopped = why; items.push({ ...describe(c), outcome: 'failed', bytes: 0, reason: 'Not moved: ' + why }); continue; }
    // The snapshot above may be minutes old by now: ask again right before this move.
    let fresh;
    try { fresh = await snapshot(); } catch { fresh = { ok: false, list: [] }; }
    if (!fresh || !fresh.ok) { leave(c, 'Spaci could not check which tools are running.'); continue; }
    if (c.kind === 'artifact') {
      const busy = projectBusy(fresh, c.project);
      if (busy) { leave(c, busy); continue; }
    } else {
      const fam = TARGET_FAMILY[c.target];
      if (!fam || familyRunning(fresh, fam)) { leave(c, `A ${fam === 'node' ? 'package manager' : (fam || 'developer') + ' tool'} started running.`); continue; }
    }
    if (c.native && typeof nativeClean === 'function') {
      // Every path of this target in one run of its tool, which checks again
      // that it is idle. Freed in place: nothing to undo, nothing staged.
      nativeDone.add(c.target);
      const mine = sel.candidates.filter((x) => x.target === c.target && allowedBy.has(x.path));
      let r;
      try { r = await nativeClean(c.target, mine.map((x) => allowedBy.get(x.path))); }
      catch (e) { r = { items: mine.map((x) => ({ path: x.path, outcome: 'failed', bytes: 0, reason: (e && e.message) || 'The cleanup did not run.' })) }; }
      for (const n of (r && Array.isArray(r.items) ? r.items : [])) {
        const cand = mine.find((x) => x.path === n.path) || c;
        items.push({ ...describe(cand), ...n, restoreHint: n.restoreHint || undefined });
        if (n.outcome === 'removed') { nativeFreed += n.bytes || 0; if (n.bytes) nativeCount++; }
      }
      if (r && Array.isArray(r.items) && r.items.some((n) => n.outcome === 'failed')) stopped = 'an earlier item failed, so the run stopped.';
      continue;
    }
    const protect = new Set([...(job.protect || [])].map((x) => String(x).toLowerCase()));
    const excludes = [...(job.excludePaths || []), ...userExcludes];
    let ok = true;
    let reason = null;
    let code = null;
    let offDisk = false;
    const moved = [];
    let leftInside = 0;
    if (job.mode === 'contents') {
      let names = [];
      try { names = await listChildren(c.path); } catch (e) { ok = false; reason = 'Spaci could not read it.'; code = e.code; }
      for (const n of names) {
        const child = nodePath.join(c.path, n);
        if (protect.has(n.toLowerCase()) || excludes.includes(child) || n === '.DS_Store') continue;
        // A protected name or an excluded path anywhere inside: leave the child whole.
        if (await holdsProtected(child, { protect, excludes, fs })) { leftInside++; continue; }
        // The target's size rides on its first moved child, so undo and purge count it once.
        const r = staging.stage(m, child, { ...c, bytes: moved.length ? 0 : c.bytes });
        if (r.ok) moved.push(r.entry);
        else if (r.code === 'ENOENT') continue;
        else if (r.code === 'EXDEV') { leftInside++; continue; } // a mount inside: leave it
        else { ok = false; reason = r.reason; code = r.code; break; }
      }
    } else if (await holdsProtected(c.path, { protect, excludes, fs })) {
      leave(c, 'It holds something protected or excluded, so it was left in place.');
      continue;
    } else {
      const r = staging.stage(m, c.path, c);
      if (r.ok) moved.push(r.entry);
      else if (r.code === 'EXDEV') offDisk = true;
      else { ok = false; reason = r.reason; code = r.code; }
    }
    if (offDisk) { leave(c, 'It is on another disk than Spaci\'s staging folder, so it cannot be set aside for undo.'); continue; }
    if (!ok && moved.length) {
      // Half a cache is worse than none: put the moved children back.
      const back = staging.unstage(m, moved);
      if (back.failed.length) {
        // Could not put everything back: what stays staged is listed and can be undone.
        movedBy.set(c.path, back.failed);
        items.push({ ...describe(c), outcome: 'trashed', bytes: 0, partial: true, reason: `Partly moved: ${reason || 'a part could not be moved'} Undo puts back what moved.`, code: code || undefined });
        stopped = 'an earlier item failed, so the run stopped.';
        continue;
      }
    }
    if (!ok) {
      items.push({ ...describe(c), outcome: 'failed', bytes: 0, reason: reason || 'Could not be moved.', code: code || undefined });
      stopped = 'an earlier item failed, so the run stopped.';
      continue;
    }
    if (!moved.length) { leave(c, leftInside ? 'Everything in it is protected, excluded or on another disk.' : 'It was already empty.'); continue; }
    movedBy.set(c.path, moved);
    // 'trashed': still on disk until the staging folder is purged, so it is
    // not counted as freed yet (history-log tallies it apart).
    items.push({ ...describe(c), outcome: 'trashed', bytes: c.bytes, ...(leftInside ? { partial: true, reason: `${leftInside} protected or excluded ${leftInside === 1 ? 'entry was' : 'entries were'} left in place.` } : {}) });
  }
  // What the manifest says is staged, not what the loop hoped: that is what
  // Undo can put back and what the purge will delete.
  const man = staging.readManifest(runId);
  const heldPaths = [];
  let stagedBytes = 0;
  if (man) {
    const held = man.entries.filter((e) => e.state === 'moved');
    for (const [p, entries] of movedBy) {
      const mine = held.filter((e) => entries.some((x) => x.n === e.n));
      if (mine.length) { heldPaths.push(p); stagedBytes += mine.reduce((sum, e) => sum + (e.bytes || 0), 0); }
    }
  } else {
    for (const [p, entries] of movedBy) { heldPaths.push(p); stagedBytes += entries.reduce((sum, e) => sum + (e.bytes || 0), 0); }
  }
  const stagedCount = heldPaths.length;
  putHistory(historyLog.finishedEntry({ ...started, finishedAt: now(), status: 'done', items, extra: { autoClean: { ...acMeta, stagedBytes, stagedCount } } }));
  onStaged(heldPaths);
  const partlyNote = items.some((it) => it.partial && it.bytes === 0 && it.outcome === 'trashed') ? ' Part of one item could not be moved back; it is listed in History.' : '';
  if (nativeFreed > 0) {
    notify('Auto-clean', `Freed ${fmtBytes(nativeFreed)} with each tool's own cleanup command.${stagedCount ? '' : (stopped ? ' It stopped early: ' + stopped : '')}`);
  }
  if (stagedCount) {
    notify('Auto-clean', `Moved ${stagedBytes ? fmtBytes(stagedBytes) + ' from ' : ''}${stagedCount} ${stagedCount === 1 ? 'item' : 'items'} aside. The space is freed in 24 hours. Undo it from History until then.${stopped ? ' It stopped early: ' + stopped : ''}${partlyNote}`);
  } else if (stopped && !nativeFreed) {
    notify('Auto-clean', 'Auto-clean stopped before moving anything: ' + stopped);
  }
  return { status: stopped ? 'partial' : 'ok', runId, count: stagedCount + nativeCount, bytes: stagedBytes + nativeFreed, stopped };
}

module.exports = {
  DEFAULT_SETTINGS, STAGING_TTL_MS, KEEP_MARKER, NATIVE_AUTO, AUTO_ARTIFACTS, TOOL_FAMILIES, TARGET_FAMILY, DEV_PROCESS_NAMES, AI_CODING_TOOLS,
  sanitizeSettings, rulesFingerprint, isApproved, approvalCheck, autoCleanGate, selectCandidates,
  projectEvidence, itemEvidence, gitActivityTimes, snapshotProcesses, parsePs, parseLsofCwd, namesOf, namesFrom,
  projectBusy, familyRunning, argsMention, cloudOrExternal, cloudReason, cloudReasons, envCloudRoots, holdsProtected,
  createStaging, writeJsonDurable, runAutoClean, fmtBytes, isInsideOrSame,
};
