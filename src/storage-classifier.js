'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildBrowserTargets } = require('./browsers');
const { buildAiToolTargets } = require('./aitools');

const CATEGORY_META = {
  developer: { label: 'Developer', icon: 'code', hint: 'Code, build caches and SDKs' },
  aitools: { label: 'AI tools', icon: 'flash', hint: 'Session history, logs and caches from AI coding tools' },
  applications: { label: 'Applications', icon: 'grid', hint: 'Installed apps' },
  appdata: { label: 'App Data', icon: 'database', hint: 'Per-app data and containers' },
  caches: { label: 'Caches', icon: 'broom', hint: 'Regenerable cache and log files' },
  browsers: { label: 'Browsers', icon: 'browser', hint: 'Browser caches and profile storage' },
  media: { label: 'Media', icon: 'image', hint: 'Photos, video and music' },
  documents: { label: 'Documents', icon: 'document-text', hint: 'Files on your Desktop and in Documents' },
  downloads: { label: 'Downloads', icon: 'download', hint: 'Your Downloads folder' },
  mail: { label: 'Mail & Messages', icon: 'bell', hint: 'Mail and Messages storage' },
  xcode: { label: 'Xcode', icon: 'apple', hint: 'Apple developer caches and build artifacts' },
  system: { label: 'System', icon: 'cpu', hint: 'OS files, snapshots and unclassified storage' },
};

function uniq(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

function makeTarget(id, name, category, icon, paths, description, options = {}) {
  const target = {
    id,
    name,
    category,
    icon,
    safe: options.safe !== false,
    reversible: options.reversible !== false,
    mode: 'contents',
    paths: uniq(paths),
    description,
    storyCategory: options.storyCategory || category.toLowerCase(),
  };
  // Basenames the cleaner must never delete at any depth inside this target.
  // Used when a generic cache folder holds a nested folder that is expensive
  // to rebuild or is offered separately with its own safety rating.
  if (Array.isArray(options.protect) && options.protect.length > 0) target.protect = uniq(options.protect);
  // What the History screen tells the user about getting this back, when the
  // generic "regenerates when the owning app runs" would overstate it.
  if (options.restoreHint) target.restoreHint = options.restoreHint;
  return target;
}

// Go keeps its module cache at GOMODCACHE, else the first GOPATH entry's
// pkg/mod, else ~/go/pkg/mod. Removing the whole tree is what
// `go clean -modcache` does, so it is safe; the files are read-only on disk,
// which the cleaner handles.
function goModCache(ctx, fallback) {
  const { env, pathApi } = ctx;
  if (env.GOMODCACHE) return env.GOMODCACHE;
  const sep = ctx.platform === 'win32' ? ';' : ':';
  const gopath = String(env.GOPATH || '').split(sep).find(Boolean);
  if (gopath) return pathApi.join(gopath, 'pkg', 'mod');
  return fallback;
}

// Hugging Face stores downloaded models and datasets at HF_HOME, else
// ~/.cache/huggingface. Regenerable, but a re-download can be many GB.
function huggingFaceHome(ctx, fallback) {
  return ctx.env.HF_HOME || fallback;
}

const HF_DESCRIPTION = 'Downloaded AI models and datasets. Safe to remove, but re-downloading large models can take a long time.';

// Linux cache root: XDG_CACHE_HOME when it is an absolute path (relative
// values are invalid per the XDG spec and ignored), else ~/.cache.
function xdgCache(ctx, ...parts) {
  const env = ctx.env.XDG_CACHE_HOME;
  const base = env && ctx.pathApi.isAbsolute(env) ? env : ctx.join('.cache');
  return ctx.pathApi.join(base, ...parts);
}

// ~/.cache is not only cache: model stores and tool installs live there too,
// and several cannot be fetched again (sideloaded LM Studio models). So the
// generic wipe is opt-in and always spares these, whatever else is selected.
const CLI_CACHE_PROTECT = ['huggingface', 'lm-studio', 'whisper', 'torch', 'ms-playwright', 'ollama', 'llama.cpp', 'gpt4all'];
// Emptying the Trash is permanent: it is never preselected and always confirmed.
const TRASH_DESCRIPTION = 'Files you moved to the Trash. Emptying it deletes them permanently.';

const CLI_CACHE_DESCRIPTION = 'Caches command-line tools keep in ~/.cache, after known developer caches are counted separately. Some tools store downloads here that take time to fetch again, so review before cleaning. Model stores are always kept.';

function platformContext(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  // Tests can build Windows fixtures on macOS/Linux; pick the target platform's
  // path module so mocked paths use the same separators as runtime.
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const join = (...parts) => pathApi.join(home, ...parts);
  const winProfile = env.USERPROFILE || home;
  const winJoin = (...parts) => pathApi.join(winProfile, ...parts);
  const from = (base, ...parts) => (base ? pathApi.join(base, ...parts) : null);
  return { platform, home, env, pathApi, join, winProfile, winJoin, from };
}

function buildDeveloperTargets(ctx) {
  const { platform, env, join, winJoin, from } = ctx;
  if (platform === 'darwin') {
    const lib = (...p) => join('Library', ...p);
    return [
      makeTarget('npm', 'npm cache', 'Developer', 'node', [join('.npm', '_cacache')], 'Downloaded npm package tarballs. Rebuilds on next install.'),
      makeTarget('yarn', 'Yarn cache', 'Developer', 'node', [lib('Caches', 'Yarn'), join('.yarn', 'cache')], 'Yarn package cache.'),
      makeTarget('pnpm', 'pnpm store', 'Developer', 'node', [lib('pnpm', 'store'), join('.pnpm-store')], 'pnpm content-addressable store. Packages your projects still use are hard-linked into them, so those free space only once no project uses them.'),
      makeTarget('bun', 'Bun cache', 'Developer', 'flash', [join('.bun', 'install', 'cache')], 'Bun install cache.'),
      makeTarget('gradle', 'Gradle cache', 'Developer', 'gradle', [join('.gradle', 'caches')], 'Global Gradle build cache & downloaded deps.'),
      makeTarget('gradle-wrapper', 'Gradle wrapper downloads', 'Developer', 'gradle', [join('.gradle', 'wrapper', 'dists')], 'Gradle distributions fetched by project wrappers. Re-downloads on the next build.'),
      makeTarget('maven', 'Maven repository', 'Developer', 'java', [join('.m2', 'repository')], 'Downloaded Maven artifacts. Re-downloads on build.'),
      makeTarget('nuget', 'NuGet packages', 'Developer', 'box', [join('.nuget', 'packages')], 'Downloaded NuGet packages. Re-downloads on restore.'),
      makeTarget('cargo', 'Cargo registry', 'Developer', 'rust', [join('.cargo', 'registry', 'cache'), join('.cargo', 'registry', 'src')], 'Rust crate cache.'),
      makeTarget('cocoapods', 'CocoaPods cache', 'Developer', 'apple', [lib('Caches', 'CocoaPods')], 'CocoaPods spec & pod cache.'),
      makeTarget('pub', 'Dart/Flutter pub', 'Developer', 'flutter', [join('.pub-cache', 'hosted')], 'Dart/Flutter downloaded packages.'),
      makeTarget('dart-server', 'Dart analysis server', 'Developer', 'flutter', [join('.dartServer')], 'Dart and Flutter analysis cache. Rebuilds the next time your editor analyses code.'),
      makeTarget('pip', 'pip cache', 'Developer', 'python', [lib('Caches', 'pip')], 'Python pip download cache.'),
      makeTarget('go', 'Go build/mod cache', 'Developer', 'go', [lib('Caches', 'go-build'), goModCache(ctx, join('go', 'pkg', 'mod'))], 'Go build cache and downloaded modules. Re-downloads on the next build.'),
      makeTarget('deno', 'Deno cache', 'Developer', 'flash', [lib('Caches', 'deno')], 'Deno dependency cache.'),
      makeTarget('huggingface', 'Hugging Face models', 'Developer', 'cpu', [huggingFaceHome(ctx, join('.cache', 'huggingface'))], HF_DESCRIPTION, { safe: false }),
    ];
  }

  if (platform === 'linux') {
    return [
      makeTarget('npm', 'npm cache', 'Developer', 'node', [join('.npm', '_cacache')], 'Downloaded npm package tarballs. Rebuilds on next install.'),
      makeTarget('yarn', 'Yarn cache', 'Developer', 'node', [xdgCache(ctx, 'yarn')], 'Yarn package cache.'),
      makeTarget('pnpm', 'pnpm store', 'Developer', 'node', [join('.local', 'share', 'pnpm', 'store')], 'pnpm content-addressable store. Packages your projects still use are hard-linked into them, so those free space only once no project uses them.'),
      makeTarget('gradle', 'Gradle cache', 'Developer', 'gradle', [join('.gradle', 'caches')], 'Global Gradle build cache & downloaded deps.'),
      makeTarget('gradle-wrapper', 'Gradle wrapper downloads', 'Developer', 'gradle', [join('.gradle', 'wrapper', 'dists')], 'Gradle distributions fetched by project wrappers. Re-downloads on the next build.'),
      makeTarget('maven', 'Maven repository', 'Developer', 'java', [join('.m2', 'repository')], 'Downloaded Maven artifacts. Re-downloads on build.'),
      makeTarget('nuget', 'NuGet packages', 'Developer', 'box', [join('.nuget', 'packages')], 'Downloaded NuGet packages. Re-downloads on restore.'),
      makeTarget('cargo', 'Cargo registry', 'Developer', 'rust', [join('.cargo', 'registry', 'cache'), join('.cargo', 'registry', 'src')], 'Rust crate cache.'),
      makeTarget('pip', 'pip cache', 'Developer', 'python', [xdgCache(ctx, 'pip')], 'Python pip download cache.'),
      makeTarget('go', 'Go build/mod cache', 'Developer', 'go', [xdgCache(ctx, 'go-build'), goModCache(ctx, join('go', 'pkg', 'mod'))], 'Go build cache and downloaded modules. Re-downloads on the next build.'),
      makeTarget('pub', 'Dart/Flutter pub', 'Developer', 'flutter', [join('.pub-cache', 'hosted')], 'Dart/Flutter downloaded packages.'),
      makeTarget('dart-server', 'Dart analysis server', 'Developer', 'flutter', [join('.dartServer')], 'Dart and Flutter analysis cache. Rebuilds the next time your editor analyses code.'),
      makeTarget('bun', 'Bun cache', 'Developer', 'flash', [join('.bun', 'install', 'cache')], 'Bun install cache.'),
      makeTarget('deno', 'Deno cache', 'Developer', 'flash', [xdgCache(ctx, 'deno')], 'Deno dependency cache.'),
      makeTarget('huggingface', 'Hugging Face models', 'Developer', 'cpu', [huggingFaceHome(ctx, xdgCache(ctx, 'huggingface'))], HF_DESCRIPTION, { safe: false }),
    ];
  }

  const local = env.LOCALAPPDATA;
  return [
    makeTarget('npm', 'npm cache', 'Developer', 'node', [from(local, 'npm-cache')], 'Downloaded npm package tarballs. Rebuilds on next install.'),
    makeTarget('yarn', 'Yarn cache', 'Developer', 'node', [from(local, 'Yarn', 'Cache')], 'Yarn package cache.'),
    makeTarget('pnpm', 'pnpm store', 'Developer', 'node', [from(local, 'pnpm', 'store')], 'pnpm content-addressable store. Packages your projects still use are hard-linked into them, so those free space only once no project uses them.'),
    makeTarget('gradle', 'Gradle cache', 'Developer', 'gradle', [winJoin('.gradle', 'caches')], 'Global Gradle build cache & downloaded deps.'),
    makeTarget('gradle-wrapper', 'Gradle wrapper downloads', 'Developer', 'gradle', [winJoin('.gradle', 'wrapper', 'dists')], 'Gradle distributions fetched by project wrappers. Re-downloads on the next build.'),
    makeTarget('maven', 'Maven repository', 'Developer', 'java', [winJoin('.m2', 'repository')], 'Downloaded Maven artifacts. Re-downloads on build.'),
    makeTarget('cargo', 'Cargo registry', 'Developer', 'rust', [winJoin('.cargo', 'registry', 'cache'), winJoin('.cargo', 'registry', 'src')], 'Rust crate cache.'),
    makeTarget('pip', 'pip cache', 'Developer', 'python', [from(local, 'pip', 'Cache')], 'Python pip download cache.'),
    makeTarget('go', 'Go build/mod cache', 'Developer', 'go', [from(local, 'go-build'), goModCache(ctx, winJoin('go', 'pkg', 'mod'))], 'Go build cache and downloaded modules. Re-downloads on the next build.'),
    makeTarget('nuget', 'NuGet packages', 'Developer', 'box', [winJoin('.nuget', 'packages')], 'Downloaded NuGet packages. Re-downloads on restore.'),
    makeTarget('dart-server', 'Dart analysis server', 'Developer', 'flutter', [from(local, '.dartServer')], 'Dart and Flutter analysis cache. Rebuilds the next time your editor analyses code.'),
    makeTarget('bun', 'Bun cache', 'Developer', 'flash', [winJoin('.bun', 'install', 'cache')], 'Bun install cache.'),
    makeTarget('huggingface', 'Hugging Face models', 'Developer', 'cpu', [huggingFaceHome(ctx, winJoin('.cache', 'huggingface'))], HF_DESCRIPTION, { safe: false }),
  ];
}


// ---- ai models and dev tools ----
// Download caches the developer tool sweep found missing (docs/devtools-sources.md).
// Each honours its tool's own override, and only an absolute one.
function absOr(ctx, name, fallback) {
  const v = ctx.env[name];
  return v && ctx.pathApi.isAbsolute(v) ? v : fallback;
}

function toolCacheTargets(ctx) {
  const { platform, env, join, winJoin, from } = ctx;
  const local = env.LOCALAPPDATA;
  const cacheRoot = platform === 'darwin' ? join('Library', 'Caches') : platform === 'win32' ? local : xdgCache(ctx);
  const at = (...p) => from(cacheRoot, ...p);
  const home = platform === 'win32' ? winJoin : join;
  const pw = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? absOr(ctx, 'PLAYWRIGHT_BROWSERS_PATH', null) : null;
  const t = [
    makeTarget('playwright', 'Playwright browsers', 'Developer', 'browser', [pw || at('ms-playwright')], 'Browsers Playwright downloaded for tests. npx playwright install fetches them again, a few hundred MB each.', { safe: false, restoreHint: 'npx playwright install' }),
    makeTarget('puppeteer', 'Puppeteer browsers', 'Developer', 'browser', [absOr(ctx, 'PUPPETEER_CACHE_DIR', home('.cache', 'puppeteer'))], 'Chrome builds Puppeteer downloaded. Fetched again on the next install.', { safe: false, restoreHint: 'npx puppeteer browsers install chrome' }),
    makeTarget('cypress', 'Cypress binaries', 'Developer', 'play', [absOr(ctx, 'CYPRESS_CACHE_FOLDER', platform === 'win32' ? at('Cypress', 'Cache') : at('Cypress'))], 'Cypress app binaries, one per version. npx cypress install fetches the one a project needs.', { safe: false, restoreHint: 'npx cypress install' }),
    makeTarget('electron-downloads', 'Electron downloads', 'Developer', 'download', [absOr(ctx, 'electron_config_cache', platform === 'win32' ? at('electron', 'Cache') : at('electron'))], 'Electron release zips cached by npm installs. Downloaded again when a project needs that version.', { restoreHint: 'Downloaded again on the next npm install of that Electron version.' }),
    makeTarget('uv-cache', 'uv cache', 'Developer', 'python', [absOr(ctx, 'UV_CACHE_DIR', platform === 'win32' ? at('uv', 'cache') : (platform === 'darwin' ? join('.cache', 'uv') : xdgCache(ctx, 'uv')))], 'uv package and build cache. The same as uv cache clean; refills on the next install.', { restoreHint: 'Refills on the next uv sync or uv pip install.' }),
  ];
  if (platform !== 'win32') {
    t.push(makeTarget('homebrew-cache', 'Homebrew downloads', 'Developer', 'download', [absOr(ctx, 'HOMEBREW_CACHE', at('Homebrew'))], 'Bottles and source downloads Homebrew keeps after installing. brew cleanup removes old ones itself.', { restoreHint: 'Downloaded again the next time Homebrew installs or upgrades.' }));
  }
  return t.filter((x) => x.paths.length > 0);
}

/**
 * Where local AI models and developer tools keep data, so the storage
 * breakdown counts them as Developer instead of unclaimed home folders.
 */
function devToolDirs(ctx) {
  const { platform, env, join, winJoin, from } = ctx;
  const home = platform === 'win32' ? winJoin : join;
  const dirs = [
    absOr(ctx, 'OLLAMA_MODELS', home('.ollama', 'models')),
    home('.lmstudio', 'models'),
    absOr(ctx, 'ANDROID_HOME', absOr(ctx, 'ANDROID_SDK_ROOT', platform === 'darwin' ? join('Library', 'Android', 'sdk') : platform === 'win32' ? from(env.LOCALAPPDATA, 'Android', 'Sdk') : join('Android', 'Sdk'))),
    absOr(ctx, 'ANDROID_AVD_HOME', home('.android', 'avd')),
    absOr(ctx, 'NVM_DIR', platform === 'win32' ? null : join('.nvm')),
    absOr(ctx, 'PYENV_ROOT', home('.pyenv')),
    absOr(ctx, 'VOLTA_HOME', platform === 'win32' ? from(env.LOCALAPPDATA, 'Volta') : join('.volta')),
    absOr(ctx, 'RUSTUP_HOME', home('.rustup')),
    platform === 'darwin' ? join('Library', 'Application Support', 'fnm') : null,
  ];
  return uniq(dirs);
}
// ---- end ai models and dev tools ----

function buildSystemTargets(options = {}) {
  const ctx = platformContext(options);
  const { platform, env, join, from } = ctx;
  const targets = buildDeveloperTargets(ctx).concat(toolCacheTargets(ctx));

  if (platform === 'darwin') {
    const lib = (...p) => join('Library', ...p);
    targets.push(
      makeTarget('xcode-derived', 'Xcode DerivedData', 'Xcode', 'apple', [lib('Developer', 'Xcode', 'DerivedData')], 'Xcode build intermediates. Safe to wipe, it rebuilds.', { storyCategory: 'xcode' }),
      makeTarget('xcode-archives', 'Xcode Archives', 'Xcode', 'box', [lib('Developer', 'Xcode', 'Archives')], 'App archives for distribution. Delete only if already uploaded.', { safe: false, reversible: false, storyCategory: 'xcode' }),
      makeTarget('xcode-devicesupport', 'iOS DeviceSupport', 'Xcode', 'apple', [lib('Developer', 'Xcode', 'iOS DeviceSupport')], 'Cached symbols per iOS version. Regenerates when you attach a device.', { storyCategory: 'xcode' }),
      makeTarget('simulator-caches', 'Simulator caches', 'Xcode', 'apple', [lib('Developer', 'CoreSimulator', 'Caches')], 'Core Simulator caches.', { storyCategory: 'xcode' }),
      makeTarget('user-caches', 'Other app caches', 'System', 'broom-2', [lib('Caches')], 'Generic per-app caches after known developer and browser caches are counted separately.', { storyCategory: 'caches' }),
      makeTarget('cli-cache', 'Command-line tool caches', 'System', 'database', [join('.cache')], CLI_CACHE_DESCRIPTION, { storyCategory: 'caches', safe: false, protect: CLI_CACHE_PROTECT }),
      makeTarget('user-logs', 'User logs', 'System', 'log', [lib('Logs')], 'Log files apps write for troubleshooting. Apps start new logs, but removed entries cannot be recovered.', { storyCategory: 'caches', reversible: false, restoreHint: 'Apps start new logs as they run. The removed entries are gone.' }),
      makeTarget('trash', 'Trash', 'System', 'trash', [join('.Trash')], TRASH_DESCRIPTION, { safe: false, reversible: false, storyCategory: 'system' }),
      makeTarget('saved-state', 'Saved app state', 'System', 'grid', [lib('Saved Application State')], 'Saved window positions and open documents apps restore on relaunch. Apps open fresh afterwards, without their previous windows.', { storyCategory: 'system', reversible: false, restoreHint: 'Apps save new window state the next time they run. Previous windows are not restored.' }),
    );
  } else if (platform === 'linux') {
    targets.push(
      makeTarget('user-cache', 'Other user cache', 'System', 'database', [xdgCache(ctx)], CLI_CACHE_DESCRIPTION.replace('~/.cache', 'your cache folder'), { storyCategory: 'caches', safe: false, protect: CLI_CACHE_PROTECT }),
      makeTarget('trash', 'Trash', 'System', 'trash', [join('.local', 'share', 'Trash', 'files'), join('.local', 'share', 'Trash', 'info')], TRASH_DESCRIPTION, { safe: false, reversible: false, storyCategory: 'system' }),
      makeTarget('thumbnails', 'Thumbnails', 'System', 'image', [xdgCache(ctx, 'thumbnails')], 'Cached image thumbnails. Regenerated on demand.', { storyCategory: 'caches' }),
    );
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const temp = env.TEMP;
    targets.push(
      makeTarget('local-temp', 'User temp files', 'System', 'trash', [from(local, 'Temp')], 'Per-user temporary files.', { storyCategory: 'caches' }),
    );
    // %TEMP% is usually %LOCALAPPDATA%\Temp, which would be sized and counted
    // twice. Only list it separately when it really is somewhere else.
    const localTemp = from(local, 'Temp');
    // Windows often writes TEMP as an 8.3 short name (C:\Users\JOHNSM~1\...),
    // so compare the real paths too when the folders exist.
    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
    const norm = (p) => ctx.pathApi.resolve(p).toLowerCase();
    const sameFolder = (a, b) => Boolean(a && b) && (norm(a) === norm(b) || norm(real(a)) === norm(real(b)));
    if (temp && !sameFolder(temp, localTemp)) {
      targets.push(makeTarget('windows-temp', 'Windows temp files', 'System', 'trash', [temp], 'Temporary files from %TEMP%.', { storyCategory: 'caches' }));
    }
  }

  return targets
    .concat(buildAiToolTargets(ctx))
    .concat(buildBrowserTargets(ctx).map((t) => ({
      ...t,
      storyCategory: 'browsers',
    })))
    .filter((t) => t.paths.length > 0);
}

function buildProjectRoots(home) {
  return ['projects', 'dev', 'code', 'Developer'].map((name) => path.join(home, name));
}

function buildStoryCategories(options = {}) {
  const ctx = platformContext(options);
  const { platform, home, env, pathApi, join, winJoin, from } = ctx;
  const targets = buildSystemTargets(ctx);
  const pathsByStory = new Map();
  for (const t of targets) {
    const key = t.storyCategory || t.category.toLowerCase();
    pathsByStory.set(key, uniq([...(pathsByStory.get(key) || []), ...t.paths]));
  }

  const projectRoots = ['projects', 'dev', 'code', 'Developer'].map((name) => pathApi.join(home, name));
  const developerDirs = uniq([
    ...projectRoots,
    ...(pathsByStory.get('developer') || []),
    join('.rustup'),
    join('.nvm'),
    platform === 'darwin' ? join('Library', 'Developer') : null,
    ...devToolDirs(ctx),
  ]);

  const appDirs = [];
  if (platform === 'darwin') appDirs.push('/Applications');
  if (platform === 'linux') appDirs.push('/usr/share/applications', '/usr/local/share/applications', '/opt', '/var/lib/flatpak', join('.local', 'share', 'flatpak'), join('snap'));
  if (platform === 'win32') appDirs.push(env.ProgramFiles, env['ProgramFiles(x86)'], from(env.LOCALAPPDATA, 'Programs'), from(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
  appDirs.push(platform === 'win32' ? winJoin('AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs') : join('Applications'));

  const appDataDirs =
    platform === 'darwin'
      ? [join('Library', 'Application Support'), join('Library', 'Containers'), join('Library', 'Group Containers')]
      : platform === 'linux'
        ? [join('.config'), join('.local', 'share')]
        : [env.APPDATA, env.LOCALAPPDATA, from(env.LOCALAPPDATA, 'Packages')].filter(Boolean);

  const cacheDirs =
    platform === 'darwin'
      ? [join('Library', 'Caches'), join('Library', 'Logs'), join('.cache')]
      : platform === 'linux'
        ? [xdgCache(ctx)]
        : [env.TEMP, from(env.LOCALAPPDATA, 'Temp')];

  const videoDir = platform === 'darwin' ? join('Movies') : join('Videos');
  const mediaDirs = [join('Pictures'), videoDir, join('Music')];
  const docDirs = [join('Documents'), join('Desktop')];
  const downloadDirs = [join('Downloads')];

  return [
    storyDef('developer', developerDirs, pathsByStory),
    storyDef('aitools', pathsByStory.get('aitools') || [], pathsByStory),
    storyDef('applications', appDirs, pathsByStory),
    storyDef('appdata', appDataDirs, pathsByStory),
    storyDef('caches', cacheDirs, pathsByStory),
    storyDef('browsers', pathsByStory.get('browsers') || [], pathsByStory),
    storyDef('xcode', pathsByStory.get('xcode') || [], pathsByStory),
    storyDef('media', mediaDirs, pathsByStory),
    storyDef('documents', docDirs, pathsByStory),
    storyDef('downloads', downloadDirs, pathsByStory),
    storyDef('mail', platform === 'darwin' ? [join('Library', 'Mail'), join('Library', 'Messages')] : [], pathsByStory),
  ].filter((d) => d.dirs.length > 0);
}

function storyDef(key, dirs, pathsByStory) {
  const meta = CATEGORY_META[key] || CATEGORY_META.system;
  const subtractDirs = [];
  if (key === 'caches') {
    for (const [childKey, paths] of pathsByStory.entries()) {
      if (childKey !== 'caches') subtractDirs.push(...paths);
    }
  } else if (key === 'appdata') {
    // Browsers and AI tools (Cursor, Zed, Windsurf) keep data under
    // Application Support; count it in their own story, not twice.
    subtractDirs.push(...(pathsByStory.get('browsers') || []), ...(pathsByStory.get('aitools') || []));
  }
  return { key, ...meta, tier: CATEGORY_TIER[key] || 'C', dirs: uniq(dirs), subtractDirs: uniq(subtractDirs) };
}

/**
 * The unclassified remainder. Its bytes are used minus everything measured, so
 * there is no folder that "is" System; `dirs` are the places unclassified data
 * usually lives, for the drill-down, which leaves out anything another category
 * already counts.
 */
function systemCategory(bytes, { platform = process.platform, home = require('os').homedir() } = {}) {
  return { key: 'system', ...CATEGORY_META.system, tier: 'D', bytes, dirs: unclassifiedRoots({ platform, home }), drill: 'unclassified' };
}

/**
 * Folders whose children no category claims: the home folder itself and the
 * few containers next to category folders. Everything outside the home folder
 * (/Library, /opt, /private/var, ProgramData, /usr, /var) is measured by the
 * OS collectors in os-storage/ as named items instead.
 */
function unclassifiedRoots({ platform = process.platform, home = require('os').homedir() } = {}) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const j = (...p) => api.join(home, ...p);
  if (platform === 'darwin') return [home, j('Library')];
  if (platform === 'win32') return [home, j('AppData')];
  return [home, j('.local')];
}

// The cleaning tier of each story category as a whole (os-storage-spec.md):
// A regenerable bulk, B confirm per category, C per item, D OS-managed. A
// category mixing tiers takes its most careful one; drill-down items get their
// own tier from tierForPath().
const CATEGORY_TIER = Object.freeze({
  developer: 'C', // project folders are your code; the caches inside are A
  aitools: 'B',
  applications: 'C',
  appdata: 'C',
  caches: 'B',
  browsers: 'B',
  xcode: 'B',
  media: 'C',
  documents: 'C',
  downloads: 'C',
  mail: 'C',
  system: 'D',
});

/**
 * Tier of one path in a drill-down: a known cleaning target decides it (safe
 * and regenerable: A, regenerable but costly: B, irreversible: C); otherwise
 * the category it sits in.
 */
function tierForPath(p, options = {}) {
  const ctx = platformContext(options);
  const api = ctx.pathApi;
  const inside = (parent, child) => {
    if (!parent || !child) return false;
    if (parent === child) return true;
    const rel = api.relative(parent, child);
    return Boolean(rel) && !rel.startsWith('..') && !api.isAbsolute(rel);
  };
  let best = null;
  for (const t of buildSystemTargets(ctx)) {
    for (const tp of t.paths) {
      // The target itself or anything inside it; a folder that merely contains
      // a target (~/Library holds Caches) is not the target.
      if (!inside(tp, p)) continue;
      const tier = t.safe ? 'A' : t.reversible === false ? 'C' : 'B';
      if (!best || tp.length > best.len) best = { tier, len: tp.length };
    }
  }
  if (best) return best.tier;
  for (const def of buildStoryCategories(ctx)) {
    if (def.dirs.some((d) => inside(d, p))) {
      if (def.key === 'developer' && buildProjectRoots(ctx.home).some((r) => inside(r, p))) return 'C';
      return CATEGORY_TIER[def.key] || 'C';
    }
  }
  return 'C';
}

module.exports = {
  CATEGORY_META,
  buildStoryCategories,
  buildSystemTargets,
  systemCategory,
  unclassifiedRoots,
  buildProjectRoots,
  tierForPath,
  CATEGORY_TIER,
  makeTarget,
  devToolDirs,
};
