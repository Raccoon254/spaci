'use strict';

// Disk usage breakdown for the Electron main process.
//
// SCALING RULE (the core fix):
// On macOS APFS, `du` reports apparent sizes that include file clones and
// local snapshots, so summing `du -sk` across directories routinely OVERCOUNTS
// real usage. We have seen categories total MORE than the physical disk (e.g.
// "System & Library 505 GB" on a 460 GB disk). That is physically impossible
// and breaks the donut / bar charts.
//
// To fix it, after measuring every category we compute measuredTotal (the sum
// of all measured categories). The disk's real `used` (from statfs) is the
// ground truth:
//   - If measuredTotal > used, we scale every category by used / measuredTotal
//     so they sum to exactly `used` and there is no System remainder.
//   - If measuredTotal <= used, we keep the measured values and add a `system`
//     remainder = used - measuredTotal for everything we did not classify.
// Either way the categories sum to <= used and each category is <= used, so the
// numbers are always physically possible.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { buildStoryCategories, buildSystemTargets, systemCategory } = require('./storage-classifier');
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
  if (st.isFile()) return st.size;
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

// The boot disk's other APFS volumes (the sealed system, Preboot, Recovery,
// swap, pending updates). They share the container, so statfs counts them in
// `used`, but no folder under your home holds them.
const VOLUME_LABELS = {
  System: 'macOS system files', Preboot: 'Startup files (Preboot)', Recovery: 'Recovery',
  VM: 'Swap (virtual memory)', Update: 'Pending macOS updates',
};
function parseApfsVolumes(list, containerRef) {
  const out = [];
  for (const c of (list && list.Containers) || []) {
    if (c.ContainerReference !== containerRef) continue;
    for (const v of c.Volumes || []) {
      const role = (v.Roles || [])[0] || '';
      if (role === 'Data' || !VOLUME_LABELS[role]) continue;
      const bytes = Number(v.CapacityInUse) || 0;
      if (bytes > 0) out.push({ role, name: VOLUME_LABELS[role], bytes });
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
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
async function diskBreakdown(home = os.homedir()) {
  // 1. Disk totals from statfs (the physical ground truth).
  let total = 0;
  let free = 0;
  let used = 0;
  try {
    const s = await fs.promises.statfs(home);
    total = s.blocks * s.bsize;
    free = s.bavail * s.bsize;
    used = total - s.bfree * s.bsize;
  } catch {
    total = 0;
    free = 0;
    used = 0;
  }

  // 2. Measure every directory of every category concurrently, sharing one
  //    global deadline so the whole pass stays bounded (~20s).
  timedOut.clear();
  const deadline = Date.now() + DEADLINE_MS;
  const defs = buildStoryCategories({ home });

  const allDirs = [];
  for (const def of defs) {
    for (const dir of def.dirs) allDirs.push(dir);
    for (const dir of def.subtractDirs || []) allDirs.push(dir);
  }

  // Bounded concurrency: at most 4 `du` processes at once so none time out.
  const sizes = await mapLimit(allDirs, 4, (dir) => sizeOf(dir, deadline));

  // Map directory -> measured bytes, then sum per category.
  const sizeByDir = new Map();
  for (let i = 0; i < allDirs.length; i += 1) {
    sizeByDir.set(allDirs[i], sizes[i]);
  }

  let measured = [];
  let measuredTotal = 0;
  for (const def of defs) {
    const partial = def.dirs.some((d) => timedOut.has(d));
    let bytes = 0;
    for (const dir of def.dirs) bytes += sizeByDir.get(dir) || 0;
    // Parent buckets such as ~/Library/Caches subtract known child targets
    // so Browser/Developer caches can be shown without double-counting.
    for (const dir of def.subtractDirs || []) {
      if (def.dirs.some((parent) => isInside(parent, dir))) bytes -= sizeByDir.get(dir) || 0;
    }
    bytes = Math.max(0, bytes);
    measuredTotal += bytes;
    measured.push({
      key: def.key,
      label: def.label,
      icon: def.icon,
      hint: def.hint,
      dirs: def.dirs,
      subtractDirs: def.subtractDirs || [],
      bytes,
      partial,
    });
  }

  // 3. Apply the SCALING / CLAMPING rule against the real `used` bytes.
  let categories;
  if (used <= 0) {
    // No reliable total: present nothing rather than fabricate impossible bars.
    categories = [];
  } else if (measuredTotal > used) {
    // Overcount (APFS clones / snapshots). Scale every category down so the
    // categories sum to exactly `used`. No System remainder in this case.
    const factor = used / measuredTotal;
    categories = measured.map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.icon,
      hint: c.hint,
      dirs: c.dirs,
      bytes: Math.round(c.bytes * factor),
    }));
  } else {
    // Under the limit: keep measured values and add the unclassified remainder
    // as the System category.
    categories = measured.map((c) => ({
      key: c.key,
      label: c.label,
      icon: c.icon,
      hint: c.hint,
      dirs: c.dirs,
      bytes: Math.round(c.bytes),
      partial: c.partial || undefined,
    }));
    const remainder = Math.round(used - measuredTotal);
    if (remainder > 0) {
      const sys = systemCategory(remainder, { home });
      // Folders that could not be measured in time end up in the remainder;
      // say which, so the number is not mistaken for the OS.
      const unmeasured = allDirs.filter((d) => timedOut.has(d));
      if (unmeasured.length) sys.unmeasured = unmeasured;
      categories.push(sys);
    }
  }

  // 4. Final safety clamp: no single category may exceed `used`.
  for (const c of categories) {
    if (c.bytes > used) c.bytes = used;
  }

  // 5. Keep only non-zero categories, sorted descending by bytes.
  const result = categories
    .filter((c) => c.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  // macOS only: the system volumes that share the disk. Never fails the breakdown.
  let volumes = [];
  if (process.platform === 'darwin' && used > 0) {
    try { volumes = await osVolumes(); } catch { volumes = []; }
  }
  const sysCat = result.find((c) => c.key === 'system');
  if (sysCat && volumes.length) sysCat.volumes = volumes;

  // macOS only: the System Data explainer. Never allowed to fail the breakdown.
  let systemData = null;
  if (process.platform === 'darwin' && used > 0) {
    try {
      systemData = await measureSystemData({
        home,
        categories: result,
        sizeByDir,
        factor: measuredTotal > used ? used / measuredTotal : 1,
        deadline: Date.now() + 8000,
      });
    } catch { systemData = null; }
  }

  return {
    total,
    used,
    free,
    categories: result,
    systemData,
    meta: { source: 'disk-breakdown', scannedAt: Date.now(), partial: false },
  };
}

// Enumerate the biggest immediate children across a set of directories (used by
// the Storage category drill-down). Lists each dir's direct entries, measures
// them with `du` (bounded concurrency, real disk blocks), and returns the
// largest, sorted descending. Never throws: unreadable dirs are skipped.
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
    .map((e, i) => ({ path: e.path, name: e.name, isDir: e.isDir, bytes: sizes[i] || 0 }))
    .filter((e) => e.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

module.exports = { diskBreakdown, topChildren, parseDuBytes, attributeSystemData, parseApfsVolumes, osVolumes };
