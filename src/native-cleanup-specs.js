'use strict';
/**
 * Native cleanup: which cache targets are cleaned by their own tool's command
 * instead of Spaci deleting the folder, and exactly which command.
 *
 * This file is the allowlist. A command runs only when the target id names a
 * spec here, and its program and arguments come from here, never from the
 * renderer. Every argument is a constant that passes SAFE_ARG, and no spec may
 * carry a flag that bypasses a tool's lock (FORBIDDEN_ARGS): a busy tool is
 * refused, never forced.
 *
 * Sources for every choice: docs/native-cleanup-sources.md.
 *
 * Pure data and pure helpers. src/native-cleanup.js runs them (in the scan
 * worker); storage-classifier attaches describe() to each target for the row.
 */

const MIN = 60 * 1000;

// Arguments are plain words and flags, nothing a shell could read as syntax.
const SAFE_ARG = /^(?:--?)?[A-Za-z0-9][A-Za-z0-9._=-]*$/;
// Flags that make a tool skip its own lock or confirmation of an in-use cache.
// uv documents --force as "ignore the lock"; npm's cache clean needs --force,
// which is one reason npm keeps the folder delete (see the sources file).
const FORBIDDEN_ARGS = new Set(['--force', '-f', '--no-lock', '--ignore-lock']);

/**
 * Process matching, per tool. A process makes the tool busy when its command
 * (the executable, or the script a node/python/ruby/bash host runs) is one of
 * `names` and, when `subcommands` is given, its first non-flag argument is one
 * of them (or there is none and `bare` is true). Long-running script runners
 * such as `pnpm dev` or `npm run build` do not touch the package cache and do
 * not count. `uv` counts whatever it runs: `uv run` holds the cache lock.
 */
// `go run` is left out: it compiles first and then only runs the program, so a
// long-lived `go run ./cmd/server` would otherwise block the clean forever.
const GO_CACHE_USERS = ['build', 'test', 'install', 'get', 'mod', 'generate', 'vet', 'list', 'clean', 'work', 'tool'];
const NODE_INSTALLS = ['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'fetch', 'import', 'store', 'dlx', 'rebuild', 'rb', 'prune', 'dedupe', 'deploy', 'create', 'cache', 'exec', 'x', 'link', 'global', 'autoclean', 'self-update'];

/**
 * Each spec:
 *   tool        display name in messages ("uv is busy ...")
 *   bins        executable names, tried in order
 *   via         'native' runs `run`; 'stop-then-folder' runs `run` and then
 *               empties the folder; 'folder' only empties the folder (the tool
 *               has nothing better), after the same busy check
 *   run         argv after the program, for a manual clean
 *   autoRun     argv for auto-clean (gentler where the tool offers it); absent
 *               means auto-clean never runs this tool
 *   locate      argv that prints the cache directory (read-only), or null
 *   preview     how the row's estimate is made: 'size' (all of it goes),
 *               'pnpm-unreferenced', 'brew-dry-run'
 *   busy        { names, subcommands?, bare?, argsRe? } process match
 *   lockFiles   names inside the located dir that a running tool holds open
 *   lockOutput  output that means "waiting for another process": stop at once
 *   timeoutMs   for the run; locate and preview get PREVIEW_TIMEOUT_MS
 *   duration    how long it can take, for the docs and the row
 *   fallback    'folder' when the CLI is missing and deleting the folder is
 *               safe once the busy check passed; 'none' otherwise
 *   restoreHint History line
 */
const SPECS = Object.freeze({
  pnpm: {
    tool: 'pnpm',
    bins: ['pnpm'],
    via: 'native',
    run: ['store', 'prune'],
    autoRun: ['store', 'prune'],
    locate: ['store', 'path'],
    preview: 'pnpm-unreferenced',
    busy: { names: ['pnpm', 'pnpx'], subcommands: NODE_INSTALLS, bare: true },
    lockFiles: ['index.db'],
    lockOutput: null,
    timeoutMs: 15 * MIN,
    duration: 'Seconds to a few minutes on a large store.',
    fallback: 'folder',
    why: 'Removes only packages no project uses. Packages your projects use are hard links, so deleting the folder frees little and forces downloads.',
    restoreHint: 'Nothing a project uses was removed. A pruned package downloads again if a project needs it later.',
  },
  'uv-cache': {
    tool: 'uv',
    bins: ['uv'],
    via: 'native',
    run: ['cache', 'clean'],
    autoRun: ['cache', 'prune'],
    locate: ['cache', 'dir'],
    preview: 'size',
    busy: { names: ['uv', 'uvx'] },
    lockFiles: ['.lock'],
    // uv waits up to 5 minutes for other uv processes; Spaci stops instead.
    lockOutput: /currently in-use|waiting for other uv processes|waiting to acquire lock/i,
    timeoutMs: 10 * MIN,
    duration: 'Seconds; minutes for a cache of many GB.',
    fallback: 'folder',
    why: 'uv takes its cache lock first, so a running uv never sees its cache vanish. Spaci never passes --force.',
    restoreHint: 'Refills on the next uv sync or uv pip install.',
  },
  go: {
    tool: 'Go',
    bins: ['go'],
    via: 'native',
    run: ['clean', '-cache'],
    autoRun: ['clean', '-cache'],
    locate: ['env', 'GOCACHE'],
    preview: 'size',
    busy: { names: ['go'], subcommands: GO_CACHE_USERS },
    lockFiles: null,
    lockOutput: null,
    timeoutMs: 10 * MIN,
    duration: 'Seconds; up to a minute for a large build cache.',
    fallback: 'folder',
    why: 'Removes the build cache where Go keeps it (GOCACHE), whatever it is set to.',
    restoreHint: 'Rebuilds on the next go build or go test.',
  },
  'go-modcache': {
    tool: 'Go',
    bins: ['go'],
    via: 'native',
    run: ['clean', '-modcache'],
    autoRun: null,
    locate: ['env', 'GOMODCACHE'],
    preview: 'size',
    busy: { names: ['go'], subcommands: GO_CACHE_USERS },
    lockFiles: null,
    lockOutput: null,
    timeoutMs: 15 * MIN,
    duration: 'Up to a few minutes: every module file is read-only and removed one by one.',
    fallback: 'folder',
    why: 'Go makes module files read-only; go clean -modcache removes them the supported way.',
    restoreHint: 'go mod download, or the next go build, fetches the modules again.',
  },
  gradle: {
    tool: 'Gradle',
    bins: ['gradle'],
    via: 'stop-then-folder',
    run: ['--stop'],
    autoRun: null,
    locate: null,
    preview: 'size',
    // Clients (a build or the wrapper) make Gradle busy. Daemons are stopped
    // first; any left (another Gradle version) make it busy too.
    busy: { names: ['gradle', 'gradlew'], argsRe: /org\.gradle\.(?:launcher\.GradleMain|wrapper\.GradleWrapperMain)\b/ },
    daemonRe: /org\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon\b/,
    lockFiles: null,
    lockOutput: /timeout waiting to lock/i,
    timeoutMs: 2 * MIN,
    duration: 'A few seconds to stop daemons, then the folder delete.',
    fallback: 'folder',
    why: 'Gradle has no command that empties its caches. Stopping its daemons first keeps a running daemon from writing into a half-deleted cache.',
    restoreHint: 'Re-downloads on the next Gradle build.',
  },
  pip: {
    tool: 'pip',
    bins: ['pip3', 'pip'],
    display: 'pip',
    via: 'native',
    run: ['cache', 'purge'],
    autoRun: ['cache', 'purge'],
    locate: ['cache', 'dir'],
    preview: 'size',
    busy: { names: ['pip', 'pip3'], subcommands: ['install', 'download', 'wheel', 'cache'] },
    lockFiles: null,
    lockOutput: null,
    timeoutMs: 5 * MIN,
    duration: 'Seconds.',
    fallback: 'folder',
    why: 'Purges the cache pip actually uses (pip cache dir), wheels and HTTP responses.',
    restoreHint: 'Re-downloads on the next pip install.',
  },
  yarn: {
    tool: 'Yarn',
    bins: ['yarn'],
    via: 'native',
    run: ['cache', 'clean'],
    autoRun: ['cache', 'clean'],
    // Yarn 2+ (berry) cleans only from inside a project, so it is never run:
    // the global mirror is emptied as a folder instead (see variant()).
    versionArgs: ['--version'],
    locate: ['cache', 'dir'],
    preview: 'size',
    busy: { names: ['yarn', 'yarnpkg'], subcommands: NODE_INSTALLS, bare: true },
    lockFiles: null,
    lockOutput: null,
    timeoutMs: 10 * MIN,
    duration: 'Seconds to a minute.',
    fallback: 'folder',
    why: 'Yarn 1 cleans its own cache folder, wherever yarn cache dir points.',
    restoreHint: 'Re-downloads on the next yarn install.',
  },
  cocoapods: {
    tool: 'CocoaPods',
    bins: ['pod'],
    via: 'native',
    run: ['cache', 'clean', '--all'],
    autoRun: ['cache', 'clean', '--all'],
    locate: null,
    preview: 'size',
    busy: { names: ['pod'] },
    lockFiles: null,
    lockOutput: null,
    timeoutMs: 5 * MIN,
    duration: 'Seconds.',
    fallback: 'folder',
    why: 'CocoaPods removes every cached pod and spec itself, without asking per pod.',
    restoreHint: 'Re-downloads on the next pod install.',
  },
  'homebrew-cache': {
    tool: 'Homebrew',
    bins: ['brew'],
    via: 'native',
    run: ['cleanup', '--prune=all'],
    // brew cleanup also removes old formula versions, which is more than a
    // cache: auto-clean leaves it to the user.
    autoRun: null,
    locate: ['--cache'],
    preview: 'brew-dry-run',
    previewArgs: ['cleanup', '--prune=all', '--dry-run'],
    env: { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_ANALYTICS: '1' },
    busy: { names: ['brew'] },
    lockFiles: null,
    lockOutput: /has already locked|another active homebrew/i,
    // Old versions are removed from the Cellar and Caskroom too: measured.
    measureFromBin: ['Cellar', 'Caskroom'],
    timeoutMs: 15 * MIN,
    duration: 'Under a minute usually; several minutes with many old versions.',
    fallback: 'folder',
    why: 'Removes every download and old formula and cask version Homebrew no longer needs. It keeps pinned and linked versions.',
    restoreHint: 'Downloaded again the next time Homebrew installs or upgrades.',
  },
  // No better command than the folder delete. Listed so the busy check and the
  // before/after measurement still apply.
  npm: {
    tool: 'npm',
    bins: [],
    via: 'folder',
    folderLabel: 'the same result as npm cache clean, without --force',
    run: null,
    autoRun: null,
    locate: null,
    preview: 'size',
    busy: { names: ['npm', 'npx'], subcommands: NODE_INSTALLS, bare: true },
    lockFiles: null,
    lockOutput: null,
    timeoutMs: 0,
    duration: 'The folder delete only.',
    fallback: 'folder',
    why: 'npm cache clean deletes this same folder, and only with --force. Spaci empties the folder itself and never passes --force.',
    restoreHint: 'Re-downloads on the next npm install.',
  },
  cargo: {
    tool: 'Cargo',
    bins: [],
    via: 'folder',
    folderLabel: 'Cargo has no stable cleanup command',
    run: null,
    autoRun: null,
    locate: null,
    preview: 'size',
    busy: { names: ['cargo'] },
    lockFiles: null,
    lockOutput: null,
    timeoutMs: 0,
    duration: 'The folder delete only.',
    fallback: 'folder',
    why: 'Cargo has no stable command to clear its registry cache (cargo clean gc is unstable). Cargo restores deleted archives and sources itself.',
    restoreHint: 'Re-downloads on the next cargo build.',
  },
});

const PREVIEW_TIMEOUT_MS = 30 * 1000;

function specFor(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPECS, id) ? SPECS[id] : null;
}

/** The argv a spec runs for a mode ('manual' | 'auto'), or null. */
function argsFor(spec, mode = 'manual') {
  if (!spec) return null;
  const a = mode === 'auto' ? spec.autoRun : spec.run;
  return Array.isArray(a) ? a.slice() : null;
}

/** Throws unless every argument is a safe constant and none bypasses a lock. */
function validateArgs(args) {
  if (!Array.isArray(args)) throw new Error('Arguments must be a list.');
  for (const a of args) {
    if (typeof a !== 'string' || !SAFE_ARG.test(a)) throw new Error('Unsafe argument: ' + String(a));
    if (FORBIDDEN_ARGS.has(a.split('=')[0])) throw new Error('Spaci never passes ' + a + '.');
  }
  return args;
}

/** "pnpm store prune": the command as the row and History show it. */
function commandLine(spec, mode = 'manual', bin = null) {
  const args = argsFor(spec, mode);
  if (!args) return null;
  return [bin || spec.display || spec.bins[0], ...args].join(' ');
}

/**
 * What a row says about how it is cleaned, without running anything.
 * { via, tool, command|null, label, why, duration, auto }
 */
function describe(id) {
  const spec = specFor(id);
  if (!spec) return null;
  const command = spec.via === 'folder' ? null : commandLine(spec);
  const label = spec.via === 'native' ? 'Runs `' + command + '`'
    : spec.via === 'stop-then-folder' ? 'Runs `' + command + '`, then empties the folder'
      : 'Empties the folder: ' + spec.folderLabel;
  return {
    via: spec.via, tool: spec.tool, command, label, why: spec.why, duration: spec.duration,
    auto: Array.isArray(spec.autoRun) ? commandLine(spec, 'auto') : null,
  };
}

// Every spec must pass its own rules, checked once at load.
for (const [id, spec] of Object.entries(SPECS)) {
  for (const a of [spec.run, spec.autoRun, spec.locate, spec.previewArgs, spec.versionArgs]) if (a) validateArgs(a);
  if (spec.via !== 'folder' && (!spec.bins.length || !spec.run)) throw new Error('Native cleanup spec ' + id + ' has no command.');
}

module.exports = { SPECS, MIN, PREVIEW_TIMEOUT_MS, SAFE_ARG, FORBIDDEN_ARGS, NODE_INSTALLS, specFor, argsFor, validateArgs, commandLine, describe };
