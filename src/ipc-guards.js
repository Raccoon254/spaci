'use strict';
/**
 * Input checks for IPC handlers that reach the OS: opening URLs, opening or
 * revealing paths, and choosing where a large-file scan may walk. The renderer
 * is not trusted to pass safe values, so each check fails closed.
 *
 * Pure apart from an injectable realpath, so it is unit tested without Electron.
 */
const fs = require('fs');
const path = require('path');

const MB = 1024 * 1024;
const MIN_LARGE_FILE_BYTES = 10 * MB;
const DEFAULT_LARGE_FILE_BYTES = 100 * MB;

const EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:']);

/** Only https: and mailto: URLs leave the app. Everything else (javascript:, file:, http:, custom schemes) is refused. */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  let u;
  try { u = new URL(url.trim()); } catch { return false; }
  if (!EXTERNAL_PROTOCOLS.has(u.protocol)) return false;
  if (u.protocol === 'https:' && !u.hostname) return false;
  return true;
}

function pathApiFor(p) {
  return /^[a-zA-Z]:[\\/]/.test(String(p || '')) || String(p || '').includes('\\') ? path.win32 : path.posix;
}

/** Same identity rules as clean-guard: resolved, NFC, case-folded where the filesystem ignores case. */
function keyOf(p, platform = process.platform) {
  const key = pathApiFor(p).resolve(String(p)).normalize('NFC');
  return platform === 'linux' ? key : key.toLowerCase();
}

/** An absolute local path: POSIX `/...` or a Windows drive `C:\...`. UNC and drive-relative paths are refused. */
function isAbsoluteAny(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) return false;
  if (/^[\\/]{2}/.test(p)) return false;
  return /^\//.test(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

/** `child` equals `parent` or lies inside it. Both must use the same separator style. */
function isSameOrInside(parent, child, platform = process.platform) {
  if (!parent || !child) return false;
  const a = keyOf(parent, platform);
  const b = keyOf(child, platform);
  if (a === b) return true;
  const api = pathApiFor(parent);
  const rel = api.relative(a, b);
  return Boolean(rel) && !rel.startsWith('..') && !api.isAbsolute(rel);
}

/** A lookup over every path Spaci knows. `has(p)` matches by identity, never by prefix. */
function knownPathSet(paths, platform = process.platform) {
  const keys = new Set();
  for (const p of paths || []) if (typeof p === 'string' && p) keys.add(keyOf(p, platform));
  return { has: (p) => typeof p === 'string' && p.length > 0 && isAbsoluteAny(p) && keys.has(keyOf(p, platform)), size: keys.size };
}

/** Minimum size for a large-file scan: at least 10 MB, 100 MB when the value is not a usable number. */
function clampMinBytes(minBytes) {
  const n = typeof minBytes === 'string' && minBytes.trim() !== '' ? Number(minBytes) : minBytes;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return DEFAULT_LARGE_FILE_BYTES;
  return Math.max(MIN_LARGE_FILE_BYTES, Math.floor(n));
}

function defaultRealpath(p) {
  return fs.realpathSync.native(p);
}

/**
 * Where a large-file scan may walk: the home folder, a configured scan root,
 * or a folder inside one. Checked on the path as given and on its real path,
 * so a symlink inside the home folder cannot point the walk at `/`.
 * Returns { ok: true, root } or { ok: false, error }.
 */
function resolveLargeFilesRoot(root, { home, scanRoots = [], realpath = defaultRealpath, platform = process.platform } = {}) {
  const candidate = root == null || root === '' ? home : root;
  if (typeof candidate !== 'string' || !isAbsoluteAny(candidate)) {
    return { ok: false, error: 'Choose a folder inside your home folder or a scan folder.' };
  }
  const allowed = [home, ...(Array.isArray(scanRoots) ? scanRoots : [])].filter((r) => typeof r === 'string' && isAbsoluteAny(r));
  const real = (p) => { try { return realpath(p); } catch { return p; } };
  const inside = (p) => allowed.some((r) => isSameOrInside(r, p, platform) || isSameOrInside(real(r), p, platform));
  if (!inside(candidate) || !inside(real(candidate))) {
    return { ok: false, error: 'Spaci only scans your home folder and your scan folders for large files.' };
  }
  return { ok: true, root: pathApiFor(candidate).resolve(candidate) };
}

module.exports = {
  MIN_LARGE_FILE_BYTES, DEFAULT_LARGE_FILE_BYTES,
  isSafeExternalUrl, clampMinBytes, resolveLargeFilesRoot, knownPathSet, isSameOrInside, keyOf,
};
