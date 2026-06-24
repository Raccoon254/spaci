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
const { buildStoryCategories, systemCategory } = require('./storage-classifier');

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

function duSize(p) {
  return new Promise((resolve) => {
    // `du -sk` reports real disk blocks used (APFS clones counted once). On
    // failure/timeout we resolve 0 rather than falling back to a node walk,
    // because that walk sums APPARENT sizes and APFS clones inflate it wildly
    // (e.g. ~/Library measured at 365 GB instead of 62 GB).
    execFile('du', ['-sk', p], { timeout: 90000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const bytes = parseDuBytes(stdout);
      if (bytes > 0 || !err) { resolve(bytes); return; }
      resolve(err ? 0 : 0);
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
    }));
    const remainder = Math.round(used - measuredTotal);
    if (remainder > 0) {
      categories.push(systemCategory(remainder));
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

  return {
    total,
    used,
    free,
    categories: result,
    meta: { source: 'disk-breakdown', scannedAt: Date.now(), partial: false },
  };
}

// Enumerate the biggest immediate children across a set of directories (used by
// the Storage category drill-down). Lists each dir's direct entries, measures
// them with `du` (bounded concurrency, real disk blocks), and returns the
// largest, sorted descending. Never throws: unreadable dirs are skipped.
async function topChildren(dirs, limit = 25, deadlineMs = 45000) {
  const list = Array.isArray(dirs) ? dirs : [];
  const deadline = Date.now() + deadlineMs;
  const entries = [];
  for (const dir of list) {
    let names;
    try { names = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of names) {
      if (d.name === '.DS_Store') continue;
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

module.exports = { diskBreakdown, topChildren, parseDuBytes };
