'use strict';
/**
 * Cross-platform browser-cache detection for the System Cleaner.
 *
 * Exposes buildBrowserTargets(): an array of cache targets, one per browser,
 * for the current platform. Each target has the standard shape used by
 * system.js:
 *   { id, name, category:'Browsers', icon, safe, reversible, mode:'contents',
 *     paths:[absolute dirs], description }
 *
 * Detection is implicit: scanSystem in system.js filters out any target whose
 * paths do not exist, so only installed browsers survive the scan.
 *
 * Icons use brand names where one exists ('chrome', 'safari', 'firefox',
 * 'edge'); Chromium-based browsers without a dedicated brand icon reuse
 * 'chrome'; anything else falls back to 'browser'.
 */
const os = require('os');
const path = require('path');

const defaultHome = () => os.homedir();

/** Make a browser target from a name, icon, and a list of (possibly null) paths. */
function browserTarget(name, icon, paths, idHint) {
  const id =
    'browser-' +
    (idHint || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return {
    id,
    name: `${name} cache`,
    category: 'Browsers',
    icon,
    safe: true,
    reversible: true,
    mode: 'contents',
    paths: paths.filter(Boolean),
    description: `${name} on-disk cache. Safe to clear, it rebuilds.`,
  };
}

// ---------------------------------------------------------------------------
// Per-platform browser catalogs
// ---------------------------------------------------------------------------

function darwinBrowsers(home = defaultHome(), pathApi = path.posix) {
  const h = (...p) => pathApi.join(home, ...p);
  const lib = (...p) => h('Library', 'Caches', ...p);
  const sup = (...p) => h('Library', 'Application Support', ...p);
  return [
    browserTarget('Chrome', 'chrome', [
      lib('Google', 'Chrome'),
      sup('Google', 'Chrome', 'Default', 'Cache'),
    ]),
    browserTarget('Safari', 'safari', [lib('com.apple.Safari')]),
    browserTarget('Firefox', 'firefox', [
      lib('Firefox'),
      lib('Mozilla', 'Firefox'),
    ]),
    browserTarget('Microsoft Edge', 'edge', [
      lib('Microsoft Edge'),
      sup('Microsoft Edge', 'Default', 'Cache'),
    ], 'edge'),
    browserTarget('Brave', 'chrome', [
      lib('BraveSoftware', 'Brave-Browser'),
      sup('BraveSoftware', 'Brave-Browser', 'Default', 'Cache'),
    ]),
    browserTarget('Opera', 'chrome', [
      lib('com.operasoftware.Opera'),
      sup('com.operasoftware.Opera', 'Default', 'Cache'),
    ]),
    browserTarget('Vivaldi', 'chrome', [
      lib('com.vivaldi.Vivaldi'),
      sup('Vivaldi', 'Default', 'Cache'),
    ]),
    browserTarget('Chromium', 'chrome', [
      lib('Chromium'),
      sup('Chromium', 'Default', 'Cache'),
    ]),
    browserTarget('Arc', 'browser', [
      lib('Arc'),
      sup('Arc', 'User Data', 'Default', 'Cache'),
    ]),
  ];
}

function linuxBrowsers(home = defaultHome(), pathApi = path.posix) {
  const h = (...p) => pathApi.join(home, ...p);
  const cache = (...p) => h('.cache', ...p);
  const config = (...p) => h('.config', ...p);
  return [
    browserTarget('Chrome', 'chrome', [
      cache('google-chrome'),
      config('google-chrome', 'Default', 'Cache'),
    ]),
    browserTarget('Firefox', 'firefox', [
      cache('mozilla', 'firefox'),
      h('.mozilla', 'firefox'),
    ]),
    browserTarget('Microsoft Edge', 'edge', [
      cache('microsoft-edge'),
      config('microsoft-edge', 'Default', 'Cache'),
    ], 'edge'),
    browserTarget('Brave', 'chrome', [
      cache('BraveSoftware', 'Brave-Browser'),
      config('BraveSoftware', 'Brave-Browser', 'Default', 'Cache'),
    ]),
    browserTarget('Opera', 'chrome', [
      cache('opera'),
      config('opera', 'opera', 'Default', 'Cache'),
    ]),
    browserTarget('Vivaldi', 'chrome', [
      cache('vivaldi'),
      config('vivaldi', 'Default', 'Cache'),
    ]),
    browserTarget('Chromium', 'chrome', [
      cache('chromium'),
      config('chromium', 'Default', 'Cache'),
    ]),
  ];
}

function win32Browsers(home = defaultHome(), env = process.env, pathApi = path.win32) {
  const LOCALAPPDATA = env.LOCALAPPDATA;
  // p(...segments) returns an absolute path under %LOCALAPPDATA%, or null when
  // the env var is undefined (matches the null-skipping pattern in system.js).
  const p = (...segments) =>
    LOCALAPPDATA ? pathApi.join(LOCALAPPDATA, ...segments) : null;
  return [
    browserTarget('Chrome', 'chrome', [
      p('Google', 'Chrome', 'User Data', 'Default', 'Cache'),
    ]),
    browserTarget('Firefox', 'firefox', [
      p('Mozilla', 'Firefox', 'Profiles'),
    ]),
    browserTarget('Microsoft Edge', 'edge', [
      p('Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
    ], 'edge'),
    browserTarget('Brave', 'chrome', [
      p('BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Cache'),
    ]),
    browserTarget('Opera', 'chrome', [
      p('Opera Software', 'Opera Stable', 'Cache'),
    ]),
    browserTarget('Vivaldi', 'chrome', [
      p('Vivaldi', 'User Data', 'Default', 'Cache'),
    ]),
    browserTarget('Chromium', 'chrome', [
      p('Chromium', 'User Data', 'Default', 'Cache'),
    ]),
  ];
}

/** Build the browser-cache targets for the current platform. */
function buildBrowserTargets(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || defaultHome();
  const env = options.env || process.env;
  const pathApi = options.pathApi || (platform === 'win32' ? path.win32 : path.posix);
  let list;
  switch (platform) {
    case 'darwin':
      list = darwinBrowsers(home, pathApi);
      break;
    case 'linux':
      list = linuxBrowsers(home, pathApi);
      break;
    case 'win32':
      list = win32Browsers(home, env, pathApi);
      break;
    default:
      list = [];
  }
  // Drop any target left without paths (every base path resolved to null).
  return list.filter((t) => t.paths.length > 0);
}

module.exports = { buildBrowserTargets };
