'use strict';

const os = require('os');
const path = require('path');
const { buildBrowserTargets } = require('./browsers');

const CATEGORY_META = {
  developer: { label: 'Developer', icon: 'code', hint: 'Code, build caches and SDKs' },
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
  return {
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
}

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
      makeTarget('pnpm', 'pnpm store', 'Developer', 'node', [lib('pnpm', 'store'), join('.pnpm-store')], 'pnpm content-addressable store.'),
      makeTarget('bun', 'Bun cache', 'Developer', 'flash', [join('.bun', 'install', 'cache')], 'Bun install cache.'),
      makeTarget('gradle', 'Gradle cache', 'Developer', 'gradle', [join('.gradle', 'caches')], 'Global Gradle build cache & downloaded deps.'),
      makeTarget('maven', 'Maven repository', 'Developer', 'java', [join('.m2', 'repository')], 'Downloaded Maven artifacts. Re-downloads on build.'),
      makeTarget('cargo', 'Cargo registry', 'Developer', 'rust', [join('.cargo', 'registry', 'cache'), join('.cargo', 'registry', 'src')], 'Rust crate cache.'),
      makeTarget('cocoapods', 'CocoaPods cache', 'Developer', 'apple', [lib('Caches', 'CocoaPods')], 'CocoaPods spec & pod cache.'),
      makeTarget('pub', 'Dart/Flutter pub', 'Developer', 'flutter', [join('.pub-cache', 'hosted')], 'Dart/Flutter downloaded packages.'),
      makeTarget('pip', 'pip cache', 'Developer', 'python', [lib('Caches', 'pip')], 'Python pip download cache.'),
      makeTarget('go', 'Go build/mod cache', 'Developer', 'go', [lib('Caches', 'go-build'), join('go', 'pkg', 'mod', 'cache')], 'Go build & module cache.'),
      makeTarget('deno', 'Deno cache', 'Developer', 'flash', [lib('Caches', 'deno')], 'Deno dependency cache.'),
    ];
  }

  if (platform === 'linux') {
    return [
      makeTarget('npm', 'npm cache', 'Developer', 'node', [join('.npm', '_cacache')], 'Downloaded npm package tarballs. Rebuilds on next install.'),
      makeTarget('yarn', 'Yarn cache', 'Developer', 'node', [join('.cache', 'yarn')], 'Yarn package cache.'),
      makeTarget('pnpm', 'pnpm store', 'Developer', 'node', [join('.local', 'share', 'pnpm', 'store')], 'pnpm content-addressable store.'),
      makeTarget('gradle', 'Gradle cache', 'Developer', 'gradle', [join('.gradle', 'caches')], 'Global Gradle build cache & downloaded deps.'),
      makeTarget('maven', 'Maven repository', 'Developer', 'java', [join('.m2', 'repository')], 'Downloaded Maven artifacts. Re-downloads on build.'),
      makeTarget('cargo', 'Cargo registry', 'Developer', 'rust', [join('.cargo', 'registry', 'cache'), join('.cargo', 'registry', 'src')], 'Rust crate cache.'),
      makeTarget('pip', 'pip cache', 'Developer', 'python', [join('.cache', 'pip')], 'Python pip download cache.'),
      makeTarget('go', 'Go build/mod cache', 'Developer', 'go', [join('.cache', 'go-build'), join('go', 'pkg', 'mod', 'cache')], 'Go build & module cache.'),
      makeTarget('pub', 'Dart/Flutter pub', 'Developer', 'flutter', [join('.pub-cache', 'hosted')], 'Dart/Flutter downloaded packages.'),
      makeTarget('bun', 'Bun cache', 'Developer', 'flash', [join('.bun', 'install', 'cache')], 'Bun install cache.'),
      makeTarget('deno', 'Deno cache', 'Developer', 'flash', [join('.cache', 'deno')], 'Deno dependency cache.'),
    ];
  }

  const local = env.LOCALAPPDATA;
  return [
    makeTarget('npm', 'npm cache', 'Developer', 'node', [from(local, 'npm-cache')], 'Downloaded npm package tarballs. Rebuilds on next install.'),
    makeTarget('yarn', 'Yarn cache', 'Developer', 'node', [from(local, 'Yarn', 'Cache')], 'Yarn package cache.'),
    makeTarget('gradle', 'Gradle cache', 'Developer', 'gradle', [winJoin('.gradle', 'caches')], 'Global Gradle build cache & downloaded deps.'),
    makeTarget('maven', 'Maven repository', 'Developer', 'java', [winJoin('.m2', 'repository')], 'Downloaded Maven artifacts. Re-downloads on build.'),
    makeTarget('cargo', 'Cargo registry', 'Developer', 'rust', [winJoin('.cargo', 'registry', 'cache'), winJoin('.cargo', 'registry', 'src')], 'Rust crate cache.'),
    makeTarget('pip', 'pip cache', 'Developer', 'python', [from(local, 'pip', 'Cache')], 'Python pip download cache.'),
    makeTarget('go', 'Go build/mod cache', 'Developer', 'go', [from(local, 'go-build'), winJoin('go', 'pkg', 'mod', 'cache')], 'Go build & module cache.'),
    makeTarget('nuget', 'NuGet packages', 'Developer', 'box', [winJoin('.nuget', 'packages')], 'Downloaded NuGet packages. Re-downloads on restore.'),
    makeTarget('bun', 'Bun cache', 'Developer', 'flash', [winJoin('.bun', 'install', 'cache')], 'Bun install cache.'),
  ];
}

function buildSystemTargets(options = {}) {
  const ctx = platformContext(options);
  const { platform, env, join, from } = ctx;
  const targets = buildDeveloperTargets(ctx);

  if (platform === 'darwin') {
    const lib = (...p) => join('Library', ...p);
    targets.push(
      makeTarget('xcode-derived', 'Xcode DerivedData', 'Xcode', 'apple', [lib('Developer', 'Xcode', 'DerivedData')], 'Xcode build intermediates. Safe to wipe, it rebuilds.', { storyCategory: 'xcode' }),
      makeTarget('xcode-archives', 'Xcode Archives', 'Xcode', 'box', [lib('Developer', 'Xcode', 'Archives')], 'App archives for distribution. Delete only if already uploaded.', { safe: false, storyCategory: 'xcode' }),
      makeTarget('xcode-devicesupport', 'iOS DeviceSupport', 'Xcode', 'apple', [lib('Developer', 'Xcode', 'iOS DeviceSupport')], 'Cached symbols per iOS version. Regenerates when you attach a device.', { storyCategory: 'xcode' }),
      makeTarget('simulator-caches', 'Simulator caches', 'Xcode', 'apple', [lib('Developer', 'CoreSimulator', 'Caches')], 'Core Simulator caches.', { storyCategory: 'xcode' }),
      makeTarget('user-caches', 'Other app caches', 'System', 'broom-2', [lib('Caches')], 'Generic per-app caches after known developer and browser caches are counted separately.', { storyCategory: 'caches' }),
      makeTarget('user-logs', 'User logs', 'System', 'log', [lib('Logs')], 'Application log files.', { storyCategory: 'caches' }),
      makeTarget('trash', 'Trash', 'System', 'trash', [join('.Trash')], 'Files in the Trash.', { storyCategory: 'system' }),
      makeTarget('saved-state', 'Saved app state', 'System', 'grid', [lib('Saved Application State')], 'Window restore state. Apps just open fresh.', { storyCategory: 'system' }),
    );
  } else if (platform === 'linux') {
    targets.push(
      makeTarget('user-cache', 'Other user cache', 'System', 'database', [join('.cache')], 'Generic per-user cache after known developer and browser caches are counted separately.', { storyCategory: 'caches' }),
      makeTarget('trash', 'Trash', 'System', 'trash', [join('.local', 'share', 'Trash', 'files'), join('.local', 'share', 'Trash', 'info')], 'Files in the Trash.', { storyCategory: 'system' }),
      makeTarget('thumbnails', 'Thumbnails', 'System', 'image', [join('.cache', 'thumbnails')], 'Cached image thumbnails. Regenerated on demand.', { storyCategory: 'caches' }),
    );
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const temp = env.TEMP;
    targets.push(
      makeTarget('local-temp', 'User temp files', 'System', 'trash', [from(local, 'Temp')], 'Per-user temporary files.', { storyCategory: 'caches' }),
      makeTarget('windows-temp', 'Windows temp files', 'System', 'trash', [temp], 'Temporary files from %TEMP%.', { storyCategory: 'caches' }),
    );
  }

  return targets.concat(buildBrowserTargets(ctx).map((t) => ({
    ...t,
    storyCategory: 'browsers',
  }))).filter((t) => t.paths.length > 0);
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
      ? [join('Library', 'Caches'), join('Library', 'Logs')]
      : platform === 'linux'
        ? [join('.cache')]
        : [env.TEMP, from(env.LOCALAPPDATA, 'Temp')];

  const videoDir = platform === 'darwin' ? join('Movies') : join('Videos');
  const mediaDirs = [join('Pictures'), videoDir, join('Music')];
  const docDirs = [join('Documents'), join('Desktop')];
  const downloadDirs = [join('Downloads')];

  return [
    storyDef('developer', developerDirs, pathsByStory),
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
    subtractDirs.push(...(pathsByStory.get('browsers') || []));
  }
  return { key, ...meta, dirs: uniq(dirs), subtractDirs: uniq(subtractDirs) };
}

function systemCategory(bytes) {
  return { key: 'system', ...CATEGORY_META.system, bytes };
}

module.exports = {
  CATEGORY_META,
  buildStoryCategories,
  buildSystemTargets,
  systemCategory,
  makeTarget,
};
