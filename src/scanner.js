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
const path = require('path');
const { execFile } = require('child_process');

/** Project types, detected by the presence of any marker in a directory. */
const PROJECT_TYPES = [
  { id: 'node',    name: 'Node.js',   icon: 'node',       markers: ['package.json'] },
  { id: 'rust',    name: 'Rust',      icon: 'rust',       markers: ['Cargo.toml'] },
  { id: 'go',      name: 'Go',        icon: 'go',         markers: ['go.mod'] },
  { id: 'flutter', name: 'Flutter',   icon: 'flutter',    markers: ['pubspec.yaml'] },
  { id: 'android', name: 'Android',   icon: 'android',    markers: ['settings.gradle', 'gradlew'] },
  { id: 'gradle',  name: 'Gradle',    icon: 'gradle',     markers: ['build.gradle', 'build.gradle.kts'] },
  { id: 'maven',   name: 'Maven',     icon: 'java',       markers: ['pom.xml'] },
  { id: 'python',  name: 'Python',    icon: 'python',     markers: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'] },
  { id: 'php',     name: 'Composer',  icon: 'php',        markers: ['composer.json'] },
  { id: 'dotnet',  name: '.NET',      icon: 'box',        markers: ['*.csproj', '*.sln'] },
  { id: 'xcode',   name: 'Xcode',     icon: 'apple',      markers: ['Podfile', '*.xcodeproj', '*.xcworkspace'] },
];

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

function hasMarker(entries, markers) {
  for (const m of markers) {
    if (m.startsWith('*')) {
      const ext = m.slice(1);
      if (entries.some((e) => e.endsWith(ext))) return true;
    } else if (entries.includes(m)) {
      return true;
    }
  }
  return false;
}

function detectType(entries) {
  for (const t of PROJECT_TYPES) if (hasMarker(entries, t.markers)) return t;
  return null;
}

/** Recursively sum file sizes of a directory (apparent size). */
async function dirSize(dir, signal) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    if (signal?.aborted) break;
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); }
      else {
        try { total += (await fsp.stat(full)).size; } catch { /* ignore */ }
      }
    }
  }
  return total;
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
  let lastEmit = 0;

  const emit = (currentPath, force) => {
    const now = Date.now();
    if (force || now - lastEmit > 60) {
      lastEmit = now;
      onProgress?.({
        phase: 'scanning', scanned, found: projects.length, currentPath,
      });
    }
  };

  async function walk(dir, depth) {
    if (signal?.aborted) return;
    scanned++;
    emit(dir);
    let entries;
    try {
      entries = (await fsp.readdir(dir, { withFileTypes: true }));
    } catch { return; }
    const names = entries.map((e) => e.name);

    const type = detectType(names);
    if (type) {
      const project = await buildProject(dir, type, signal);
      if (project) { projects.push(project); emit(dir, true); }
      return; // do not descend further for project detection
    }
    // descend into non-excluded subdirectories
    if (depth > 12) return;
    for (const e of entries) {
      if (signal?.aborted) return;
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') && e.name !== '.') {
        if (EXCLUDED_DIRS.has(e.name)) continue;
      }
      if (EXCLUDED_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }

  await walk(root, 0);
  onProgress?.({ phase: 'done', scanned, found: projects.length });
  return { projects, scanned };
}

/** Build a project record: find cleanable items, sizes, mtime, git. */
async function buildProject(dir, type, signal) {
  const items = [];
  // find cleanable directories/files anywhere inside the project
  const stack = [dir];
  while (stack.length) {
    if (signal?.aborted) break;
    const cur = stack.pop();
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of ents) {
      const full = path.join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (CLEAN_NAMES.has(e.name)) {
        const rule = CLEAN_BY_NAME[e.name];
        let size = 0;
        try { size = e.isDirectory() ? await dirSize(full, signal) : (await fsp.stat(full)).size; } catch { /* */ }
        items.push({ name: e.name, path: full, size, isDir: e.isDirectory(), kind: rule.kind, safe: rule.safe, reversible: rule.reversible !== false, note: rule.note });
        // do not descend into a cleanable dir
      } else if (e.isDirectory()) {
        stack.push(full);
      }
    }
  }
  items.sort((a, b) => b.size - a.size);
  const cleanableSize = items.reduce((s, i) => s + i.size, 0);

  let mtime = 0;
  try { mtime = (await fsp.stat(dir)).mtimeMs; } catch { /* */ }

  const iconPath = await findProjectIcon(dir, type);
  const isGit = await fsp.stat(path.join(dir, '.git')).then((s) => s.isDirectory(), () => false);

  const project = {
    name: path.basename(dir),
    path: dir,
    type: { id: type.id, name: type.name, icon: type.icon },
    items,
    cleanableSize,
    totalSize: 0, // computed lazily on demand to keep scans fast
    mtime,
    git: null,
    isGit,
    iconPath,
  };
  return project;
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
  for (const rel of order) { const f = await isFile(rel); if (f) return f; }

  const android = await findAndroidIcon(dir);
  if (android) return android;
  return await findIosIcon(dir);
}
async function findAndroidIcon(dir) {
  const roots = ['app/src/main/res', 'android/app/src/main/res', 'src/main/res'];
  const densities = ['mipmap-xxxhdpi', 'mipmap-xxhdpi', 'mipmap-xhdpi', 'mipmap-hdpi', 'mipmap-mdpi', 'drawable-xxxhdpi'];
  const names = ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png'];
  for (const r of roots) for (const d of densities) for (const n of names) {
    try { const f = path.join(dir, r, d, n); if ((await fsp.stat(f)).isFile()) return f; } catch { /* */ }
  }
  return null;
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
  scanProjects, dirSize, enrichProject, gitStatus,
};
