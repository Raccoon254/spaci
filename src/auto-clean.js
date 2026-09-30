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

function isApproved(s) {
  const x = sanitizeSettings(s);
  return Boolean(x.approved && x.approved.rules === rulesFingerprint(x));
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
  gradle: 'jvm', 'gradle-wrapper': 'jvm', maven: 'jvm',
  cargo: 'rust', pip: 'python', go: 'go',
  cocoapods: 'apple', 'xcode-derived': 'apple',
  pub: 'dart', 'dart-server': 'dart', nuget: 'dotnet',
});

/** Anything that builds or runs code: its cwd inside a project keeps that project. */
const DEV_PROCESS_NAMES = new Set([
  'node', 'next', 'vite', 'webpack', 'tsc', 'turbo', 'nuxt', 'esbuild',
  'python', 'python3', 'pytest', 'mypy', 'ruby', 'bundle', 'php', 'composer', 'docker', 'docker-compose',
  ...Object.values(TOOL_FAMILIES).flat(),
]);

// AI coding CLIs run builds inside projects. While one runs, no project is
// touched: its child processes come and go faster than a snapshot can see.
const AI_CODING_TOOLS = new Set(['claude', 'codex', 'opencode', 'gemini', 'grok']);

const CLOUD_SEGMENTS = ['/Library/Mobile Documents/', '/Library/CloudStorage/', '/Dropbox/', '/OneDrive/', '/Google Drive/', '/iCloud Drive/', '\\OneDrive\\', '\\Dropbox\\'];

function isInsideOrSame(parent, child) {
  if (!parent || !child) return false;
  const api = /^[a-zA-Z]:[\\/]/.test(parent) || parent.includes('\\') ? nodePath.win32 : nodePath.posix;
  const rel = api.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

function cloudOrExternal(p) {
  const s = String(p);
  if (CLOUD_SEGMENTS.some((seg) => s.includes(seg))) return 'It is in a cloud-synced folder.';
  if (s.startsWith('/Volumes/') || s.startsWith('/media/') || s.startsWith('/mnt/') || s.startsWith('/run/media/')) return 'It is on an external or network volume.';
  return null;
}

/**
 * A process snapshot: { ok, list: [{ pid, names: [..], cwd: string|null }] }.
 * ok is false when the snapshot itself failed.
 */
function familyRunning(procs, family) {
  const names = new Set(TOOL_FAMILIES[family] || []);
  return procs.list.some((p) => p.names.some((n) => names.has(n)));
}

/** { blocked: reason|null } for one project, from the snapshot. */
function projectBusy(procs, projectPath) {
  for (const p of procs.list) {
    if (!p.names.some((n) => DEV_PROCESS_NAMES.has(n))) continue;
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
 */
function selectCandidates({ projects = [], system = [], settings, now, evidence = new Map(), itemEvidence = new Map(), procs = { ok: false, list: [] }, aiTools = { ok: false, running: [] } }) {
  const s = sanitizeSettings(settings);
  const staleMs = s.staleDays * DAY;
  const out = [];
  const skipped = [];
  const skip = (path, reason, extra = {}) => skipped.push({ path, reason, ...extra });
  const excluded = (p) => s.excludes.some((x) => isInsideOrSame(x, p));
  const aiRunning = (aiTools.running || []).filter((t) => AI_CODING_TOOLS.has(t));

  for (const proj of Array.isArray(projects) ? projects : []) {
    if (!proj || typeof proj.path !== 'string') continue;
    const a = (Array.isArray(proj.items) ? proj.items : []).filter((it) => it && tiers.tierOfProjectItem(it).tier === 'A');
    if (!a.length) continue;
    const skipAll = (reason) => a.forEach((it) => skip(it.path, reason, { project: proj.path }));
    if (excluded(proj.path)) { skipAll('You excluded this folder.'); continue; }
    const where = cloudOrExternal(proj.path);
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
    const where = paths.map(cloudOrExternal).find(Boolean);
    if (where) { skipT(where); continue; }
    if (!procs.ok) { skipT('Spaci could not check which tools are running.'); continue; }
    const fam = TARGET_FAMILY[t.id];
    if (!fam) { skipT('Auto-clean leaves this cache to you.'); continue; }
    if (familyRunning(procs, fam)) { skipT(`A ${fam === 'node' ? 'package manager' : fam + ' tool'} is running.`); continue; }
    // The size belongs to the whole target; the first path carries it.
    paths.forEach((p, i) => out.push({
      path: p, kind: 'cache', target: t.id, name: t.name, bytes: i === 0 ? bytes : 0, mode: 'contents',
      rule: `${t.name} larger than ${Math.round(s.minCacheBytes / MB)} MB`,
      group: tiers.A_TARGETS[t.id].group,
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

/**
 * When was a project last used? The newest mtime of any file or folder in it,
 * leaving out build output, plus git's HEAD and index. Stops as soon as it
 * finds something newer than `staleMs`. If the walk runs past its budget
 * without deciding, lastActivity is null (inconclusive: skip the project).
 * @returns {Promise<{lastActivity:number|null, keep:boolean}>}
 */
async function projectEvidence(dir, { fs = nodeFs, now = Date.now(), staleMs, budget = 40000, maxDepth = 14 } = {}) {
  const fsp = fs.promises;
  const exists = (p) => fsp.lstat(p).then(() => true, () => false);
  if (await exists(nodePath.join(dir, KEEP_MARKER))) return { lastActivity: null, keep: true };
  let newest = 0;
  const cutoff = now - staleMs;
  const see = (ms) => { if (typeof ms === 'number' && ms > newest) newest = ms; };
  try { see((await fsp.stat(dir)).mtimeMs); } catch { return { lastActivity: null, keep: false }; }
  for (const f of ['HEAD', 'index', 'FETCH_HEAD', 'ORIG_HEAD']) {
    try { see((await fsp.stat(nodePath.join(dir, '.git', f))).mtimeMs); } catch { /* not a repo, or a worktree */ }
  }
  if (newest > cutoff) return { lastActivity: newest, keep: false };
  let seen = 0;
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.pop();
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > budget) return { lastActivity: null, keep: false };
      if (IGNORED_FOR_ACTIVITY.has(e.name) || e.isSymbolicLink()) continue;
      const full = nodePath.join(d, e.name);
      try { see((await fsp.lstat(full)).mtimeMs); } catch { continue; }
      if (newest > cutoff) return { lastActivity: newest, keep: false };
      if (e.isDirectory() && depth < maxDepth) stack.push({ d: full, depth: depth + 1 });
    }
  }
  return { lastActivity: newest || null, keep: false };
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

function namesOf(args) {
  const tok = String(args || '').trim().split(/\s+/).filter(Boolean);
  const names = [];
  const clean = (t) => nodePath.basename(t).replace(/\.(c|m)?js$/i, '').replace(/\.exe$/i, '');
  if (tok[0]) names.push(clean(tok[0]));
  // node /path/to/npm-cli.js install -> also "npm"
  if (tok[1] && !tok[1].startsWith('-') && /^(node|bun|deno|python3?)$/i.test(names[0] || '')) {
    const s = clean(tok[1]).replace(/-cli$/, '');
    if (s) names.push(s);
  }
  return names.filter(Boolean);
}

/** Parse `ps -axo pid=,args=` output. */
function parsePs(stdout) {
  const list = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    list.push({ pid: Number(m[1]), names: namesOf(m[2]), cwd: null });
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
 * Which developer tools run, and where. Never rejects.
 * @returns {Promise<{ok:boolean, list:{pid:number,names:string[],cwd:string|null}[]}>}
 */
async function snapshotProcesses({ platform = process.platform, exec = execFile, fs = nodeFs, timeout = 8000, selfPid = process.pid } = {}) {
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
      return { ok: true, list: list.filter((p) => p.names.some((n) => DEV_PROCESS_NAMES.has(n))) };
    }
    const r = await run(exec, 'ps', ['-axo', 'pid=,args='], timeout);
    if (r.err) return { ok: false, list: [] };
    const dev = parsePs(r.stdout).filter((p) => p.pid !== selfPid && p.names.some((n) => DEV_PROCESS_NAMES.has(n)));
    if (!dev.length) return { ok: true, list: [] };
    if (platform === 'linux') {
      await Promise.all(dev.map(async (p) => { p.cwd = await fs.promises.readlink(`/proc/${p.pid}/cwd`).catch(() => null); }));
    } else {
      const l = await run(exec, 'lsof', ['-a', '-d', 'cwd', '-p', dev.map((p) => p.pid).join(','), '-Fpn'], timeout);
      // lsof exits 1 when some pids vanished; whatever it printed still counts.
      const cwds = parseLsofCwd(l.stdout);
      for (const p of dev) p.cwd = cwds.get(p.pid) || null;
      // A process that exited between ps and lsof has no cwd and no longer runs.
      if (!l.err || cwds.size) return { ok: true, list: dev.filter((p) => p.cwd != null || cwds.size === 0) };
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

  return { root, beginRun, stage, recover, restore, purge, status, list, contains, readManifest };
}

// ---- the run ----------------------------------------------------------------

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Math.max(0, Number(n) || 0);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}

/**
 * One scheduled run. Every dependency is injected (see main.js for the real
 * ones). Returns a scheduler status: 'ok' | 'partial' | 'skipped' | 'failed'.
 *
 * deps: getSettings, saveSettings, getScan, gatherEvidence, snapshot,
 *   aiToolStatus, guard(jobs) -> {allowed, refused}, staging, historyLog,
 *   putHistory(entry), notify(title, body), stillOk() -> reason|null,
 *   listChildren(dir), restoreHint(candidate), now, newId, onStaged(paths)
 */
async function runAutoClean(deps) {
  const {
    getSettings, saveSettings, getScan, gatherEvidence, snapshot, aiToolStatus, guard,
    staging, historyLog, putHistory, notify = () => {}, stillOk = () => null,
    listChildren, restoreHint = () => null, now = () => Date.now(), newId, onStaged = () => {},
  } = deps;
  const settings = sanitizeSettings(getSettings());
  if (!settings.enabled) return { status: 'skipped', reason: 'disabled' };
  const scan = getScan() || {};
  const t0 = now();
  const [ev, procs, ai] = await Promise.all([
    gatherEvidence(scan.projects || [], settings),
    snapshot(),
    aiToolStatus().catch(() => ({ ok: false, running: [] })),
  ]);
  const sel = selectCandidates({
    projects: scan.projects || [], system: scan.system || [], settings, now: t0,
    evidence: ev.evidence, itemEvidence: ev.itemEvidence, procs, aiTools: ai,
  });

  // ---- dry run: report, touch nothing, wait for approval ----
  if (!isApproved(settings)) {
    const id = newId();
    const preview = sel.candidates.map((c) => ({ path: c.path, bytes: c.bytes, kind: c.kind, rule: c.rule, group: c.group, ...(c.project ? { project: c.project } : {}) }));
    const entry = historyLog.finishedEntry({
      id, at: t0, finishedAt: now(), status: 'done', scope: 'auto-clean', label: 'Auto-clean preview',
      requested: 0, items: [],
      extra: { autoClean: { dryRun: true, rules: rulesFingerprint(settings), previewCount: sel.count, previewBytes: sel.bytes, preview: preview.slice(0, 500), skippedCount: sel.skipped.filter((x) => !x.quiet).length } },
    });
    putHistory(entry);
    saveSettings({ ...settings, pendingPreview: id });
    notify('Auto-clean preview', sel.count
      ? `It would move ${fmtBytes(sel.bytes)} from ${sel.count} ${sel.count === 1 ? 'item' : 'items'}. Nothing was removed. Approve it in History.`
      : 'Nothing matches your auto-clean rules right now. Nothing was removed. Approve the rules in History.');
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
  let stopped = null;
  let stagedBytes = 0;
  let stagedCount = 0;
  const stagedPaths = [];
  for (const c of sel.candidates) {
    const job = allowedBy.get(c.path);
    if (!job) continue;
    if (stopped) { items.push({ ...describe(c), outcome: 'failed', bytes: 0, reason: 'Not moved: ' + stopped }); continue; }
    const why = stillOk();
    if (why) { stopped = why; items.push({ ...describe(c), outcome: 'failed', bytes: 0, reason: 'Not moved: ' + why }); continue; }
    let ok = true;
    let reason = null;
    let code = null;
    if (job.mode === 'contents') {
      const keep = new Set([...(job.protect || [])].map((x) => String(x).toLowerCase()));
      const excl = new Set(job.excludePaths || []);
      let names = [];
      try { names = await listChildren(c.path); } catch (e) { ok = false; reason = 'Spaci could not read it.'; code = e.code; }
      // The target's size rides on its first moved child, so undo and purge count it once.
      let carried = false;
      for (const n of names) {
        const child = nodePath.join(c.path, n);
        if (keep.has(n.toLowerCase()) || excl.has(child) || n === '.DS_Store') continue;
        const r = staging.stage(m, child, { ...c, bytes: carried ? 0 : c.bytes });
        if (r.ok) carried = true;
        else if (r.code !== 'ENOENT') { ok = false; reason = r.reason; code = r.code; break; }
      }
    } else {
      const r = staging.stage(m, c.path, c);
      if (!r.ok) { ok = false; reason = r.reason; code = r.code; }
    }
    if (ok) {
      stagedBytes += c.bytes;
      stagedCount++;
      stagedPaths.push(c.path);
      // 'trashed': still on disk until the staging folder is purged, so it is
      // not counted as freed yet (history-log tallies it apart).
      items.push({ ...describe(c), outcome: 'trashed', bytes: c.bytes });
    } else {
      items.push({ ...describe(c), outcome: 'failed', bytes: 0, reason: reason || 'Could not be moved.', code: code || undefined });
      stopped = 'an earlier item failed, so the run stopped.';
    }
  }
  putHistory(historyLog.finishedEntry({ ...started, finishedAt: now(), status: 'done', items, extra: { autoClean: { ...acMeta, stagedBytes, stagedCount } } }));
  onStaged(stagedPaths);
  if (stagedCount) {
    notify('Auto-clean', `Moved ${fmtBytes(stagedBytes)} from ${stagedCount} ${stagedCount === 1 ? 'item' : 'items'} aside. The space is freed in 24 hours. Undo it from History until then.`);
  } else if (stopped) {
    notify('Auto-clean', 'Auto-clean stopped before moving anything: ' + stopped);
  }
  return { status: stopped ? 'partial' : 'ok', runId, count: stagedCount, bytes: stagedBytes, stopped };
}

module.exports = {
  DEFAULT_SETTINGS, STAGING_TTL_MS, KEEP_MARKER, AUTO_ARTIFACTS, TOOL_FAMILIES, TARGET_FAMILY, DEV_PROCESS_NAMES,
  sanitizeSettings, rulesFingerprint, isApproved, autoCleanGate, selectCandidates,
  projectEvidence, itemEvidence, snapshotProcesses, parsePs, parseLsofCwd, namesOf,
  createStaging, writeJsonDurable, runAutoClean, fmtBytes, isInsideOrSame,
};
