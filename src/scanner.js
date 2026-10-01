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
const languages = require('./languages');
const techCache = require('./tech-cache');
const { projectFigures } = require('./reclaimable');
const repoGroup = require('./repo-group');

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
 * `ambiguous` names are also used for committed source (Go vendor/, a library's
 * dist/, electron-builder's build/). `needsManifest` names are only safe beside
 * a Cargo.toml or pom.xml. Whatever the rule says, a candidate is only marked
 * safe when git ignores it and tracks nothing inside it (see classifyInRepo),
 * and a directory holding a git-tracked file is never offered.
 */
const CLEAN_RULES = [
  { match: 'node_modules',   kind: 'node',    safe: true,  note: 'Installed npm packages, restore with `npm install`.' },
  { match: 'target',         kind: 'java',    safe: true,  needsManifest: true, note: 'Maven/Rust build output.' },
  { match: 'build',          kind: 'gradle',  safe: true,  ambiguous: true,  note: 'Build output (Gradle/Android/etc.).' },
  { match: 'dist',           kind: 'box',     safe: true,  ambiguous: true,  note: 'Bundled distribution output.' },
  { match: 'out',            kind: 'box',     safe: true,  ambiguous: true,  note: 'Compiler/bundler output.' },
  // .NET and C/C++ intermediates. Worth naming explicitly: an obj/ tree buries
  // hundreds of tiny build/ folders that are far more useful counted as one.
  { match: 'obj',            kind: 'box',     safe: true,  note: '.NET/C build intermediates.' },
  { match: '.next',          kind: 'react',   safe: true,  note: 'Next.js build cache.' },
  { match: '.nuxt',          kind: 'react',   safe: true,  note: 'Nuxt build cache.' },
  { match: '.turbo',         kind: 'flash',   safe: true,  note: 'Turborepo cache.' },
  { match: '.output',        kind: 'box',     safe: true,  note: 'Nuxt/Nitro build output.' },
  { match: '.parcel-cache',  kind: 'flash',   safe: true,  note: 'Parcel bundler cache.' },
  { match: '.svelte-kit',    kind: 'svelte',  safe: true,  note: 'SvelteKit build output.' },
  { match: '.angular',       kind: 'react',   safe: true,  note: 'Angular build cache.' },
  { match: '.gradle',        kind: 'gradle',  safe: true,  note: 'Per-project Gradle cache.' },
  { match: '__pycache__',    kind: 'python',  safe: true,  note: 'Python bytecode cache.' },
  { match: '.pytest_cache',  kind: 'python',  safe: true,  note: 'Pytest cache.' },
  { match: '.mypy_cache',    kind: 'python',  safe: true,  note: 'Mypy type-check cache.' },
  { match: '.ruff_cache',    kind: 'python',  safe: true,  note: 'Ruff lint cache.' },
  { match: '.dart_tool',     kind: 'flutter', safe: true,  note: 'Dart/Flutter tool cache, restore with `pub get`.' },
  { match: 'venv',           kind: 'python',  safe: false, note: 'Python virtualenv, recreate with your tooling.' },
  { match: '.venv',          kind: 'python',  safe: false, note: 'Python virtualenv, recreate with your tooling.' },
  { match: 'vendor',         kind: 'php',     safe: true,  ambiguous: true,  note: 'Composer/Go vendored deps, restore with install.' },
  { match: 'Pods',           kind: 'apple',   safe: true,  note: 'CocoaPods deps, restore with `pod install`.' },
  { match: 'DerivedData',    kind: 'apple',   safe: true,  note: 'Xcode build cache.' },
  { match: 'coverage',       kind: 'file',    safe: true,  note: 'Test coverage reports.' },
  { match: '.terraform',     kind: 'box',     safe: true,  note: 'Terraform provider cache.' },
];
const CLEAN_NAMES = new Set(CLEAN_RULES.map((r) => r.match));
// Ignored files inside a worktree that are build output do not block its removal.
require('./worktrees').setArtifactNames(CLEAN_NAMES);
const CLEAN_BY_NAME = Object.fromEntries(CLEAN_RULES.map((r) => [r.match, r]));

/** Directories we never descend into while *detecting* projects. */
const EXCLUDED_DIRS = new Set([
  ...CLEAN_NAMES,
  '.git', '.svn', '.hg', '.idea', '.vscode', '.vs', '.cache',
  'Library', 'Applications', 'System', '.Trash',
]);

// Re-exported for existing callers; the table lives in constants.js.
const { SKIP_DELETE } = require('./constants');

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
    execFile('du', ['-skx', dir], { timeout: 120000, signal, maxBuffer: 1024 * 1024 }, (err, stdout) => {
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
async function scanProjects(root, onProgress, signal, opts = {}) {
  const projects = [];
  // Every folder with a .git entry the walk passed through (main checkouts,
  // linked worktrees, submodules), for grouping by repository afterwards.
  const checkouts = [];
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
    if (names.includes('.git')) checkouts.push(dir);

    const types = detectTypes(names);
    if (types.length) {
      const project = await buildProject(dir, types, signal, names);
      if (!project) return null;
      // Checkouts nested inside the project (a worktree under .claude/worktrees,
      // a submodule, a cloned repo) are repositories of their own: the artifact
      // walk stopped at them, and project detection continues there.
      const nested = project.nestedCheckouts || [];
      delete project.nestedCheckouts;
      projects.push(project);
      emit(dir, true);
      return depth > 12 ? null : nested.map((d) => ({ dir: d, depth: depth + 1 }));
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
  if (opts.group === false) {
    onProgress?.({ phase: 'done', scanned, files, found: projects.length, percent: 100 });
    return { projects, scanned };
  }
  // One record per repository: packages and linked worktrees fold into it.
  onProgress?.({ phase: 'grouping', scanned, files, found: projects.length, percent: 96 });
  const grouped = await repoGroup.consolidate(projects, {
    root, signal, dirSize, checkouts, measure: opts.measure, measureMain: opts.measureMain,
  });
  onProgress?.({ phase: 'done', scanned, files, found: grouped.projects.length, percent: 100 });
  return { projects: grouped.projects, scanned, stats: grouped.stats };
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

// ---------------------------------------------------------------------------
// Build-output verification
//
// A folder name proves nothing: `build/` also holds signing entitlements, and a
// brand new source folder is untracked before its first commit. So a candidate
// is safe only when its innermost git repository gives positive evidence:
//   1. git ignores the candidate itself, while no folder above it (up to the
//      repo root) is ignored. An ignored ancestor, such as a dotfiles repo at ~
//      ignoring `*`, says nothing about the project.
//   2. git tracks nothing inside it (catches files force-added under an
//      ignored folder, and submodule gitlinks).
//   3. it is not itself a git repository.
// Anything else, including git missing, erroring or timing out, is doubt, and
// doubt is never safe.
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 15000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Keep each ls-files argv well below ARG_MAX, however many candidates there are.
// Windows caps a whole command line at 32767 characters.
const GIT_ARGV_BYTES = process.platform === 'win32' ? 24 * 1024 : 96 * 1024;

const nfc = (s) => s.normalize('NFC');
/** Both Unicode forms of a path: macOS can store NFD names while git prints NFC. */
const bothForms = (s) => {
  const a = s.normalize('NFC');
  const b = s.normalize('NFD');
  return a === b ? [a] : [a, b];
};

/** Git must answer about the folder we ask about, not a repo named by the environment. */
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

/** Run git, never throwing. Resolves { err, stdout, stderr }. */
function runGit(cwd, args, { input, signal, timeout = GIT_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile('git', ['-C', cwd, ...args],
        { timeout, signal, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), encoding: 'utf8' },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (err) {
      resolve({ err, stdout: '', stderr: '' });
      return;
    }
    child.stdin?.on('error', () => { /* git exited early, the callback reports it */ });
    child.stdin?.end(input || '');
  });
}

function gitFailure(res, what) {
  const err = res.err;
  if (err && err.code === 'ENOENT') return 'git is not available';
  if (err && err.killed) return `git took too long to ${what}`;
  if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `git produced too much output to ${what}`;
  if (/not a git repository/i.test(res.stderr)) return 'it is not inside a git repository';
  return `git could not ${what}`;
}
const isNotRepo = (res) => res.err && typeof res.err.code === 'number' && !res.err.killed
  && /not a git repository/i.test(res.stderr);

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

/** First `.git` entry (directory or file) below `dir`, walked in JS. */
async function walkForGit(dir, signal) {
  let found = false;
  let unreadable = false;
  await drain([dir], WALK_WORKERS, async (cur) => {
    if (found || signal?.aborted) return null;
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { unreadable = true; return null; }
    const subdirs = [];
    for (const e of ents) {
      if (e.name === '.git') { found = true; return null; }
      if (e.isDirectory() && !e.isSymbolicLink()) subdirs.push(path.join(cur, e.name));
    }
    return subdirs;
  }, signal);
  if (found) return 'found';
  return unreadable || signal?.aborted ? 'unknown' : 'none';
}

/**
 * Is there a git repository anywhere inside `dir`? A clone under an ignored
 * vendor/ or node_modules/ can hold unpushed commits. `find -quit` stops at the
 * first hit and reads directories in C. Resolves 'found', 'none' or 'unknown'
 * (unreadable folders or a failed search, which is doubt).
 */
// Its own ceiling, so the search runs beside sizing instead of queueing behind it.
const withFindSlot = makeGate(SIZE_WORKERS);

function findNestedGit(dir, signal) {
  if (process.platform === 'win32') return withFindSlot(() => walkForGit(dir, signal));
  return withFindSlot(() => new Promise((resolve) => {
    execFile('find', [dir, '-mindepth', '1', '-name', '.git', '-print', '-quit'],
      { timeout: 120000, signal, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (String(stdout || '').trim()) return resolve('found');
        if (err && err.code === 'ENOENT') return walkForGit(dir, signal).then(resolve);
        resolve(err ? 'unknown' : 'none');
      });
  }));
}

async function nestedGitReason(c, signal) {
  if (!c.isDir) return null;
  // The scan hands over a search it already started right after sizing, while
  // the folder's entries are still in the filesystem cache.
  const res = await (c.nestedGit || findNestedGit(c.path, signal));
  if (res === 'found') return 'it contains a git repository, which may hold unpushed work';
  if (res === 'unknown') return 'Spaci could not look inside all of it for git repositories';
  return null;
}

/**
 * Resolve the innermost git repository git itself sees from `dir`. Returns
 * { top, prefix } or { error }. A `.git` entry between `dir` and the repo root
 * that git skipped (a broken nested repo) is doubt, not a pass.
 */
async function resolveRepo(dir, signal) {
  const res = await runGit(dir, ['rev-parse', '--show-toplevel', '--show-prefix'], { signal, timeout: 5000 });
  if (res.err) return { error: gitFailure(res, 'read this folder'), notRepo: isNotRepo(res) };
  const lines = res.stdout.split('\n');
  // Two lines plus the trailing newline. More means a newline in a path.
  if (lines.length !== 3 || !lines[0]) return { error: 'git gave an unexpected answer' };
  const prefix = nfc(lines[1]);
  const depth = prefix.split('/').filter(Boolean).length;
  let cur = dir;
  for (let i = 0; i < depth; i++) {
    if (await exists(path.join(cur, '.git'))) return { error: 'a nested .git folder here is not a repository git recognises' };
    cur = path.dirname(cur);
  }
  return { top: lines[0], prefix };
}

/**
 * Tracked files under the given repo-relative paths, as NFC paths. Matching is
 * case-insensitive: on a case-insensitive disk the index can hold `Dist/keep.js`
 * while the folder reads as `dist`. Over-matching on a case-sensitive disk only
 * hides a folder, which is the safe direction.
 */
async function trackedFiles(top, rels, signal) {
  // Per-pathspec magic: `literal` keeps `*` or `[a]` literal, `icase` ignores
  // case. Git refuses the global --literal-pathspecs together with icase.
  const specs = [...new Set(rels.flatMap(bothForms))].map((r) => `:(literal,icase)${r}`);
  const chunks = [];
  let chunk = [];
  let bytes = 0;
  for (const s of specs) {
    const len = Buffer.byteLength(s) + 1;
    if (chunk.length && bytes + len > GIT_ARGV_BYTES) { chunks.push(chunk); chunk = []; bytes = 0; }
    chunk.push(s);
    bytes += len;
  }
  if (chunk.length) chunks.push(chunk);
  const files = [];
  for (const c of chunks) {
    const res = await runGit(top, ['ls-files', '-z', '--full-name', '--', ...c], { signal });
    if (res.err) return { error: gitFailure(res, 'list tracked files') };
    for (const f of res.stdout.split('\0')) if (f) files.push(nfc(f));
  }
  return { files };
}

/**
 * Classify candidates that all share one innermost repository, resolved from
 * `keyDir`. One rev-parse, one check-ignore (paths on stdin) and one ls-files
 * (argv chunked by size) per repository. Returns Map(path -> verdict) where a
 * verdict is { state, reason? } and state is 'safe', 'tracked', 'unverified'
 * (doubt) or 'nogit' (git says it is outside any repo it can vouch for).
 */
async function classifyInRepo(keyDir, cands, signal) {
  const out = new Map();
  const failAll = (reason, state = 'unverified') => {
    for (const c of cands) out.set(c.path, { state, reason });
    return out;
  };

  const repo = await resolveRepo(keyDir, signal);
  if (repo.error) return failAll(repo.error, repo.notRepo ? 'nogit' : 'unverified');

  const rels = cands.map((c) => nfc(repo.prefix + path.relative(keyDir, c.path).split(path.sep).join('/')));
  if (rels.some((r) => !r || r.startsWith('../') || r.includes('\n'))) return failAll('git gave an unexpected answer');

  // Every folder between the repo root and each candidate, plus the candidates.
  const ancestorsOf = (rel) => {
    const parts = rel.split('/');
    const list = [];
    for (let i = 1; i < parts.length; i++) list.push(parts.slice(0, i).join('/'));
    return list;
  };
  const dirs = new Set();
  for (const rel of rels) for (const a of ancestorsOf(rel)) dirs.add(a);
  const queries = [];
  for (const d of dirs) for (const f of bothForms(d)) queries.push(f + '/');
  cands.forEach((c, i) => { for (const f of bothForms(rels[i])) queries.push(c.isDir ? f + '/' : f); });

  // The two questions are independent, so ask them at the same time.
  const [ci, ls] = await Promise.all([
    // Only the repo's own rules count as proof (.gitignore files and
    // .git/info/exclude). An empty core.excludesFile turns off the personal
    // global excludes, including the XDG default, on every platform.
    runGit(repo.top, ['-c', 'core.excludesFile=', 'check-ignore', '--stdin', '-z'],
      { input: queries.join('\0') + '\0', signal }),
    trackedFiles(repo.top, rels, signal),
  ]);
  // Exit 1 is git's "nothing is ignored", a valid answer.
  if (ci.err && !(ci.err.code === 1 && !ci.err.killed)) return failAll(gitFailure(ci, 'check ignore rules'));
  if (ls.error) return failAll(ls.error);
  const ignored = new Set(ci.stdout.split('\0').filter(Boolean).map((p) => nfc(p).replace(/\/+$/, '')));
  const fold = (p) => p.toLowerCase();
  const index = new Map();
  rels.forEach((r, i) => {
    const k = fold(r);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(i);
  });
  const tracked = new Set();
  for (const f of ls.files) {
    let p = fold(f);
    for (;;) {
      if (index.has(p)) for (const i of index.get(p)) tracked.add(i);
      const k = p.lastIndexOf('/');
      if (k < 0) break;
      p = p.slice(0, k);
    }
  }

  await Promise.all(cands.map(async (c, i) => {
    const rel = rels[i];
    let verdict;
    if (tracked.has(i)) verdict = { state: 'tracked', reason: 'it contains files tracked by git' };
    else if (ancestorsOf(rel).some((a) => ignored.has(a))) verdict = { state: 'nogit', reason: 'it sits inside a folder git ignores, so git cannot vouch for it' };
    else if (!ignored.has(rel)) verdict = { state: 'unverified', reason: 'git does not ignore it' };
    else {
      const nested = await nestedGitReason(c, signal);
      verdict = nested ? { state: 'unverified', reason: nested } : { state: 'safe' };
    }
    out.set(c.path, verdict);
  }));
  return out;
}

/**
 * Names that are only ever regenerable output, whatever project holds them.
 * Outside git these may still be cleaned, unverified. Ambiguous names (build,
 * dist, out, vendor, target, .output, coverage, obj) can be committed source,
 * so outside git they are never deletable.
 */
const UNAMBIGUOUS_NAMES = new Set([
  'node_modules', '.next', '.svelte-kit', '.nuxt', '.turbo', '.parcel-cache', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.gradle', '.dart_tool', 'Pods',
]);

/**
 * Re-check one project artifact right before it is deleted. Scans are cached
 * for days, and a folder can gain tracked files or lose its ignore rule in the
 * meantime. The rule is reapplied in full: a known artifact name, its manifest
 * where the rule needs one, then git. In git, only an ignored folder with no
 * tracked content and no repository inside passes ({ ok: true, verified: true }).
 * Outside git, only unambiguous names pass, unverified ({ ok: true, verified:
 * false }). Any doubt fails with a short reason.
 * @param {string} absPath
 * @returns {Promise<{ok: boolean, verified?: boolean, reason?: string}>}
 */
async function revalidateArtifact(absPath) {
  const no = (reason) => ({ ok: false, reason: reason.charAt(0).toUpperCase() + reason.slice(1) + '.' });
  try {
    if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return no('not an absolute path');
    const name = path.basename(absPath);
    const rule = Object.prototype.hasOwnProperty.call(CLEAN_BY_NAME, name) ? CLEAN_BY_NAME[name] : null;
    if (!rule) return no('it is not a folder Spaci knows as build output');
    if (!rule.safe) return no('this kind of folder is never removed without review');
    let st;
    try { st = await fsp.lstat(absPath); } catch { return no('it no longer exists'); }
    if (st.isSymbolicLink()) return no('it is a symbolic link');
    const parent = path.dirname(absPath);
    if (rule.needsManifest
      && !(await exists(path.join(parent, 'Cargo.toml')) || await exists(path.join(parent, 'pom.xml')))) {
      return no('there is no Cargo.toml or pom.xml beside it');
    }
    const cand = { path: absPath, isDir: st.isDirectory() };
    const verdicts = await classifyInRepo(parent, [cand]);
    const v = verdicts.get(absPath);
    if (v && v.state === 'safe') return { ok: true, verified: true };
    if (v && v.state === 'nogit') {
      if (!UNAMBIGUOUS_NAMES.has(name)) return no(`${v.reason}, and "${name}" can be source code`);
      const nested = await nestedGitReason(cand);
      if (nested) return no(nested);
      return { ok: true, verified: false };
    }
    return no(v ? v.reason : 'Spaci could not check it');
  } catch {
    return no('Spaci could not check it');
  }
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
  // Each candidate remembers its innermost repo: the nearest folder holding a
  // `.git` entry (a directory, or a file for worktrees and submodules), else
  // the project folder, whose enclosing repo git resolves.
  const found = [];
  const nestedCheckouts = [];
  const subPackages = [];
  await drain([{ cur: dir, depth: 0, repo: dir }], WALK_WORKERS, async ({ cur, depth, repo }) => {
    let ents;
    try { ents = await fsp.readdir(cur, { withFileTypes: true }); }
    catch { return null; }
    const hasGit = ents.some((e) => e.name === '.git');
    // Another checkout below the project root belongs to its own repository
    // (or, for a linked worktree, is grouped under its main repository).
    if (hasGit && depth > 0) { nestedCheckouts.push(cur); return null; }
    const here = hasGit ? cur : repo;
    // Marker folders inside the project are its packages (monorepo workspaces).
    if (depth > 0 && depth <= 4) {
      const t = detectTypes(ents.map((e) => e.name));
      if (t.length) subPackages.push({ path: cur, types: t.map((x) => ({ id: x.id, name: x.name, icon: x.icon, score: x.score })) });
    }
    const subdirs = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(cur, e.name);
      if (CLEAN_NAMES.has(e.name)) {
        found.push({
          name: e.name, path: full, isDir: e.isDirectory(), repo: here,
          hasManifest: ents.some((x) => x.name === 'Cargo.toml' || x.name === 'pom.xml'),
        });
        continue; // do not descend into a cleanable dir
      }
      if (!e.isDirectory()) continue;
      if (ITEM_SKIP_DIRS.has(e.name)) continue;
      if (depth >= ITEM_MAX_DEPTH) continue;
      subdirs.push({ cur: full, depth: depth + 1, repo: here });
    }
    return subdirs;
  }, signal);

  // The search for a git repository inside each folder starts once its du is
  // done (see below), so it reads directories that are already cached.
  for (const f of found) {
    if (!f.isDir) continue;
    let start;
    f.nestedGit = new Promise((resolve) => { start = resolve; });
    f.startNestedGit = () => start(findNestedGit(f.path, signal));
  }

  // Ask each innermost repo once about all of its candidates.
  const byRepo = new Map();
  for (const f of found) {
    if (!byRepo.has(f.repo)) byRepo.set(f.repo, []);
    byRepo.get(f.repo).push(f);
  }
  const verdicts = new Map();
  const checked = Promise.all([...byRepo].map(async ([key, cands]) => {
    let res;
    try { res = await classifyInRepo(key, cands, signal); } catch { res = new Map(); }
    for (const c of cands) verdicts.set(c.path, res.get(c.path) || { state: 'unverified', reason: 'git could not check it' });
  }));

  // Size while git answers. Every verdict is in before anything is returned.
  const sized = await mapPool(found, SIZE_WORKERS, async (f) => {
    let size = 0;
    try { size = f.isDir ? await dirSize(f.path, signal) : (await fsp.stat(f.path)).size; }
    catch { /* unreadable, count it as zero */ }
    finally { if (f.isDir) f.startNestedGit(); }
    return size;
  });
  await checked;

  const items = [];
  found.forEach((f, idx) => {
    const verdict = verdicts.get(f.path);
    // Tracked content is never offered at all.
    if (!verdict || verdict.state === 'tracked') return;
    const rule = CLEAN_BY_NAME[f.name];
    let safe = rule.safe;
    let note = rule.note;
    if (rule.needsManifest && !f.hasManifest) {
      safe = false;
      note = 'Could not verify this is build output (no Cargo.toml or pom.xml beside it).';
    } else if (verdict.state !== 'safe') {
      safe = false;
      note = `${rule.note} Spaci could not verify it is build output: ${verdict.reason}.`;
    }
    items.push({
      name: f.name, path: f.path, size: sized[idx], isDir: f.isDir,
      kind: rule.kind, safe, reversible: rule.reversible !== false, note,
    });
  });
  items.sort((a, b) => b.size - a.size);
  // Only safe items are ever passed to the cleaner, so only they count as
  // reclaimable; unverified bytes are reported apart (issue #13).
  const { cleanableSize, unverifiedSize } = projectFigures(items);

  // The scanner already read this listing, so Docker detection costs nothing.
  const names = rootEntries || await fsp.readdir(dir).catch(() => []);
  const dockerFiles = docker.detect(names);

  const [mtime, iconPath, isGit, services, primary] = await Promise.all([
    fsp.stat(dir).then((s) => s.mtimeMs, () => 0),
    findProjectIcon(dir, type),
    // A worktree or submodule has .git as a file, not a directory.
    fsp.stat(path.join(dir, '.git')).then(() => true, () => false),
    dockerFiles && dockerFiles.composeFiles.length
      ? docker.composeServices(path.join(dir, dockerFiles.composeFiles[0]))
      : Promise.resolve([]),
    // Root manifests only, so the list can show a tech icon before enrichment.
    languages.quickPrimary(dir, names),
  ]);

  const project = {
    name: path.basename(dir),
    path: dir,
    type: { id: type.id, name: type.name, icon: type.icon },
    types: types.map((t) => ({ id: t.id, name: t.name, icon: t.icon, score: t.score, markers: t.matchedMarkers || [] })),
    items,
    cleanableSize,
    unverifiedSize,
    totalSize: 0, // computed lazily on demand to keep scans fast
    mtime,
    git: null,
    isGit,
    iconPath,
    primary,
    // Engine storage (images, volumes, cache) is attached later by
    // attachDockerUsage: it needs one daemon call for the whole scan, not one
    // per project.
    docker: dockerFiles ? { ...dockerFiles, services, usage: null } : null,
  };
  if (subPackages.length) project.subPackages = subPackages;
  if (nestedCheckouts.length) project.nestedCheckouts = nestedCheckouts;
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
    // A repository record also answers for its packages with Docker files.
    let usage = byDir.get(p.path);
    for (const d of Array.isArray(p.dockerDirs) ? p.dockerDirs : []) {
      const u = byDir.get(d);
      if (!u) continue;
      usage = usage ? sumUsage(usage, u) : u;
    }
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

function sumUsage(a, b) {
  return {
    project: a.project,
    containers: [...a.containers, ...b.containers],
    running: (a.running || 0) + (b.running || 0),
    images: [...a.images, ...b.images],
    volumes: [...a.volumes, ...b.volumes],
    imageBytes: (a.imageBytes || 0) + (b.imageBytes || 0),
    volumeBytes: (a.volumeBytes || 0) + (b.volumeBytes || 0),
    containerBytes: (a.containerBytes || 0) + (b.containerBytes || 0),
    totalBytes: (a.totalBytes || 0) + (b.totalBytes || 0),
  };
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

// Language and framework analysis per project, reused while nothing it depends
// on changed: the git HEAD (or its absence), the manifests it read and the
// project folder's own mtime. A bounded LRU keyed by the resolved path; see
// tech-cache.js, which also lets main carry it across worker restarts.
const TECH_CACHE = techCache.createLru(techCache.TECH_CACHE_MAX);
const EMPTY_TECH = { languages: [], frameworks: [], primary: null, analysis: null };
const techStats = { hits: 0, misses: 0 };

async function techKey(dir, signal) {
  const [res, rootMtime] = await Promise.all([
    runGit(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { signal, timeout: 3000 }),
    fsp.stat(dir).then((s) => s.mtimeMs, () => 0),
  ]);
  const head = !res.err && /^[0-9a-f]{40,64}$/.test(res.stdout.trim()) ? res.stdout.trim() : null;
  return { head, rootMtime };
}

async function stampsUnchanged(dir, stamps) {
  const now = await Promise.all(stamps.map(([rel]) =>
    fsp.stat(path.join(dir, rel)).then((s) => s.mtimeMs, () => -1)));
  return stamps.every(([, m], i) => now[i] === m);
}

async function analyzeTech(dir, signal, opts = {}) {
  try {
    const ck = techCache.techCacheKey(dir);
    const key = await techKey(dir, signal);
    const hit = ck ? TECH_CACHE.get(ck) : undefined;
    if (hit && techCache.stampMatches(hit, key) && await stampsUnchanged(dir, hit.manifests)) {
      techStats.hits++;
      return hit.result;
    }
    techStats.misses++;
    const { result, manifests } = await languages.analyzeProjectDetailed(dir, { signal, ...opts });
    // A partial answer (budget or abort) is returned but never cached.
    if (ck && !result.analysis.truncated && !signal?.aborted) {
      TECH_CACHE.set(ck, { ...key, manifests, result });
    } else if (ck && hit) {
      TECH_CACHE.delete(ck); // stale, and no complete answer to replace it
    }
    return result;
  } catch {
    return EMPTY_TECH;
  }
}

/** Snapshot of the analysis cache (for main to keep between worker lifetimes). */
function exportTechCache() { return techCache.exportEntries(TECH_CACHE); }
/** Seed the analysis cache from a snapshot; entries already in memory win. */
function importTechCache(snapshot) { return techCache.importEntries(TECH_CACHE, snapshot); }
/** Hit and miss counts, and the current size (tests, diagnostics). */
function techCacheStats() { return { ...techStats, size: TECH_CACHE.size, max: TECH_CACHE.max }; }

/** Compute total size, git and languages/frameworks for one project (called on selection / details). */
async function enrichProject(dir, signal) {
  const [total, git, tech] = await Promise.all([dirSize(dir, signal), gitStatus(dir), analyzeTech(dir, signal)]);
  return {
    totalSize: total, git,
    languages: tech.languages, frameworks: tech.frameworks, primary: tech.primary, analysis: tech.analysis,
  };
}

module.exports = {
  PROJECT_TYPES, CLEAN_RULES, SKIP_DELETE,
  scanProjects, dirSize, enrichProject, analyzeTech, gitStatus, detectType, detectTypes,
  exportTechCache, importTechCache, techCacheStats,
  attachDockerUsage, walkSize, drain, mapPool, revalidateArtifact, findNestedGit,
};
