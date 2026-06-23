'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

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
function duSize(p) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', p], { timeout: 20000 }, (err, stdout) => {
      if (err) {
        walkSize(p, Date.now() + DEADLINE_MS).then(resolve, () => resolve(0));
        return;
      }
      const kb = parseInt(stdout, 10);
      if (Number.isNaN(kb)) {
        walkSize(p, Date.now() + DEADLINE_MS).then(resolve, () => resolve(0));
        return;
      }
      resolve(kb * 1024);
    });
  });
}

/**
 * Size of a directory in bytes (0 if missing). Uses `du` on darwin/linux and
 * a bounded fs.promises walk on win32.
 */
async function sizeOf(p) {
  if (!p) return 0;
  if (!fs.existsSync(p)) return 0;

  if (process.platform === 'darwin' || process.platform === 'linux') {
    return duSize(p);
  }

  // win32 and anything else: bounded Node walk.
  try {
    return await walkSize(p, Date.now() + DEADLINE_MS);
  } catch {
    return 0;
  }
}

/**
 * Build the category definitions (platform-appropriate absolute paths).
 */
function buildCategories(home) {
  const platform = process.platform;

  const videos =
    platform === 'darwin'
      ? path.join(home, 'Movies')
      : path.join(home, 'Videos');

  const appsDirs = [];
  if (platform === 'darwin') appsDirs.push('/Applications');
  appsDirs.push(path.join(home, 'Applications'));

  let libraryDirs;
  if (platform === 'darwin') {
    libraryDirs = [path.join(home, 'Library')];
  } else if (platform === 'linux') {
    libraryDirs = [path.join(home, '.cache')];
  } else {
    libraryDirs = process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA] : [];
  }

  return [
    {
      key: 'coding',
      label: 'Coding',
      dirs: [
        path.join(home, 'projects'),
        path.join(home, '.gradle'),
        path.join(home, '.npm'),
        path.join(home, '.m2'),
        path.join(home, '.cargo'),
        path.join(home, '.cocoapods'),
        path.join(home, '.pub-cache'),
        path.join(home, '.rustup'),
        path.join(home, 'go'),
        path.join(home, '.nvm'),
        path.join(home, '.bun'),
        path.join(home, '.config'),
      ],
    },
    {
      key: 'documents',
      label: 'Documents',
      dirs: [path.join(home, 'Documents'), path.join(home, 'Desktop')],
    },
    {
      key: 'media',
      label: 'Media',
      dirs: [videos, path.join(home, 'Pictures'), path.join(home, 'Music')],
    },
    {
      key: 'downloads',
      label: 'Downloads',
      dirs: [path.join(home, 'Downloads')],
    },
    {
      key: 'apps',
      label: 'Applications',
      dirs: appsDirs,
    },
    {
      key: 'library',
      label: 'System & Library',
      dirs: libraryDirs,
    },
  ];
}

/**
 * Compute a disk usage breakdown for the given home directory.
 * Returns { total, used, free, categories } where categories is a sorted
 * (descending by bytes) array of { key, label, bytes } for non-zero groups,
 * including an "other" bucket when positive. No "free" entry is included.
 */
async function diskBreakdown(home = os.homedir()) {
  // 1. Disk totals.
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

  // 3. Measure every directory of every category concurrently.
  const defs = buildCategories(home);
  const allDirs = [];
  for (const def of defs) {
    for (const dir of def.dirs) allDirs.push(dir);
  }

  const sizes = await Promise.all(allDirs.map((dir) => sizeOf(dir)));

  // Map directory -> measured bytes, then sum per category.
  const sizeByDir = new Map();
  for (let i = 0; i < allDirs.length; i += 1) {
    sizeByDir.set(allDirs[i], sizes[i]);
  }

  const categories = [];
  let measured = 0;
  for (const def of defs) {
    let bytes = 0;
    for (const dir of def.dirs) bytes += sizeByDir.get(dir) || 0;
    measured += bytes;
    categories.push({ key: def.key, label: def.label, bytes });
  }

  // 4. "Other" bucket = whatever used space is not accounted for.
  const other = Math.max(0, used - measured);
  categories.push({ key: 'other', label: 'Other', bytes: other });

  // 5. Keep only non-zero categories, sorted descending by bytes.
  const result = categories
    .filter((c) => c.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  return { total, used, free, categories: result };
}

module.exports = { diskBreakdown };
