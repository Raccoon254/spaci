'use strict';
// The scan cache (userData/cache.json): the last projects and system scan, the
// Docker summary, the disk breakdown, per-project enrichment and the
// background scheduler's bookkeeping.
//
// Everything that reads it goes through normalizeCache, so a truncated file, an
// old format or a hand-edited value can never crash startup or the renderer.
// Writes go to a temp file first and are then renamed over the real one, so a
// crash or power loss mid-write leaves the previous cache intact.
//
// No Electron in here: the file system and logger are injected so node --test
// can exercise every path.

const nodeFs = require('fs');
const path = require('path');

const CACHE_SCHEMA = 2;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
const str = (v, d = '') => (typeof v === 'string' ? v : d);

function emptyCache() {
  return {
    version: CACHE_SCHEMA,
    projects: [],
    system: [],
    scannedAt: 0,
    root: '',
    meta: {},
    enrich: {},
    kindScannedAt: { projects: 0, system: 0 },
    schedule: { lastCompletedAt: 0, lastAttemptAt: 0, failures: 0, lastRun: null },
  };
}

function normalizeProject(p) {
  if (!isObj(p) || typeof p.path !== 'string' || !p.path) return null;
  const items = Array.isArray(p.items)
    ? p.items.filter((it) => isObj(it) && typeof it.path === 'string' && it.path)
      .map((it) => ({ ...it, size: num(it.size) }))
    : [];
  const cleanable = typeof p.cleanableSize === 'number' && Number.isFinite(p.cleanableSize)
    ? Math.max(0, p.cleanableSize)
    : items.reduce((s, it) => s + it.size, 0);
  return {
    ...p,
    name: str(p.name, path.basename(p.path)),
    items,
    cleanableSize: cleanable,
    mtime: num(p.mtime),
  };
}

function normalizeTarget(t) {
  if (!isObj(t) || typeof t.id !== 'string' || !t.id) return null;
  return { ...t, size: num(t.size) };
}

/**
 * Turn whatever was on disk into a cache with the current shape. Unknown extra
 * keys are kept (a newer build may have written them); anything malformed is
 * dropped or reset to its default.
 */
function normalizeCache(raw) {
  const base = emptyCache();
  if (!isObj(raw)) return base;
  const out = { ...raw, ...base };
  out.projects = Array.isArray(raw.projects) ? raw.projects.map(normalizeProject).filter(Boolean) : [];
  out.system = Array.isArray(raw.system) ? raw.system.map(normalizeTarget).filter(Boolean) : [];
  out.scannedAt = num(raw.scannedAt);
  out.root = str(raw.root);
  out.meta = isObj(raw.meta) ? raw.meta : {};
  out.enrich = {};
  if (isObj(raw.enrich)) {
    for (const [k, v] of Object.entries(raw.enrich)) if (isObj(v)) out.enrich[k] = v;
  }
  // v1 caches had no per-kind timestamps: the single scannedAt stood for both.
  const kinds = isObj(raw.kindScannedAt) ? raw.kindScannedAt : {};
  out.kindScannedAt = {
    projects: num(kinds.projects, raw.version ? 0 : out.scannedAt),
    system: num(kinds.system, raw.version ? 0 : out.scannedAt),
  };
  const sch = isObj(raw.schedule) ? raw.schedule : {};
  out.schedule = {
    lastCompletedAt: num(sch.lastCompletedAt),
    lastAttemptAt: num(sch.lastAttemptAt),
    failures: Math.floor(num(sch.failures)),
    lastRun: isObj(sch.lastRun) ? sch.lastRun : null,
  };
  if ('docker' in raw) { if (isObj(raw.docker)) out.docker = raw.docker; else delete out.docker; }
  if ('diskBreakdown' in raw) { if (isObj(raw.diskBreakdown)) out.diskBreakdown = raw.diskBreakdown; else delete out.diskBreakdown; }
  out.version = CACHE_SCHEMA;
  return out;
}

/**
 * Read and normalize the cache file.
 * @returns {{cache: object, status: 'ok'|'missing'|'corrupt'}}
 */
function readCacheFile(file, { fs = nodeFs, log = console } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code !== 'ENOENT') log.warn('[cache] could not read', file, e.message);
    return { cache: emptyCache(), status: 'missing' };
  }
  try {
    return { cache: normalizeCache(JSON.parse(text)), status: 'ok' };
  } catch (e) {
    log.warn('[cache] corrupt cache file, starting fresh:', e.message);
    return { cache: emptyCache(), status: 'corrupt' };
  }
}

let tmpCounter = 0;
/** Write `data` to `file` via a temp file and rename, so readers never see half a file. */
function writeFileAtomic(file, data, { fs = nodeFs } = {}) {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* temp file may not exist */ }
    throw e;
  }
}

/**
 * The in-memory cache plus its persistence. `get()` returns the live object
 * (callers mutate it, then call `write()`). After `close()` nothing is written.
 */
function createCacheStore({ file, fs = nodeFs, log = console } = {}) {
  const loaded = readCacheFile(file, { fs, log });
  let cache = loaded.cache;
  let closed = false;
  let writes = 0;
  return {
    loadStatus: loaded.status,
    get: () => cache,
    get closed() { return closed; },
    get writes() { return writes; },
    write() {
      if (closed) return false;
      try {
        writeFileAtomic(file, JSON.stringify(cache), { fs });
        writes++;
        return true;
      } catch (e) {
        log.error('[cache] write failed:', e && e.message);
        return false;
      }
    },
    close() { closed = true; },
  };
}

module.exports = {
  CACHE_SCHEMA, emptyCache, normalizeCache, readCacheFile, writeFileAtomic, createCacheStore,
};
