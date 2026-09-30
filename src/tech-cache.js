'use strict';
/**
 * The language and framework analysis cache (scanner.analyzeTech).
 *
 * Why it never hit before: it lived only in the scan worker's memory, keyed by
 * the raw path string, and the worker stops after a few idle minutes. The next
 * scan (hours later) always met an empty cache. Now:
 *   - the key is the resolved path (a trailing slash or `..` no longer makes a
 *     second entry; case-folded where the filesystem ignores case);
 *   - it is a real LRU with a maximum size (a hit refreshes recency);
 *   - its entries can be exported with a scan result and seeded back into a
 *     new worker, so main keeps them in cache.json between worker lifetimes.
 *
 * An entry is valid while nothing it depends on changed: the git HEAD (or,
 * outside git, the project folder's mtime) and the mtime of every manifest it
 * read. The manifest check needs the disk, so it stays in scanner.js.
 *
 * Pure: no fs, no child processes.
 */
const path = require('path');

const TECH_CACHE_MAX = 300;
const MAX_MANIFESTS = 200;
const HEAD_RE = /^[0-9a-f]{40,64}$/;

function pathApiFor(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.includes('\\') ? path.win32 : path.posix;
}

/** Cache key for a project folder, or null when `dir` is not a usable path. */
function techCacheKey(dir, platform = process.platform) {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) return null;
  const api = pathApiFor(dir);
  if (!api.isAbsolute(dir)) return null;
  const key = api.resolve(dir).normalize('NFC');
  return platform === 'linux' ? key : key.toLowerCase();
}

/** A bounded least-recently-used map. get() and set() both mark an entry as recent. */
function createLru(max = TECH_CACHE_MAX) {
  const limit = Math.max(1, Math.floor(Number(max) || TECH_CACHE_MAX));
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key);
      map.set(key, v);
      return v;
    },
    peek(key) { return map.get(key); },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
      return this;
    },
    has(key) { return map.has(key); },
    delete(key) { return map.delete(key); },
    clear() { map.clear(); },
    get size() { return map.size; },
    get max() { return limit; },
    /** Oldest first, so replaying them through set() keeps the order. */
    entries() { return [...map.entries()]; },
  };
}

/** Does a cached entry still describe the folder? (HEAD, or the folder mtime outside git.) */
function stampMatches(entry, key) {
  if (!entry || !key) return false;
  if (entry.head !== key.head) return false;
  return Boolean(key.head) || entry.rootMtime === key.rootMtime;
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** One entry from outside (cache.json via main), checked field by field; null when malformed. */
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const head = raw.head === null ? null : (typeof raw.head === 'string' && HEAD_RE.test(raw.head) ? raw.head : undefined);
  if (head === undefined) return null;
  if (!isNum(raw.rootMtime)) return null;
  if (!Array.isArray(raw.manifests) || raw.manifests.length > MAX_MANIFESTS) return null;
  const manifests = [];
  for (const m of raw.manifests) {
    if (!Array.isArray(m) || typeof m[0] !== 'string' || !m[0] || m[0].includes('\0') || !isNum(m[1])) return null;
    // Relative to the project and never climbing out of it.
    if (path.posix.isAbsolute(m[0]) || path.win32.isAbsolute(m[0]) || m[0].split(/[\\/]/).includes('..')) return null;
    manifests.push([m[0], m[1]]);
  }
  const r = raw.result;
  if (!r || typeof r !== 'object' || !Array.isArray(r.languages) || !Array.isArray(r.frameworks)) return null;
  if (r.analysis && r.analysis.truncated) return null;
  return { head, rootMtime: raw.rootMtime, manifests, result: r };
}

/** Serialisable snapshot for main to keep: [[key, entry], ...], oldest first. */
function exportEntries(lru) {
  return lru.entries().map(([k, v]) => [k, { head: v.head, rootMtime: v.rootMtime, manifests: v.manifests, result: v.result }]);
}

/**
 * Seed entries from a snapshot. Entries already in memory win (they are at
 * least as fresh); malformed ones are skipped. Returns how many were added.
 */
function importEntries(lru, snapshot, platform = process.platform) {
  if (!Array.isArray(snapshot)) return 0;
  let added = 0;
  for (const pair of snapshot.slice(-lru.max)) {
    if (!Array.isArray(pair)) continue;
    const key = techCacheKey(pair[0], platform);
    if (!key || lru.has(key)) continue;
    const entry = sanitizeEntry(pair[1]);
    if (!entry) continue;
    lru.set(key, entry);
    added++;
  }
  return added;
}

module.exports = {
  TECH_CACHE_MAX, techCacheKey, createLru, stampMatches, sanitizeEntry, exportEntries, importEntries,
};
