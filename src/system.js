'use strict';
/**
 * Cross-platform system cleaner: a catalog of safe, reclaimable cache locations.
 * Every target here is regenerable; nothing user-created is listed.
 * Sizes are measured live (du on macOS/Linux, a bounded Node walk on Windows).
 * Cleaning empties contents (keeps the dir).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const HOME = os.homedir();
const h = (...p) => path.join(HOME, ...p);

/**
 * Each target: { id, name, description, category, icon, safe, reversible, mode,
 *   paths:[absolute paths] }. mode is 'contents' for all (empty the dir, keep it).
 * reversible is true for every target since all listed caches regenerate.
 */

// ---------------------------------------------------------------------------
// Platform catalogs
// ---------------------------------------------------------------------------

const darwinTargets = [
  // ---- Developer caches ----
  { id: 'npm',        name: 'npm cache',          category: 'Developer', icon: 'node',    safe: true,  reversible: true, mode: 'contents', paths: [h('.npm', '_cacache')], description: 'Downloaded npm package tarballs. Rebuilds on next install.' },
  { id: 'yarn',       name: 'Yarn cache',         category: 'Developer', icon: 'node',    safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Caches/Yarn'), h('.yarn/cache')], description: 'Yarn package cache.' },
  { id: 'pnpm',       name: 'pnpm store',         category: 'Developer', icon: 'node',    safe: true,  reversible: true, mode: 'contents', paths: [h('Library/pnpm/store'), h('.pnpm-store')], description: 'pnpm content-addressable store.' },
  { id: 'bun',        name: 'Bun cache',          category: 'Developer', icon: 'flash',   safe: true,  reversible: true, mode: 'contents', paths: [h('.bun/install/cache')], description: 'Bun install cache.' },
  { id: 'gradle',     name: 'Gradle cache',       category: 'Developer', icon: 'gradle',  safe: true,  reversible: true, mode: 'contents', paths: [h('.gradle/caches')], description: 'Global Gradle build cache & downloaded deps.' },
  { id: 'maven',      name: 'Maven repository',   category: 'Developer', icon: 'java',    safe: true,  reversible: true, mode: 'contents', paths: [h('.m2/repository')], description: 'Downloaded Maven artifacts. Re-downloads on build.' },
  { id: 'cargo',      name: 'Cargo registry',     category: 'Developer', icon: 'rust',    safe: true,  reversible: true, mode: 'contents', paths: [h('.cargo/registry/cache'), h('.cargo/registry/src')], description: 'Rust crate cache.' },
  { id: 'cocoapods',  name: 'CocoaPods cache',    category: 'Developer', icon: 'apple',   safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Caches/CocoaPods')], description: 'CocoaPods spec & pod cache.' },
  { id: 'pub',        name: 'Dart/Flutter pub',   category: 'Developer', icon: 'flutter', safe: true,  reversible: true, mode: 'contents', paths: [h('.pub-cache/hosted')], description: 'Dart/Flutter downloaded packages.' },
  { id: 'pip',        name: 'pip cache',          category: 'Developer', icon: 'python',  safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Caches/pip')], description: 'Python pip download cache.' },
  { id: 'go',         name: 'Go build/mod cache', category: 'Developer', icon: 'go',      safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Caches/go-build'), h('go/pkg/mod/cache')], description: 'Go build & module cache.' },
  { id: 'deno',       name: 'Deno cache',         category: 'Developer', icon: 'flash',   safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Caches/deno')], description: 'Deno dependency cache.' },

  // ---- Xcode / Apple ----
  { id: 'xcode-derived', name: 'Xcode DerivedData', category: 'Xcode', icon: 'apple', safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Developer/Xcode/DerivedData')], description: 'Xcode build intermediates. Safe to wipe, it rebuilds.' },
  { id: 'xcode-archives', name: 'Xcode Archives',   category: 'Xcode', icon: 'box',   safe: false, reversible: true, mode: 'contents', paths: [h('Library/Developer/Xcode/Archives')], description: 'App archives for distribution. Delete only if already uploaded.' },
  { id: 'xcode-devicesupport', name: 'iOS DeviceSupport', category: 'Xcode', icon: 'apple', safe: true, reversible: true, mode: 'contents', paths: [h('Library/Developer/Xcode/iOS DeviceSupport')], description: 'Cached symbols per iOS version. Regenerates when you attach a device.' },
  { id: 'simulator-caches', name: 'Simulator caches', category: 'Xcode', icon: 'apple', safe: true, reversible: true, mode: 'contents', paths: [h('Library/Developer/CoreSimulator/Caches')], description: 'Core Simulator caches.' },

  // ---- System ----
  { id: 'user-caches', name: 'User app caches',  category: 'System', icon: 'database', safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Caches')], description: 'Per-app caches in ~/Library/Caches. Apps rebuild them.' },
  { id: 'user-logs',   name: 'User logs',        category: 'System', icon: 'log',      safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Logs')], description: 'Application log files.' },
  { id: 'trash',       name: 'Trash',            category: 'System', icon: 'trash',    safe: true,  reversible: true, mode: 'contents', paths: [h('.Trash')], description: 'Files in the Trash.' },
  { id: 'saved-state', name: 'Saved app state',  category: 'System', icon: 'box',      safe: true,  reversible: true, mode: 'contents', paths: [h('Library/Saved Application State')], description: 'Window restore state. Apps just open fresh.' },

  // ---- Browsers ----
  { id: 'chrome-cache', name: 'Chrome cache',    category: 'Browsers', icon: 'chrome', safe: true, reversible: true, mode: 'contents', paths: [h('Library/Caches/Google/Chrome')], description: 'Chrome on-disk cache.' },
  { id: 'safari-cache', name: 'Safari cache',    category: 'Browsers', icon: 'safari', safe: true, reversible: true, mode: 'contents', paths: [h('Library/Caches/com.apple.Safari')], description: 'Safari cache.' },
];

const linuxTargets = [
  // ---- Developer caches ----
  { id: 'npm',    name: 'npm cache',          category: 'Developer', icon: 'node',    safe: true, reversible: true, mode: 'contents', paths: [h('.npm', '_cacache')], description: 'Downloaded npm package tarballs. Rebuilds on next install.' },
  { id: 'yarn',   name: 'Yarn cache',         category: 'Developer', icon: 'node',    safe: true, reversible: true, mode: 'contents', paths: [h('.cache/yarn')], description: 'Yarn package cache.' },
  { id: 'pnpm',   name: 'pnpm store',         category: 'Developer', icon: 'node',    safe: true, reversible: true, mode: 'contents', paths: [h('.local/share/pnpm/store')], description: 'pnpm content-addressable store.' },
  { id: 'gradle', name: 'Gradle cache',       category: 'Developer', icon: 'gradle',  safe: true, reversible: true, mode: 'contents', paths: [h('.gradle/caches')], description: 'Global Gradle build cache & downloaded deps.' },
  { id: 'maven',  name: 'Maven repository',   category: 'Developer', icon: 'java',    safe: true, reversible: true, mode: 'contents', paths: [h('.m2/repository')], description: 'Downloaded Maven artifacts. Re-downloads on build.' },
  { id: 'cargo',  name: 'Cargo registry',     category: 'Developer', icon: 'rust',    safe: true, reversible: true, mode: 'contents', paths: [h('.cargo/registry/cache'), h('.cargo/registry/src')], description: 'Rust crate cache.' },
  { id: 'pip',    name: 'pip cache',          category: 'Developer', icon: 'python',  safe: true, reversible: true, mode: 'contents', paths: [h('.cache/pip')], description: 'Python pip download cache.' },
  { id: 'go',     name: 'Go build/mod cache', category: 'Developer', icon: 'go',      safe: true, reversible: true, mode: 'contents', paths: [h('.cache/go-build'), h('go/pkg/mod/cache')], description: 'Go build & module cache.' },
  { id: 'pub',    name: 'Dart/Flutter pub',   category: 'Developer', icon: 'flutter', safe: true, reversible: true, mode: 'contents', paths: [h('.pub-cache/hosted')], description: 'Dart/Flutter downloaded packages.' },
  { id: 'bun',    name: 'Bun cache',          category: 'Developer', icon: 'flash',   safe: true, reversible: true, mode: 'contents', paths: [h('.bun/install/cache')], description: 'Bun install cache.' },
  { id: 'deno',   name: 'Deno cache',         category: 'Developer', icon: 'flash',   safe: true, reversible: true, mode: 'contents', paths: [h('.cache/deno')], description: 'Deno dependency cache.' },

  // ---- System ----
  { id: 'user-cache',  name: 'User cache',  category: 'System', icon: 'database', safe: true, reversible: true, mode: 'contents', paths: [h('.cache')], description: 'Generic per-user cache in ~/.cache. Apps rebuild them.' },
  { id: 'trash',       name: 'Trash',       category: 'System', icon: 'trash',    safe: true, reversible: true, mode: 'contents', paths: [h('.local/share/Trash/files'), h('.local/share/Trash/info')], description: 'Files in the Trash.' },
  { id: 'thumbnails',  name: 'Thumbnails',  category: 'System', icon: 'image',   safe: true, reversible: true, mode: 'contents', paths: [h('.cache/thumbnails')], description: 'Cached image thumbnails. Regenerated on demand.' },

  // ---- Browsers ----
  { id: 'chrome-cache',   name: 'Chrome cache',   category: 'Browsers', icon: 'chrome', safe: true, reversible: true, mode: 'contents', paths: [h('.cache/google-chrome')], description: 'Chrome on-disk cache.' },
  { id: 'chromium-cache', name: 'Chromium cache', category: 'Browsers', icon: 'browser', safe: true, reversible: true, mode: 'contents', paths: [h('.cache/chromium')], description: 'Chromium on-disk cache.' },
];

/** Build the Windows catalog, skipping any path whose base env var is undefined. */
function buildWin32Targets() {
  const LOCALAPPDATA = process.env.LOCALAPPDATA;
  const APPDATA = process.env.APPDATA;
  const TEMP = process.env.TEMP;
  const USERPROFILE = HOME;

  // p(base, ...segments) returns an absolute path, or null when base is undefined.
  const p = (base, ...segments) => (base ? path.join(base, ...segments) : null);

  const targets = [
    // ---- Developer caches ----
    { id: 'npm',    name: 'npm cache',          category: 'Developer', icon: 'node',   safe: true, reversible: true, mode: 'contents', paths: [p(LOCALAPPDATA, 'npm-cache')], description: 'Downloaded npm package tarballs. Rebuilds on next install.' },
    { id: 'yarn',   name: 'Yarn cache',         category: 'Developer', icon: 'node',   safe: true, reversible: true, mode: 'contents', paths: [p(LOCALAPPDATA, 'Yarn', 'Cache')], description: 'Yarn package cache.' },
    { id: 'gradle', name: 'Gradle cache',       category: 'Developer', icon: 'gradle', safe: true, reversible: true, mode: 'contents', paths: [p(USERPROFILE, '.gradle', 'caches')], description: 'Global Gradle build cache & downloaded deps.' },
    { id: 'maven',  name: 'Maven repository',   category: 'Developer', icon: 'java',   safe: true, reversible: true, mode: 'contents', paths: [p(USERPROFILE, '.m2', 'repository')], description: 'Downloaded Maven artifacts. Re-downloads on build.' },
    { id: 'cargo',  name: 'Cargo registry',     category: 'Developer', icon: 'rust',   safe: true, reversible: true, mode: 'contents', paths: [p(USERPROFILE, '.cargo', 'registry', 'cache'), p(USERPROFILE, '.cargo', 'registry', 'src')], description: 'Rust crate cache.' },
    { id: 'pip',    name: 'pip cache',          category: 'Developer', icon: 'python', safe: true, reversible: true, mode: 'contents', paths: [p(LOCALAPPDATA, 'pip', 'Cache')], description: 'Python pip download cache.' },
    { id: 'go',     name: 'Go build/mod cache', category: 'Developer', icon: 'go',     safe: true, reversible: true, mode: 'contents', paths: [p(LOCALAPPDATA, 'go-build'), p(USERPROFILE, 'go', 'pkg', 'mod', 'cache')], description: 'Go build & module cache.' },
    { id: 'nuget',  name: 'NuGet packages',     category: 'Developer', icon: 'box',    safe: true, reversible: true, mode: 'contents', paths: [p(USERPROFILE, '.nuget', 'packages')], description: 'Downloaded NuGet packages. Re-downloads on restore.' },
    { id: 'bun',    name: 'Bun cache',          category: 'Developer', icon: 'flash',  safe: true, reversible: true, mode: 'contents', paths: [p(USERPROFILE, '.bun', 'install', 'cache')], description: 'Bun install cache.' },

    // ---- System ----
    { id: 'local-temp',   name: 'User temp files',    category: 'System', icon: 'trash', safe: true, reversible: true, mode: 'contents', paths: [p(LOCALAPPDATA, 'Temp')], description: 'Per-user temporary files.' },
    { id: 'windows-temp', name: 'Windows temp files', category: 'System', icon: 'trash', safe: true, reversible: true, mode: 'contents', paths: [p(TEMP)], description: 'Temporary files from %TEMP%.' },

    // ---- Browsers ----
    { id: 'chrome-cache', name: 'Chrome cache', category: 'Browsers', icon: 'chrome', safe: true, reversible: true, mode: 'contents', paths: [p(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Cache')], description: 'Chrome on-disk cache.' },
    { id: 'edge-cache',   name: 'Edge cache',   category: 'Browsers', icon: 'edge', safe: true, reversible: true, mode: 'contents', paths: [p(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache')], description: 'Microsoft Edge on-disk cache.' },
  ];

  // Drop any null paths (undefined base env var), then drop targets left empty.
  return targets
    .map((t) => ({ ...t, paths: t.paths.filter(Boolean) }))
    .filter((t) => t.paths.length > 0);
}

function buildTargets() {
  switch (process.platform) {
    case 'darwin':
      return darwinTargets;
    case 'linux':
      return linuxTargets;
    case 'win32':
      return buildWin32Targets();
    default:
      return [];
  }
}

const TARGETS = buildTargets();

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Bounded recursive Node walk that sums file sizes in bytes. Skips symlinks,
 * swallows per-entry errors, and stops early once the time budget is spent so
 * it returns within ~30s. The result may be approximate when capped.
 */
async function walkSize(root, deadline = Date.now() + 30000) {
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
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(full);
          total += stat.size;
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  return total;
}

/** Measure a path's size with `du -sk` (fast, kilobytes). Falls back to a walk. */
function duSizeUnix(p) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', p], { timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(walkSize(p));
      const kb = parseInt((stdout.split('\t')[0] || '0').trim(), 10);
      resolve(Number.isFinite(kb) ? kb * 1024 : 0);
    });
  });
}

/** Measure a path's size in bytes. Missing path returns 0. */
async function duSize(p) {
  if (!fs.existsSync(p)) return 0;
  if (process.platform === 'win32') return walkSize(p);
  return duSizeUnix(p);
}

async function targetSize(target) {
  let total = 0;
  for (const p of target.paths) total += await duSize(p);
  return total;
}

/** Scan all targets, streaming progress. */
async function scanSystem(onProgress, signal) {
  const results = [];
  for (let i = 0; i < TARGETS.length; i++) {
    if (signal?.aborted) break;
    const t = TARGETS[i];
    onProgress?.({ phase: 'scanning', index: i, total: TARGETS.length, current: t.name });
    const size = await targetSize(t);
    const existing = t.paths.filter((p) => fs.existsSync(p));
    results.push({ ...t, size, existingPaths: existing });
  }
  onProgress?.({ phase: 'done' });
  return results.filter((r) => r.existingPaths.length > 0);
}

module.exports = { TARGETS, scanSystem, targetSize, duSize };
