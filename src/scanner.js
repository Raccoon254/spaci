'use strict';
/**
 * Spaci: project scanner.
 * Ports & extends the original JavaFX DirectoryScanner:
 *  - detects project roots by marker files
 *  - finds cleanable build-artifact directories inside each project
 *  - computes sizes, last-modified, git status
 *  - streams progress and is cancellable
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const docker = require('./docker');

// Scanning is IO bound, not CPU bound: the win comes from keeping many reads in
// flight rather than from cores. These caps keep a scan responsive without
// drowning the filesystem (or spawning hundreds of `du` processes).
const CPUS = Math.max(2, os.cpus().length || 4);
const WALK_WORKERS = Math.min(24, Math.max(8, CPUS * 2));
const SIZE_WORKERS = Math.min(8, Math.max(4, CPUS));

/** Project types, detected by the presence of any marker in a directory. */
const PROJECT_TYPES = [
  { id: 'flutter', name: 'Flutter',   icon: 'flutter',    markers: ['pubspec.yaml'], priority: 95 },
  { id: 'android', name: 'Android',   icon: 'android',    markers: ['settings.gradle', 'gradlew'], priority: 90 },
  { id: 'xcode',   name: 'Xcode',     icon: 'apple',      markers: ['Podfile', '*.xcodeproj', '*.xcworkspace'], priority: 86 },
  { id: 'node',    name: 'Node.js',   icon: 'node',       markers: ['package.json'], priority: 70 },
  { id: 'rust',    name: 'Rust',      icon: 'rust',       markers: ['Cargo.toml'], priority: 80 },
  { id: 'go',      name: 'Go',        icon: 'go',         markers: ['go.mod'], priority: 80 },
  { id: 'gradle',  name: 'Gradle',    icon: 'gradle',     markers: ['build.gradle', 'build.gradle.kts'], priority: 78 },
  { id: 'maven',   name: 'Maven',     icon: 'java',       markers: ['pom.xml'], priority: 78 },
  { id: 'python',  name: 'Python',    icon: 'python',     markers: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'], priority: 74 },
  { id: 'php',     name: 'Composer',  icon: 'php',        markers: ['composer.json'], priority: 72 },
  { id: 'dotnet',  name: '.NET',      icon: 'box',        markers: ['*.csproj', '*.sln'], priority: 78 },
];

/**
 * Docker is deliberately NOT a project type. A compose file usually sits at the
 * top of a repo whose real projects live one level down (api/, web/), and a
 * project marker stops the walk. Treating compose as a marker cost 49 projects
 * and 3 GB of findable artifacts on a real home folder. Docker-only folders are
 * still recorded, they just do not halt the descent. See scanProjects.
 */
const DOCKER_TYPE = { id: 'docker', name: 'Docker', icon: 'box', markers: [], priority: 40 };

/**
 * Cleanable artifacts. `match` is a directory/file name; `safe` indicates it is a
 * pure build-artifact (always regenerable). `note` explains what it is.
 */
const CLEAN_RULES = [
  { match: 'node_modules',   kind: 'node',    safe: true,  note: 'Installed npm packages, restore with `npm install`.' },
  { match: 'target',         kind: 'java',    safe: true,  note: 'Maven/Rust build output.' },
  { match: 'build',          kind: 'gradle',  safe: true,  note: 'Build output (Gradle/Android/etc.).' },
  { match: 'dist',           kind: 'box',     safe: true,  note: 'Bundled distribution output.' },
  { match: 'out',            kind: 'box',     safe: true,  note: 'Compiler/bundler output.' },
  // .NET and C/C++ intermediates. Worth naming explicitly: an obj/ tree buries
  // hundreds of tiny build/ folders that are far more useful counted as one.
  { match: 'obj',            kind: 'box',     safe: true,  note: '.NET/C build intermediates.' },
  { match: '.next',          kind: 'react',   safe: true,  note: 'Next.js build cache.' },
  { match: '.nuxt',          kind: 'react',   safe: true,  note: 'Nuxt build cache.' },
  { match: '.turbo',         kind: 'flash',   safe: true,  note: 'Turborepo cache.' },
  { match: '.parcel-cache',  kind: 'flash',   safe: true,  note: 'Parcel bundler cache.' },
  { match: '.svelte-kit',    kind: 'svelte',  safe: true,  note: 'SvelteKit build output.' },
  { match: '.angular',       kind: 'react',   safe: true,  note: 'Angular build cache.' },
  { match: '.gradle',        kind: 'gradle',  safe: true,  note: 'Per-project Gradle cache.' },
  { match: '__pycache__',    kind: 'python',  safe: true,  note: 'Python bytecode cache.' },
  { match: '.pytest_cache',  kind: 'python',  safe: true,  note: 'Pytest cache.' },
  { match: '.mypy_cache',    kind: 'python',  safe: true,  note: 'Mypy type-check cache.' },
  { match: 'venv',           kind: 'python',  safe: false, note: 'Python virtualenv, recreate with your tooling.' },
  { match: '.venv',          kind: 'python',  safe: false, note: 'Python virtualenv, recreate with your tooling.' },
  { match: 'vendor',         kind: 'php',     safe: true,  note: 'Composer/Go vendored deps, restore with install.' },
  { match: 'Pods',           kind: 'apple',   safe: true,  note: 'CocoaPods deps, restore with `pod install`.' },
  { match: 'DerivedData',    kind: 'apple',   safe: true,  note: 'Xcode build cache.' },
  { match: 'coverage',       kind: 'file',    safe: true,  note: 'Test coverage reports.' },
  { match: '.terraform',     kind: 'box',     safe: true,  note: 'Terraform provider cache.' },
];
const CLEAN_NAMES = new Set(CLEAN_RULES.map((r) => r.match));
const CLEAN_BY_NAME = Object.fromEntries(CLEAN_RULES.map((r) => [r.match, r]));

/** Directories we never descend into while *detecting* projects. */
const EXCLUDED_DIRS = new Set([
  ...CLEAN_NAMES,
  '.git', '.svn', '.hg', '.idea', '.vscode', '.vs', '.cache',
  'Library', 'Applications', 'System', '.Trash',
]);

const SKIP_DELETE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

function matchingMarkers(entries, markers) {
  const hits = [];
  for (const m of markers) {
    if (m.startsWith('*')) {
      const ext = m.slice(1);
      if (entries.some((e) => e.endsWith(ext))) hits.push(m);
    } else if (entries.includes(m)) {
      hits.push(m);
    }
  }
  return hits;
}

function detectType(entries) {
  return detectTypes(entries)[0] || null;
}

function detectTypes(entries) {
  return PROJECT_TYPES
    .map((t) => {
      const markers = matchingMarkers(entries, t.markers);
      if (!markers.length) return null;
      // Specific project markers beat generic markers such as package.json.
      const score = (t.priority || 50) + markers.length * 10;
      return { ...t, score, matchedMarkers: markers };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Run `fn` over a growing work queue with a fixed number of workers. The
 * handler may return more items, which are appended, so this drives a tree walk
 * without recursion and with a hard cap on parallel IO.
 */
function drain(initial, workers, fn, signal) {
  const queue = initial.slice();
  let cursor = 0;
  let active = 0;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };

    const pump = () => {
      if (settled) return;
      if (signal?.aborted) { if (!active) finish(); return; }
      while (active < workers && cursor < queue.length) {
        const item = queue[cursor++];
        active++;
        Promise.resolve()
          .then(() => fn(item))
          .catch(() => null)
          .then((next) => {
            if (next && next.length) queue.push(...next);
            active--;
            pump();
          });
      }
      // Nothing queued and nothing in flight: the tree is fully walked.
      if (!active && cursor >= queue.length) finish();
    };

    pump();
  });
}

/** Map over items with bounded concurrency, preserving order. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/** Cap concurrent work globally, however many callers pile in. */
function makeGate(limit) {
  let active = 0;
  const waiting = [];
  return async function gated(fn) {
    if (active >= limit) await new Promise((r) => waiting.push(r));
    active++;
    try { return await fn(); }
    finally { active--; waiting.shift()?.(); }
  };
}

// Every du is a process. Project sizing runs from many walk workers at once, so
// the ceiling has to be global rather than per project.
const withDuSlot = makeGate(SIZE_WORKERS);

/**
 * `du -sk` in C beats tens of thousands of round-tripped fs.stat calls from JS,
 * and it is what the system scanner already uses, so project sizes and cache
 * sizes now mean the same thing (blocks actually occupied on disk). Returns
 * null when du is unavailable or produced nothing usable.
 */
function duSizeRaw(dir, signal) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', dir], { timeout: 120000, signal, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const first = String(stdout || '').trim().split('\n').find(Boolean) || '';
      const kb = parseInt((first.split(/\s+/)[0] || '').trim(), 10);
      // du exits non-zero when it hit an unreadable subdirectory but still
      // prints a usable total for everything it could read.
      if (Number.isFinite(kb)) return resolve(kb * 1024);
      resolve(err ? null : 0);
    });
  });
}

function duSize(dir, signal) {
  return withDuSlot(() => duSizeRaw(dir, signal));
}

/** Recursively sum file sizes of a directory, walking in parallel. */
async function walkSize(dir, signal) {
  let total = 0;
  await drain([dir], WALK_WORKERS, async (cur) => {
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { return null; }
    const subdirs = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { subdirs.push(path.join(cur, e.name)); continue; }
      try { total += (await fsp.stat(path.join(cur, e.name))).size; } catch { /* ignore */ }
    }
    return subdirs;
  }, signal);
  return total;
}

/** Size of a directory in bytes. */
async function dirSize(dir, signal) {
  if (signal?.aborted) return 0;
  if (process.platform !== 'win32') {
    const bytes = await duSize(dir, signal);
    if (bytes !== null) return bytes;
  }
  return walkSize(dir, signal);
}

function gitStatus(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain', '--branch'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.split('\n');
      const branchLine = lines[0] || '';
      const branch = (branchLine.match(/## ([^.\s]+)/) || [])[1] || 'detached';
      const dirty = lines.slice(1).filter((l) => l.trim()).length;
      const ahead = (branchLine.match(/ahead (\d+)/) || [])[1];
      resolve({ branch, dirty, ahead: ahead ? Number(ahead) : 0 });
    });
  });
}

/**
 * Scan a root directory for projects.
 * @param {string} root
 * @param {(p:object)=>void} onProgress
 * @param {AbortSignal} signal
 * @returns {Promise<{projects:object[], scanned:number}>}
 */
async function scanProjects(root, onProgress, signal) {
  const projects = [];
  let scanned = 0;
  let files = 0;
  let lastEmit = 0;

  const emit = (currentPath, force) => {
    const now = Date.now();
    if (force || now - lastEmit > 60) {
      lastEmit = now;
      // A filesystem walk has no true total, so percent is an asymptotic
      // estimate from folders seen: it climbs toward, but never reaches, 100%
      // until the walk completes (when we send 100 explicitly).
      const percent = Math.max(3, Math.min(95, Math.round(100 * (1 - 1 / (1 + scanned / 350)))));
      onProgress?.({
        phase: 'scanning', scanned, files, found: projects.length, currentPath, percent,
      });
    }
  };

  // Sibling directories are independent, so the walk runs as a bounded worker
  // pool over a queue instead of one-at-a-time recursion. On a home folder with
  // hundreds of projects this is the difference between minutes and seconds.
  await drain([{ dir: root, depth: 0 }], WALK_WORKERS, async ({ dir, depth }) => {
    if (signal?.aborted) return null;
    scanned++;
    emit(dir);
    let entries;
    try {
      entries = (await fsp.readdir(dir, { withFileTypes: true }));
    } catch { return null; }
    for (const e of entries) { if (e.isFile()) files++; }
    const names = entries.map((e) => e.name);

    const types = detectTypes(names);
    if (types.length) {
      const project = await buildProject(dir, types, signal, names);
      if (project) { projects.push(project); emit(dir, true); }
      return null; // do not descend further for project detection
    }

    // A folder whose only marker is Docker: record it (compose labels can tie
    // real engine storage to it) but keep walking into it.
    const dockerFiles = docker.detect(names);
    if (dockerFiles) {
      const shell = await dockerShellProject(dir, dockerFiles);
      if (shell) { projects.push(shell); emit(dir, true); }
    }

    // descend into non-excluded subdirectories
    if (depth > 12) return null;
    const children = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (EXCLUDED_DIRS.has(e.name)) continue;
      children.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
    return children;
  }, signal);
  onProgress?.({ phase: 'done', scanned, files, found: projects.length, percent: 100 });
  return { projects, scanned };
}

/**
 * A folder that only carries Docker markers. It gets no artifact walk (its
 * subdirectories are separate projects and own their own artifacts), just
 * enough of a record for Docker storage to be attributed to it. Callers drop
 * these when nothing attaches, see attachDockerUsage.
 */
async function dockerShellProject(dir, dockerFiles) {
  const [mtime, isGit, services] = await Promise.all([
    fsp.stat(dir).then((s) => s.mtimeMs, () => 0),
    fsp.stat(path.join(dir, '.git')).then(() => true, () => false),
    dockerFiles.composeFiles.length
      ? docker.composeServices(path.join(dir, dockerFiles.composeFiles[0]))
      : Promise.resolve([]),
  ]);
  return {
    name: path.basename(dir),
    path: dir,
    type: { ...DOCKER_TYPE },
    types: [{ id: DOCKER_TYPE.id, name: DOCKER_TYPE.name, icon: DOCKER_TYPE.icon, score: DOCKER_TYPE.priority, markers: [...dockerFiles.composeFiles, ...dockerFiles.dockerfiles] }],
    items: [],
    cleanableSize: 0,
    totalSize: 0,
    mtime,
    git: null,
    isGit,
    iconPath: null,
    dockerOnly: true,
    docker: { ...dockerFiles, services, usage: null },
  };
}

/**
 * Directories the artifact hunt never enters. `.git` is the expensive one: a
 * long-lived repo holds tens of thousands of loose objects and cannot contain a
 * build artifact, so descending into it was most of the old scan time.
 */
const ITEM_SKIP_DIRS = new Set(['.git', '.svn', '.hg', '.idea', '.vscode', '.vs', '.Trash']);
// Matches the project-detection depth. The old walk was unbounded, and the only
// things past this depth on a real machine were junk folders inside generated
// output that is itself already a cleanable target.
const ITEM_MAX_DEPTH = 12;

/** Build a project record: find cleanable items, sizes, mtime, git, Docker. */
async function buildProject(dir, detected, signal, rootEntries) {
  const types = Array.isArray(detected) ? detected : [detected];
  const type = types[0];

  // Find cleanable directories/files anywhere inside the project, walking
  // subtrees in parallel and sizing them afterwards so the walk is never
  // blocked behind a du.
  const found = [];
  await drain([{ cur: dir, depth: 0 }], WALK_WORKERS, async ({ cur, depth }) => {
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { return null; }
    const subdirs = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(cur, e.name);
      if (CLEAN_NAMES.has(e.name)) {
        found.push({ name: e.name, path: full, isDir: e.isDirectory() });
        continue; // do not descend into a cleanable dir
      }
      if (!e.isDirectory()) continue;
      if (ITEM_SKIP_DIRS.has(e.name)) continue;
      if (depth >= ITEM_MAX_DEPTH) continue;
      subdirs.push({ cur: full, depth: depth + 1 });
    }
    return subdirs;
  }, signal);

  const items = await mapPool(found, SIZE_WORKERS, async (f) => {
    const rule = CLEAN_BY_NAME[f.name];
    let size = 0;
    try { size = f.isDir ? await dirSize(f.path, signal) : (await fsp.stat(f.path)).size; }
    catch { /* unreadable, count it as zero */ }
    return {
      name: f.name, path: f.path, size, isDir: f.isDir,
      kind: rule.kind, safe: rule.safe, reversible: rule.reversible !== false, note: rule.note,
    };
  });
  items.sort((a, b) => b.size - a.size);
  const cleanableSize = items.reduce((s, i) => s + i.size, 0);

  // The scanner already read this listing, so Docker detection costs nothing.
  const names = rootEntries || await fsp.readdir(dir).catch(() => []);
  const dockerFiles = docker.detect(names);

  const [mtime, iconPath, isGit, services] = await Promise.all([
    fsp.stat(dir).then((s) => s.mtimeMs, () => 0),
    findProjectIcon(dir, type),
    // A worktree or submodule has .git as a file, not a directory.
    fsp.stat(path.join(dir, '.git')).then(() => true, () => false),
    dockerFiles && dockerFiles.composeFiles.length
      ? docker.composeServices(path.join(dir, dockerFiles.composeFiles[0]))
      : Promise.resolve([]),
  ]);

  const project = {
    name: path.basename(dir),
    path: dir,
    type: { id: type.id, name: type.name, icon: type.icon },
    types: types.map((t) => ({ id: t.id, name: t.name, icon: t.icon, score: t.score, markers: t.matchedMarkers || [] })),
    items,
    cleanableSize,
    totalSize: 0, // computed lazily on demand to keep scans fast
    mtime,
    git: null,
    isGit,
    iconPath,
    // Engine storage (images, volumes, cache) is attached later by
    // attachDockerUsage: it needs one daemon call for the whole scan, not one
    // per project.
    docker: dockerFiles ? { ...dockerFiles, services, usage: null } : null,
  };
  return project;
}

/**
 * Fold Docker's own storage into an already-scanned project list. Compose
 * labels every container with the directory it was started from, so a project
 * is matched by path rather than by guessing from its folder name.
 */
async function attachDockerUsage(projects, options = {}) {
  const inv = options.inventory || await docker.inventory(options);
  if (!inv || !inv.ok) return { attached: 0, inventory: inv };

  const byDir = docker.usageByProject(inv);
  if (!byDir.size) return { attached: 0, inventory: inv };

  let attached = 0;
  for (const p of projects) {
    const usage = byDir.get(p.path);
    if (!usage) continue;
    p.docker = p.docker || { dockerfiles: [], composeFiles: [], compose: false, services: [] };
    p.docker.usage = {
      project: usage.project,
      containers: usage.containers.length,
      running: usage.running,
      images: usage.images.length,
      volumes: usage.volumes.length,
      imageBytes: usage.imageBytes,
      volumeBytes: usage.volumeBytes,
      containerBytes: usage.containerBytes,
      totalBytes: usage.totalBytes,
    };
    attached++;
  }
  return { attached, inventory: inv };
}

/** Find a representative project icon: web favicon, Android launcher, or iOS AppIcon. */
async function findProjectIcon(dir, type) {
  const isFile = async (rel) => { try { const f = path.join(dir, rel); return (await fsp.stat(f)).isFile() ? f : null; } catch { return null; } };

  const web = [
    'public/favicon.svg', 'public/favicon.ico', 'public/favicon.png', 'public/apple-touch-icon.png',
    'public/logo192.png', 'public/logo.png', 'public/icon.png', 'public/icons/icon-192.png',
    'static/favicon.svg', 'static/favicon.ico', 'static/favicon.png', 'src/favicon.ico',
    'app/favicon.ico', 'src/assets/logo.png', 'assets/logo.png', 'assets/icon.png',
    'favicon.ico', 'favicon.png', 'favicon.svg', 'icon.png', 'logo.png',
    'web/favicon.png', 'web/icons/Icon-512.png', 'web/icons/Icon-192.png',
  ];
  const order = type.id === 'flutter' ? ['web/icons/Icon-512.png', 'web/favicon.png', ...web] : web;
  // Probe every candidate at once and keep the first hit in preference order:
  // ~25 sequential stat calls per project added up across hundreds of projects.
  const hits = await Promise.all(order.map(isFile));
  const web1 = hits.find(Boolean);
  if (web1) return web1;

  const android = await findAndroidIcon(dir);
  if (android) return android;
  return await findIosIcon(dir);
}
async function findAndroidIcon(dir) {
  const roots = ['app/src/main/res', 'android/app/src/main/res', 'src/main/res'];
  const densities = ['mipmap-xxxhdpi', 'mipmap-xxhdpi', 'mipmap-xhdpi', 'mipmap-hdpi', 'mipmap-mdpi', 'drawable-xxxhdpi'];
  const names = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
  const candidates = [];
  for (const r of roots) for (const d of densities) for (const n of names) candidates.push(path.join(dir, r, d, n));
  const hits = await Promise.all(candidates.map((f) => fsp.stat(f).then((s) => (s.isFile() ? f : null), () => null)));
  return hits.find(Boolean) || null;
}
async function findIosIcon(dir) {
  const sets = ['ios/Runner/Assets.xcassets/AppIcon.appiconset', path.basename(dir) + '/Assets.xcassets/AppIcon.appiconset', 'Runner/Assets.xcassets/AppIcon.appiconset'];
  for (const s of sets) {
    try {
      const setDir = path.join(dir, s);
      const pngs = (await fsp.readdir(setDir)).filter((f) => f.endsWith('.png'));
      let best = null, bestSize = 0;
      for (const f of pngs) { try { const st = await fsp.stat(path.join(setDir, f)); if (st.size > bestSize) { bestSize = st.size; best = path.join(setDir, f); } } catch { /* */ } }
      if (best) return best;
    } catch { /* */ }
  }
  return null;
}

/** Compute total size + git for a single project (called on selection / details). */
async function enrichProject(dir, signal) {
  const [total, git] = await Promise.all([dirSize(dir, signal), gitStatus(dir)]);
  return { totalSize: total, git };
}

module.exports = {
  PROJECT_TYPES, CLEAN_RULES, SKIP_DELETE,
  scanProjects, dirSize, enrichProject, gitStatus, detectType, detectTypes,
  attachDockerUsage, walkSize, drain, mapPool,
};
