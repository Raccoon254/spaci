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
function duSize(p, deadline) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', p], { timeout: 20000 }, (err, stdout) => {
      if (err) {
        walkSize(p, deadline).then(resolve, () => resolve(0));
        return;
      }
      const kb = parseInt(stdout, 10);
      if (Number.isNaN(kb)) {
        walkSize(p, deadline).then(resolve, () => resolve(0));
        return;
      }
      resolve(kb * 1024);
    });
  });
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
 * Build the finer category definitions with platform-appropriate paths.
 * Each category lists candidate directories; missing ones contribute 0.
 */
function buildCategories(home) {
  const platform = process.platform;

  // Developer project roots: include whichever common roots exist.
  const projectRoots = ['projects', 'dev', 'code', 'Developer']
    .map((name) => path.join(home, name))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });

  const developerDirs = [
    ...projectRoots,
    path.join(home, '.npm'),
    path.join(home, '.gradle'),
    path.join(home, '.m2'),
    path.join(home, '.cargo'),
    path.join(home, '.rustup'),
    path.join(home, '.cocoapods'),
    path.join(home, '.pub-cache'),
    path.join(home, 'go'),
    path.join(home, '.nvm'),
    path.join(home, '.bun'),
  ];
  if (platform === 'darwin') {
    developerDirs.push(path.join(home, 'Library', 'Developer'));
  }

  // Applications: system-wide on darwin plus the per-user folder.
  const appsDirs = [];
  if (platform === 'darwin') appsDirs.push('/Applications');
  appsDirs.push(path.join(home, 'Applications'));

  // Media video folder differs by platform.
  const videoDir =
    platform === 'darwin'
      ? path.join(home, 'Movies')
      : path.join(home, 'Videos');

  const lib = (...parts) => path.join(home, 'Library', ...parts);

  const defs = [
    {
      key: 'developer',
      label: 'Developer',
      icon: 'code',
      hint: 'Code, build caches and SDKs',
      dirs: developerDirs,
    },
    {
      key: 'applications',
      label: 'Applications',
      icon: 'grid',
      hint: 'Installed apps',
      dirs: appsDirs,
    },
    {
      key: 'appdata',
      label: 'App Data',
      icon: 'database',
      hint: 'Per-app data and containers',
      dirs:
        platform === 'darwin'
          ? [
              lib('Application Support'),
              lib('Containers'),
              lib('Group Containers'),
            ]
          : [],
    },
    {
      key: 'caches',
      label: 'Caches',
      icon: 'broom',
      hint: 'Regenerable cache and log files',
      dirs:
        platform === 'darwin'
          ? [lib('Caches'), lib('Logs')]
          : platform === 'linux'
            ? [path.join(home, '.cache')]
            : process.env.LOCALAPPDATA
              ? [path.join(process.env.LOCALAPPDATA, 'Temp')]
              : [],
    },
    {
      key: 'media',
      label: 'Media',
      icon: 'image',
      hint: 'Photos, video and music',
      dirs: [
        path.join(home, 'Pictures'),
        videoDir,
        path.join(home, 'Music'),
      ],
    },
    {
      key: 'documents',
      label: 'Documents',
      icon: 'document-text',
      hint: 'Files on your Desktop and in Documents',
      dirs: [path.join(home, 'Documents'), path.join(home, 'Desktop')],
    },
    {
      key: 'downloads',
      label: 'Downloads',
      icon: 'download',
      hint: 'Your Downloads folder',
      dirs: [path.join(home, 'Downloads')],
    },
    {
      key: 'mail',
      label: 'Mail & Messages',
      icon: 'bell',
      hint: 'Mail and Messages storage',
      dirs:
        platform === 'darwin' ? [lib('Mail'), lib('Messages')] : [],
    },
  ];

  // Drop categories that have no candidate directories at all.
  return defs.filter((d) => d.dirs.length > 0);
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
  const defs = buildCategories(home);

  const allDirs = [];
  for (const def of defs) {
    for (const dir of def.dirs) allDirs.push(dir);
  }

  const sizes = await Promise.all(
    allDirs.map((dir) => sizeOf(dir, deadline))
  );

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
    measuredTotal += bytes;
    measured.push({
      key: def.key,
      label: def.label,
      icon: def.icon,
      hint: def.hint,
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
      bytes: Math.round(c.bytes),
    }));
    const remainder = Math.round(used - measuredTotal);
    if (remainder > 0) {
      categories.push({
        key: 'system',
        label: 'System',
        icon: 'cpu',
        hint: 'macOS and other system files',
        bytes: remainder,
      });
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

  return { total, used, free, categories: result };
}

module.exports = { diskBreakdown };
