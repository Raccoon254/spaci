'use strict';
/**
 * Paths that can never be a cache folder, whatever an environment variable or
 * a tool's own "where is your cache" answer says: the filesystem or a drive
 * root, the home folder, any folder that holds the home folder, and the folder
 * that holds every user's home (/Users, /home, C:\Users).
 *
 * GOCACHE=$HOME or XDG_CACHE_HOME=/ is a typo away; emptying "the cache" there
 * would empty the home folder. Every env-derived cache path goes through
 * unsafeCachePath (storage-classifier) and so does every folder native cleanup
 * empties or a tool reports (native-cleanup).
 */

const path = require('path');

function apiFor(platform) { return platform === 'win32' ? path.win32 : path.posix; }

// Compared without case on Windows and macOS (case-insensitive by default).
function keyFor(p, platform) {
  const api = apiFor(platform);
  let r = api.resolve(p);
  const root = api.parse(r).root;
  if (r.length > root.length) r = r.replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? r.toLowerCase() : r;
}

const USER_ROOTS = {
  darwin: ['/Users', '/var/root', '/private/var/root'],
  linux: ['/home', '/root'],
  win32: [],
};

/**
 * Why `p` cannot be a cache folder, or null when it can. `home` is the
 * user's home folder for `platform`.
 */
function unsafeCachePath(p, { home, platform = process.platform } = {}) {
  const api = apiFor(platform);
  if (typeof p !== 'string' || !p.trim()) return 'it is empty';
  if (!api.isAbsolute(p)) return 'it is not an absolute path';
  const k = keyFor(p, platform);
  const root = keyFor(api.parse(api.resolve(p)).root, platform);
  if (k === root) return 'it is the root of a disk';
  if (platform === 'win32') {
    // C:\Users, D:\Users ...: every user's home.
    if (/^[a-z]:\\users$/i.test(k)) return 'it holds every user\'s home folder';
    // \\server\share is the UNC root.
    if (/^\\\\[^\\]+\\[^\\]+$/.test(k)) return 'it is the root of a disk';
  } else if ((USER_ROOTS[platform] || USER_ROOTS.linux).map((x) => keyFor(x, platform)).includes(k)) {
    return 'it holds every user\'s home folder';
  }
  if (home && api.isAbsolute(home)) {
    const h = keyFor(home, platform);
    if (k === h) return 'it is your home folder';
    const sep = platform === 'win32' ? '\\' : '/';
    if (h.startsWith(k.endsWith(sep) ? k : k + sep)) return 'it holds your home folder';
  }
  return null;
}

/** `value` when it is an absolute, safe cache path, else `fallback`. */
function safeEnvPath(value, fallback, ctx) {
  if (!value) return fallback;
  return unsafeCachePath(value, ctx) ? fallback : value;
}

module.exports = { unsafeCachePath, safeEnvPath };
