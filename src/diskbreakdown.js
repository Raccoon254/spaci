'use strict';

// Disk usage breakdown for the Storage screen (runs in the scan worker).
//
// THE MODEL (os-storage-spec.md, section 1):
//   1. Ground truth: `used` from statfs of the boot volume (APFS: the whole
//      container, so the sealed system, Preboot, VM and snapshots are in it).
//   2. Story categories (Developer, Applications, App Data, ...) measured with
//      `du -xk -d 1` per folder: one filesystem, allocated blocks, hard links
//      once per folder. A folder that runs out of time keeps the bytes it
//      reached (confidence 'partial'); one with unreadable subfolders is a
//      lower bound ('denied'). Nothing is silently zeroed.
//   3. System = used minus the categories, and it is explained, not stated:
//      OS volumes and files (tier D), system folders outside the home folder
//      measured by the per-OS collector (src/os-storage/), the home folders no
//      category claims, and a named remainder ("Protected by macOS",
//      "Snapshots and APFS metadata", "Restore points", "Root-only folders")
//      for what no account without admin rights can measure.
//   4. Never scale. du counts APFS clones in full, so measured can exceed used.
//      Then the overcount is reported (`reconcile`) and the clone-heavy items
//      carry confidence 'upper-bound' or their clone-aware size, instead of
//      every category being shrunk to fit.
//
// Partial results: `onProgress(snapshot)` receives the same shape as the final
// result while measuring (meta.partial true), with each folder's size from the
// previous run until its fresh number lands (size-cache.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { buildStoryCategories, buildSystemTargets, systemCategory, unclassifiedRoots, buildProjectRoots, tierForPath } = require('./storage-classifier');
const { parseApfsVolumes } = require('./os-storage/darwin');
const { collectOsLayer } = require('./os-storage');
const { duTree } = require('./os-storage/du');
const { walkTree } = require('./os-storage/walk');
const { cloneAwareSize } = require('./os-storage/clonesize');
const { createSizeCache } = require('./os-storage/size-cache');
const { run } = require('./os-storage/exec');
const docker = require('./docker');

// Overall deadline so the worst-case runtime stays bounded (~20s).
const DEADLINE_MS = 20000;

/**
 * Bounded, iterative directory walk using fs.promises.
 * Skips symlinks, swallows per-entry errors, and stops once the deadline
 * passes. The result is approximate by design.
 */
async function walkSize(root, deadline) {
  let total = 0;
  const stack = [root];

  while (stack.length > 0) {
    if (Date.now() > deadline) break;
    const dir = stack.pop();

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (Date.now() > deadline) break;
      const full = path.join(dir, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          const st = await fs.promises.lstat(full);
          total += st.size;
        }
      } catch {
        // ignore unreadable entries
      }
    }
  }

  return total;
}

/**
 * Run `du -sk` and parse the result, falling back to a bounded Node walk
 * on any failure (missing du, timeout, permission errors, etc.).
 */
function parseDuBytes(stdout) {
  const kb = parseInt(String(stdout || '').trim(), 10);
  return Number.isNaN(kb) ? 0 : kb * 1024;
}

// Folders whose `du` did not finish. A big developer folder (node_modules by
// the thousand) can take minutes; counting it as 0 silently moved tens of GB
// into the System remainder, so timeouts are recorded and reported instead.
const timedOut = new Set();
const DU_TIMEOUT_MS = 300000;

function duSize(p) {
  return new Promise((resolve) => {
    // `du -sk` reports real disk blocks used (APFS clones counted once). On
    // failure/timeout we resolve 0 rather than falling back to a node walk,
    // because that walk sums APPARENT sizes and APFS clones inflate it wildly
    // (e.g. ~/Library measured at 365 GB instead of 62 GB).
    // -x: stay on this filesystem. Without it du walks into mounted disk
    // images (an iOS simulator runtime under /Library/Developer counted 17 GB).
    execFile('du', ['-skx', p], { timeout: DU_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const bytes = parseDuBytes(stdout);
      if (bytes > 0 || !err) { resolve(bytes); return; }
      if (err && (err.killed || err.signal)) timedOut.add(p);
      resolve(0);
    });
  });
}

// Run an async mapper over items with a bounded concurrency, so we never start
// dozens of `du` processes at once (which starve each other and time out).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function pathApiFor(p) {
  return /^[a-zA-Z]:[\\/]/.test(String(p || '')) || String(p || '').includes('\\') ? path.win32 : path.posix;
}

function isInside(parent, child) {
  if (!parent || !child || parent === child) return false;
  const pathApi = pathApiFor(parent);
  const rel = pathApi.relative(parent, child);
  return rel && !rel.startsWith('..') && !pathApi.isAbsolute(rel);
}

/**
 * Size of a directory in bytes (0 if missing or a symlink). Uses `du` on
 * darwin/linux and a bounded fs.promises walk on win32 or du failure.
 */
async function sizeOf(p, deadline) {
  if (!p) return 0;

  let st;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return 0;
  }
  // Skip symlinks (avoid double-counting / escaping the tree).
  if (st.isSymbolicLink()) return 0;
  // Allocated blocks: a sparse disk image (Docker.raw) is far smaller on disk than its size.
  if (st.isFile()) return st.blocks ? st.blocks * 512 : st.size;
  if (!st.isDirectory()) return 0;

  const dl = deadline || Date.now() + DEADLINE_MS;

  if (process.platform === 'darwin' || process.platform === 'linux') {
    return duSize(p, dl);
  }

  // win32 and anything else: bounded Node walk.
  try {
    return await walkSize(p, dl);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// "What macOS calls System Data"
//
// macOS Storage settings lumps developer data, caches, app data, swap and
// snapshots into one "System Data" figure. This splits that figure into the
// parts Spaci can see, so a large number stops being a mystery. It is an
// estimate: Apple does not publish how it draws the line.
// ---------------------------------------------------------------------------

const SWAP_DIR = '/System/Volumes/VM';

/**
 * Pure attribution step. `cats` is { key: bytes } from the (possibly scaled)
 * breakdown; the raw measurements are scaled by the same `factor` so they stay
 * consistent with it. Each piece is capped by the category it lives inside, so
 * nothing is counted twice and the pieces never exceed their parent.
 *
 * Categories macOS counts as System Data: developer caches (developer and
 * xcode targets), AI tools, app data, caches, browser data and the unmeasured
 * system remainder. Applications, Documents, Downloads, Media, Mail and your
 * own project folders are not part of it.
 */
function attributeSystemData(input) {
  const {
    cats = {},
    factor = 1,
    dockerBytes = 0,
    devCacheBytes = 0,
    dotCacheBytes = 0,
    swapBytes = 0,
    snapshots = null,
  } = input || {};
  const c = (k) => Math.max(0, Number(cats[k]) || 0);
  const scale = (n) => Math.round(Math.max(0, Number(n) || 0) * factor);

  const docker_ = Math.min(scale(dockerBytes), c('appdata'));
  const ai = c('aitools');
  const dev = Math.min(scale(devCacheBytes), c('developer') + c('xcode'));
  const dotCache = Math.min(scale(dotCacheBytes), c('caches'));
  const swap = Math.min(scale(swapBytes), c('system'));
  const otherApp = (c('appdata') - docker_) + (c('caches') - dotCache) + c('browsers');
  const os_ = c('system') - swap;

  const pieces = [
    { key: 'docker', label: 'Docker disk image', bytes: docker_, hint: 'What the image really occupies on disk' },
    { key: 'aitools', label: 'AI tools', bytes: ai, hint: 'Session history, logs and caches from AI coding tools' },
    { key: 'devcaches', label: 'Developer caches', bytes: dev, hint: 'Package caches, build caches and Xcode data' },
    { key: 'dotcache', label: '~/.cache', bytes: dotCache, hint: 'Caches kept by command-line tools' },
    { key: 'swap', label: 'Swap', bytes: swap, hint: 'Memory macOS has paged out to disk' },
    { key: 'appdata', label: 'App data and other caches', bytes: otherApp, hint: 'Application Support, Library caches and browser data' },
    { key: 'os', label: 'macOS and other system files', bytes: os_, hint: 'What is left once everything above is accounted for' },
  ].filter((p) => p.bytes > 0);

  return {
    platform: 'darwin',
    estimate: pieces.reduce((a, p) => a + p.bytes, 0),
    pieces,
    // APFS does not report how large a snapshot is, so only the count is known.
    snapshots: snapshots && snapshots.count > 0 ? { count: snapshots.count } : null,
  };
}

function plist(args) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', `diskutil ${args} | plutil -convert json -o - -`], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}
async function osVolumes() {
  const [info, list] = await Promise.all([plist('info -plist /'), plist('apfs list -plist')]);
  if (!info || !list || !info.APFSContainerReference) return [];
  return parseApfsVolumes(list, info.APFSContainerReference);
}

function localSnapshots() {
  return new Promise((resolve) => {
    execFile('tmutil', ['listlocalsnapshots', '/'], { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const count = String(stdout || '').split('\n').filter((l) => /^com\.apple\./.test(l.trim())).length;
      resolve({ count });
    });
  });
}

async function measureSystemData({ home, categories, sizeByDir, factor, deadline }) {
  const measure = async (p) => (sizeByDir.has(p) ? sizeByDir.get(p) : sizeOf(p, deadline));

  const devPaths = [];
  for (const t of buildSystemTargets({ home })) {
    const story = t.storyCategory || String(t.category || '').toLowerCase();
    if (story === 'developer' || story === 'xcode') devPaths.push(...t.paths);
  }
  // A path inside another listed path is already counted by its parent.
  const uniq = Array.from(new Set(devPaths.filter(Boolean)));
  const topLevel = uniq.filter((p) => !uniq.some((q) => isInside(q, p)));

  const dotCacheDir = path.join(home, '.cache');
  const [devSizes, dotCacheRaw, swapBytes, snapshots, disk] = await Promise.all([
    mapLimit(topLevel, 4, measure),
    measure(dotCacheDir),
    sizeOf(SWAP_DIR, deadline),
    localSnapshots(),
    docker.desktopDisk('darwin', home).catch(() => null),
  ]);

  const devCacheBytes = devSizes.reduce((a, b) => a + b, 0);
  // Developer caches that live under ~/.cache are counted as developer caches.
  const insideDot = topLevel.filter((p) => isInside(dotCacheDir, p));
  const dotCacheBytes = Math.max(0, dotCacheRaw - insideDot.reduce((a, p) => a + (topLevel.indexOf(p) >= 0 ? devSizes[topLevel.indexOf(p)] : 0), 0));

  const cats = {};
  for (const cat of categories) cats[cat.key] = cat.bytes;
  return attributeSystemData({
    cats,
    factor,
    dockerBytes: disk ? disk.allocatedBytes || disk.bytes || 0 : 0,
    devCacheBytes,
    dotCacheBytes,
    swapBytes,
    snapshots,
  });
}

/**
 * Compute a disk usage breakdown for the given home directory.
 * Returns { total, used, free, categories } where categories is a sorted
 * (descending by bytes) array of { key, label, bytes, icon, hint } for the
 * non-zero groups. See the SCALING RULE comment at the top of this file: the
 * categories are guaranteed to sum to <= used and each is <= used.
 */

// ---------------------------------------------------------------------------
// The breakdown
// ---------------------------------------------------------------------------

// Order of confidences from best to worst, for a category built from folders.
const CONF_RANK = { exact: 0, cached: 1, estimate: 1, stale: 2, 'upper-bound': 2, denied: 3, partial: 4 };
const worst = (list) => list.reduce((w, c) => ((CONF_RANK[c] || 0) > (CONF_RANK[w] || 0) ? c : w), 'exact');

// Folder measurement budgets. A developer folder with thousands of
// node_modules can take minutes; its partial size is kept when time runs out.
const CATEGORY_TIMEOUT_MS = 420000; // the worker gives the whole breakdown 10 minutes
const UNCLASSIFIED_TIMEOUT_MS = 120000;
const MAX_UNCLASSIFIED = 30;

function semaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/**
 * Measure one folder: du on macOS/Linux, a bounded walk on Windows. Returns
 * null when the path does not exist or is a symlink.
 */
function makeMeasure({ platform, limit, signal, sizeCache, fsp = fs.promises }) {
  const measureOne = async (p, opts = {}) => {
    if (!p) return null;
    let st;
    try { st = await fsp.lstat(p); } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return { path: p, bytes: 0, confidence: 'denied', children: [], denied: 1, deniedPaths: [p] };
      return null;
    }
    if (st.isSymbolicLink()) return null;
    if (st.isFile()) return { path: p, bytes: st.blocks ? st.blocks * 512 : st.size, confidence: 'exact', children: [], denied: 0, deniedPaths: [] };
    if (!st.isDirectory()) return null;
    if (opts.split) {
      // Big roots (project folders) are measured child by child, so several du
      // run in parallel and a timeout loses one child, not the whole root.
      let ents = null;
      try { ents = await fsp.readdir(p, { withFileTypes: true }); } catch (_) { ents = null; }
      if (ents) {
        const parts = await Promise.all(ents.filter((e) => !e.isSymbolicLink()).map((e) => measureOne(path.join(p, e.name), { timeoutMs: opts.timeoutMs })));
        const got = parts.filter(Boolean);
        const r = {
          path: p,
          bytes: got.reduce((a, x) => a + x.bytes, 0),
          confidence: worst(got.map((x) => x.confidence)),
          children: got.map((x) => ({ path: x.path, bytes: x.bytes })).sort((a, b) => b.bytes - a.bytes),
          denied: got.reduce((a, x) => a + (x.denied || 0), 0),
          deniedPaths: got.flatMap((x) => x.deniedPaths || []).slice(0, 50),
        };
        if (sizeCache) sizeCache.set(p, r.bytes, r.confidence);
        return r;
      }
    }
    const r = await limit(() => (platform === 'win32'
      ? walkTree(p, { timeoutMs: opts.timeoutMs || CATEGORY_TIMEOUT_MS, signal })
      : duTree(p, { timeoutMs: opts.timeoutMs || CATEGORY_TIMEOUT_MS, exclude: opts.exclude, platform, signal })));
    if (r && sizeCache) sizeCache.set(p + (opts.exclude && opts.exclude.length ? '|-' + opts.exclude.join(',') : ''), r.bytes, r.confidence);
    return r;
  };
  return measureOne;
}

/**
 * Home-folder entries no category counts. An entry that holds a category
 * folder (~/Library holds Application Support) is opened one level further, so
 * its unclaimed siblings are still measured.
 */
async function unclassifiedFolders(roots, exclude, measure, { fsp = fs.promises, depth = 2 } = {}) {
  const ex = exclude.filter(Boolean);
  const exSet = new Set(ex);
  const holds = (p) => ex.some((e) => isInside(p, e));
  const found = [];
  const seenRoots = new Set();
  async function visit(dir, level) {
    if (seenRoots.has(dir)) return;
    seenRoots.add(dir);
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const jobs = [];
    for (const d of names) {
      if (d.name === '.DS_Store') continue;
      const p = path.join(dir, d.name);
      if (exSet.has(p) || ex.some((e) => isInside(e, p))) continue;
      if (roots.includes(p)) continue; // listed as its own root
      if (holds(p)) { if (level < depth && d.isDirectory() && !d.isSymbolicLink()) jobs.push(visit(p, level + 1)); continue; }
      if (d.isSymbolicLink()) continue;
      jobs.push(measure(p, { timeoutMs: UNCLASSIFIED_TIMEOUT_MS }).then((r) => {
        if (r && r.bytes > 0) found.push({ name: d.name, path: p, bytes: r.bytes, isDir: d.isDirectory(), confidence: r.confidence });
      }));
    }
    await Promise.all(jobs);
  }
  for (const r of roots) await visit(r, 1);
  return found.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Put the result together from what is known so far. Pure: used by the final
 * result and by every progress snapshot, and by the tests.
 */
function assemble({ total, used, free, reserved = 0, defs, sizes, osItems = [], unclassified = null, facts = {}, home, platform, partial = false, pending = 0 }) {
  const categories = [];
  for (const def of defs) {
    const confs = [];
    let bytes = 0;
    let waiting = false;
    for (const dir of def.dirs) {
      const s = sizes.get(dir);
      if (!s) continue;
      bytes += s.bytes;
      confs.push(s.confidence);
      if (s.pending) waiting = true;
    }
    for (const dir of def.subtractDirs || []) {
      if (!def.dirs.some((parent) => isInside(parent, dir))) continue;
      const s = sizes.get(dir);
      if (s) bytes -= s.bytes;
    }
    bytes = Math.max(0, Math.round(bytes));
    const confidence = worst(confs);
    categories.push({
      key: def.key,
      label: def.label,
      icon: def.icon,
      hint: def.hint,
      tier: def.tier,
      dirs: def.dirs,
      bytes,
      confidence,
      partial: confidence === 'partial' || undefined,
      pending: waiting || undefined,
    });
  }
  const measuredTotal = categories.reduce((a, c) => a + c.bytes, 0);

  // System: everything the categories do not hold, explained part by part.
  const additive = osItems.filter((it) => it.additive !== false && it.bytes > 0);
  const osLayer = additive.filter((it) => it.group === 'os');
  const areas = additive.filter((it) => it.group === 'area');
  const remainderParts = osItems.filter((it) => it.group === 'remainder');
  const info = osItems.filter((it) => it.group === 'info' || (it.additive === false && it.group !== 'remainder'));
  const osBytes = osLayer.reduce((a, it) => a + it.bytes, 0);
  const areaBytes = areas.reduce((a, it) => a + it.bytes, 0);
  const unclassifiedBytes = unclassified ? unclassified.reduce((a, f) => a + f.bytes, 0) : 0;
  const known = osBytes + areaBytes + unclassifiedBytes;
  const systemRaw = used - measuredTotal;
  const systemBytes = Math.max(0, Math.round(Math.max(systemRaw, known)));
  const remainder = Math.max(0, systemBytes - known);
  const overcount = Math.max(0, Math.round(measuredTotal + known - used));
  const upperBound = [...categories, ...additive].filter((x) => x.confidence === 'upper-bound' || x.duBytes > x.bytes).map((x) => x.label);

  const sys = systemCategory(systemBytes, { platform, home });
  sys.confidence = partial ? 'measuring' : 'exact';
  sys.os = osLayer;
  sys.areas = areas.sort((a, b) => b.bytes - a.bytes);
  sys.unclassified = unclassified ? unclassified.slice(0, MAX_UNCLASSIFIED) : null;
  sys.unclassifiedBytes = unclassifiedBytes;
  sys.unclassifiedCount = unclassified ? unclassified.length : 0;
  sys.remainder = { bytes: Math.round(remainder), parts: remainderParts };
  sys.info = info;
  // Kept for older renderers: the APFS volumes as { role, name, bytes }.
  sys.volumes = osLayer.filter((it) => /^vol-/.test(it.key)).map((it) => ({ role: it.key.slice(4), name: it.label, bytes: it.bytes }));

  const unmeasured = categories.filter((c) => c.partial).flatMap((c) => c.dirs.filter((d) => (sizes.get(d) || {}).confidence === 'partial'));
  if (unmeasured.length) sys.unmeasured = unmeasured;

  const all = categories.concat(systemBytes > 0 ? [sys] : []).filter((c) => c.bytes > 0 || c.key === 'system').sort((a, b) => b.bytes - a.bytes);
  const unexplained = Math.round(remainder);
  return {
    total,
    used,
    free,
    reserved,
    categories: used > 0 ? all.filter((c) => c.bytes > 0) : [],
    explained: Math.max(0, used - unexplained),
    unexplained,
    reconcile: overcount > 0 ? { overcount, upperBound } : null,
    facts,
    meta: { source: 'disk-breakdown', version: 2, scannedAt: Date.now(), partial, pending },
  };
}

let inflight = null;

/**
 * Compute a disk usage breakdown for the given home directory. Concurrent
 * callers share one measurement (the worker gets asked by the Storage screen
 * and by the background refresh), and each gets the progress snapshots.
 */
function diskBreakdown(home = os.homedir(), options = {}) {
  const listener = typeof options.onProgress === 'function' ? options.onProgress : null;
  if (inflight && inflight.home === home) {
    if (listener) inflight.listeners.add(listener);
    return inflight.promise;
  }
  const listeners = new Set(listener ? [listener] : []);
  const run = runBreakdown(home, { ...options, onProgress: (snap) => { for (const l of listeners) { try { l(snap); } catch (_) {} } } });
  inflight = { home, listeners, promise: run.finally(() => { inflight = null; }) };
  return inflight.promise;
}

async function runBreakdown(home, options = {}) {
  const platform = options.platform || process.platform;
  const signal = options.signal;
  const onProgress = options.onProgress;
  const fsp = options.fsp || fs.promises;
  const started = Date.now();

  // 1. Disk totals from statfs (the physical ground truth).
  let total = 0; let free = 0; let used = 0; let reserved = 0; let st = null;
  try {
    st = await fsp.statfs(home);
    total = st.blocks * st.bsize;
    free = st.bavail * st.bsize;
    used = total - st.bfree * st.bsize;
    reserved = Math.max(0, (st.bfree - st.bavail) * st.bsize);
  } catch { total = 0; free = 0; used = 0; }

  const sizeCache = options.sizeCache || createSizeCache();
  sizeCache.checkVolume(total ? platform + ':' + total : null);
  const limit = semaphore(options.concurrency || 6);
  const measure = makeMeasure({ platform, limit, signal, sizeCache, fsp });

  const defs = buildStoryCategories({ home, platform });
  const allDirs = Array.from(new Set(defs.flatMap((d) => [...d.dirs, ...(d.subtractDirs || [])]).filter(Boolean)));

  // Seed every folder with its size from the last run, marked pending.
  const sizes = new Map();
  for (const dir of allDirs) {
    const c = sizeCache.get(dir);
    if (c) sizes.set(dir, { bytes: c.bytes, confidence: 'cached', pending: true, at: c.at });
  }
  const osItems = [];
  let unclassified = null;
  let facts = { platform };
  let pending = allDirs.length;

  const snapshot = (partial) => assemble({ total, used, free, reserved: platform === 'linux' ? reserved : 0, defs, sizes, osItems, unclassified, facts, home, platform, partial, pending });
  let lastEmit = 0;
  let timer = null;
  const emit = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    const fire = () => { timer = null; lastEmit = Date.now(); try { onProgress(snapshot(true)); } catch (_) {} };
    if (force || now - lastEmit > 400) { if (timer) { clearTimeout(timer); timer = null; } fire(); } else if (!timer) timer = setTimeout(fire, 400 - (now - lastEmit));
  };
  emit(true);

  // 2. Categories, the OS layer and the unclaimed home folders run side by
  //    side, sharing the du limit. Biggest folders (by last run) start first;
  //    project roots and anything over 20 GB are split into one du per child.
  const projectRoots = new Set(buildProjectRoots(home));
  const lastSize = (d) => { const c = sizeCache.get(d); return c ? c.bytes : 0; };
  const order = allDirs.slice().sort((a, b) => (projectRoots.has(b) - projectRoots.has(a)) || (lastSize(b) - lastSize(a)));
  // The OS collector signals once its cheap calls (diskutil, sysctl, capacity
  // keys) are answered; the heavy walks wait for that, at most 20 s.
  let factsDone = null;
  const factsReady = new Promise((resolve) => { factsDone = resolve; setTimeout(resolve, 20000); });
  const categoryRun = Promise.all(order.map(async (dir) => {
    await factsReady;
    const prev = sizeCache.get(dir);
    const r = await measure(dir, { split: projectRoots.has(dir) || lastSize(dir) > 20 * 1024 ** 3 });
    pending--;
    if (!r) sizes.delete(dir);
    else if (r.confidence === 'partial' && prev && prev.confidence === 'exact' && prev.bytes > r.bytes) {
      // Timed out below the last complete measurement: show that one, labelled.
      sizes.set(dir, { bytes: prev.bytes, confidence: 'stale', partialBytes: r.bytes, at: prev.at });
      sizeCache.set(dir, prev.bytes, 'exact');
    } else sizes.set(dir, { bytes: r.bytes, confidence: r.confidence, denied: r.denied });
    emit();
  }));
  const osRun = collectOsLayer(platform, {
    home,
    run: options.run || run,
    measure,
    cloneSize: platform === 'darwin' ? (o) => cloneAwareSize(o) : null,
    fs: fsp,
    statfs: (p) => fsp.statfs(p),
    env: process.env,
    categoryDirs: allDirs,
    onItem: (it) => { osItems.push(it); emit(); },
    onFacts: () => factsDone(),
  }).then((res) => {
    factsDone();
    // onItem already collected the items; keep the collector's list as the truth.
    osItems.length = 0;
    osItems.push(...res.items);
    facts = { ...facts, ...res.facts };
    emit();
  });
  // Home folders no category claims. Every category folder is known up front.
  const unclassifiedRun = factsReady.then(() => unclassifiedFolders(unclassifiedRoots({ platform, home }), allDirs, measure, { fsp }))
    .then((list) => { unclassified = list; emit(); });
  await Promise.all([categoryRun, osRun, unclassifiedRun]);

  // 4. macOS: the "System Data" explainer, from sizes already measured.
  const result = snapshot(false);
  if (platform === 'darwin' && used > 0) {
    try {
      const sizeByDir = new Map(Array.from(sizes, ([k, v]) => [k, v.bytes]));
      result.systemData = await measureSystemData({ home, categories: result.categories, sizeByDir, factor: 1, deadline: Date.now() + 8000 });
    } catch { result.systemData = null; }
  } else {
    result.systemData = null;
  }
  result.meta.durationMs = Date.now() - started;
  sizeCache.save();
  if (timer) clearTimeout(timer);
  return result;
}

// Enumerate the biggest immediate children across a set of directories (used by
// the Storage category drill-down). Lists each dir's direct entries, measures
// them with `du` (bounded concurrency, real disk blocks), and returns the
// largest, sorted descending, each with its cleaning tier. Never throws:
// unreadable dirs are skipped.
async function topChildren(dirs, limit = 25, deadlineMs = 45000, exclude = []) {
  const list = Array.isArray(dirs) ? dirs : [];
  // `exclude`: paths another category already counts. An entry that is one of
  // them, or contains one (~/Library holds Application Support), is skipped;
  // its unclassified children still show when its folder is also listed.
  const ex = (Array.isArray(exclude) ? exclude : []).filter(Boolean);
  const covered = (p) => ex.some((e) => e === p || isInside(p, e) || isInside(e, p));
  const deadline = Date.now() + deadlineMs;
  const entries = [];
  for (const dir of list) {
    let names;
    try { names = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      if (d.name === '.DS_Store') continue;
      if (ex.length && covered(path.join(dir, d.name))) continue;
      entries.push({ path: path.join(dir, d.name), name: d.name, isDir: d.isDirectory() });
    }
  }
  const sizes = await mapLimit(entries, 5, (e) => sizeOf(e.path, deadline));
  return entries
    .map((e, i) => ({ path: e.path, name: e.name, isDir: e.isDir, bytes: sizes[i] || 0, partial: timedOut.has(e.path) || undefined }))
    .filter((e) => e.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit)
    .map((e) => { let tier = 'C'; try { tier = tierForPath(e.path); } catch (_) { /* keep C */ } return { ...e, tier }; });
}


module.exports = {
  diskBreakdown,
  topChildren,
  parseDuBytes,
  attributeSystemData,
  parseApfsVolumes,
  osVolumes,
  assemble,
  unclassifiedFolders,
  makeMeasure,
};
