'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  CACHE_SCHEMA, emptyCache, normalizeCache, readCacheFile, writeFileAtomic, createCacheStore,
} = require('../src/scan-cache');
const { quietLog } = require('./fake-clock');

const made = [];
function tmpDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-cache-')); made.push(d); return d; }
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test('normalizeCache turns non-objects into an empty cache', () => {
  for (const raw of [null, undefined, 42, 'x', [], true]) {
    const c = normalizeCache(raw);
    assert.deepEqual(c, emptyCache());
  }
});

test('normalizeCache migrates a v1 cache and keeps its data', () => {
  const v1 = {
    projects: [{ path: '/p/a', name: 'a', items: [{ path: '/p/a/node_modules', size: 10, safe: true }], cleanableSize: 10, mtime: 5 }],
    system: [{ id: 'npm', size: 100, safe: true }],
    scannedAt: 1700000000000,
    root: '/p',
    meta: { source: 'background-scan' },
  };
  const c = normalizeCache(v1);
  assert.equal(c.version, CACHE_SCHEMA);
  assert.equal(c.projects.length, 1);
  assert.equal(c.projects[0].cleanableSize, 10);
  assert.equal(c.system[0].id, 'npm');
  assert.equal(c.root, '/p');
  assert.deepEqual(c.enrich, {});
  // v1 had one timestamp for both kinds
  assert.deepEqual(c.kindScannedAt, { projects: 1700000000000, system: 1700000000000 });
  assert.equal(c.schedule.lastCompletedAt, 0);
});

test('normalizeCache drops malformed entries instead of crashing', () => {
  const c = normalizeCache({
    version: 2,
    projects: [null, 'str', { name: 'no path' }, { path: '/ok', items: 'nope' }, { path: '/ok2', items: [null, { path: '/ok2/t', size: 'big' }] }],
    system: [{ size: 5 }, { id: 'x', size: -3 }, 7],
    scannedAt: 'yesterday',
    root: 12,
    meta: [],
    enrich: { '/a': { totalSize: 1 }, '/b': 'bad', '/c': null },
    docker: 'nope',
    diskBreakdown: [],
    kindScannedAt: { projects: NaN, system: Infinity },
    schedule: { lastCompletedAt: -5, failures: 2.7, lastRun: 'x' },
  });
  assert.equal(c.projects.length, 2);
  assert.deepEqual(c.projects[0].items, []);
  assert.equal(c.projects[0].cleanableSize, 0);
  assert.deepEqual(c.projects[1].items, [{ path: '/ok2/t', size: 0 }]);
  assert.deepEqual(c.system, [{ id: 'x', size: 0 }]);
  assert.equal(c.scannedAt, 0);
  assert.equal(c.root, '');
  assert.deepEqual(c.meta, {});
  assert.deepEqual(Object.keys(c.enrich), ['/a']);
  assert.equal('docker' in c, false);
  assert.equal('diskBreakdown' in c, false);
  assert.deepEqual(c.kindScannedAt, { projects: 0, system: 0 });
  assert.deepEqual(c.schedule, { lastCompletedAt: 0, lastAttemptAt: 0, failures: 2, lastRun: null });
});

test('normalizeCache keeps unknown keys from a newer build and valid docker data', () => {
  const c = normalizeCache({ version: 9, futureThing: { a: 1 }, docker: { ok: true, at: 1 } });
  assert.deepEqual(c.futureThing, { a: 1 });
  assert.deepEqual(c.docker, { ok: true, at: 1 });
  assert.equal(c.version, CACHE_SCHEMA);
});

test('a project without cleanableSize gets it from its items', () => {
  const c = normalizeCache({ projects: [{ path: '/x', items: [{ path: '/x/a', size: 3, safe: true }, { path: '/x/b', size: 4, safe: true }] }] });
  assert.equal(c.projects[0].cleanableSize, 7);
  assert.equal(c.projects[0].unverifiedSize, 0);
  assert.equal(c.projects[0].name, 'x');
});

test('an old cache that counted unverified items as reclaimable is corrected on load (issue #13)', () => {
  const c = normalizeCache({ projects: [{
    path: '/x', cleanableSize: 9,
    items: [{ path: '/x/node_modules', size: 3, safe: true }, { path: '/x/build', size: 6, safe: false }, { path: '/x/dist', size: 1 }],
  }] });
  assert.equal(c.projects[0].cleanableSize, 3, 'only what a clean would pass to the cleaner');
  assert.equal(c.projects[0].unverifiedSize, 7, 'unverified (and unflagged) bytes apart');
});

test('readCacheFile: missing, truncated and valid files', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cache.json');
  const log = quietLog();
  assert.equal(readCacheFile(file, { log }).status, 'missing');

  fs.writeFileSync(file, '{"projects":[{"path":"/a","items":[');
  const truncated = readCacheFile(file, { log });
  assert.equal(truncated.status, 'corrupt');
  assert.deepEqual(truncated.cache, emptyCache());
  assert.ok(log.lines.warn.some((l) => l.includes('corrupt')), 'corruption is logged');

  fs.writeFileSync(file, '');
  assert.equal(readCacheFile(file, { log }).status, 'corrupt');

  fs.writeFileSync(file, JSON.stringify({ version: 2, scannedAt: 5 }));
  const ok = readCacheFile(file, { log });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.cache.scannedAt, 5);
});

test('writeFileAtomic writes a temp file and renames it over the target', () => {
  const calls = [];
  const fakeFs = {
    mkdirSync: () => {},
    writeFileSync: (f) => calls.push(['write', f]),
    renameSync: (a, b) => calls.push(['rename', a, b]),
    unlinkSync: () => calls.push(['unlink']),
  };
  writeFileAtomic('/d/cache.json', '{}', { fs: fakeFs });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'write');
  assert.match(calls[0][1], /^\/d\/cache\.json\.\d+\.\d+\.tmp$/);
  assert.deepEqual(calls[1], ['rename', calls[0][1], '/d/cache.json']);
});

test('a failed write leaves the previous cache intact and no temp file behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cache.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, scannedAt: 1 }));
  const failing = {
    ...fs,
    writeFileSync: (f, data) => { fs.writeFileSync(f, String(data).slice(0, 5)); throw new Error('ENOSPC'); },
  };
  assert.throws(() => writeFileAtomic(file, JSON.stringify({ scannedAt: 2 }), { fs: failing }), /ENOSPC/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).scannedAt, 1);
  assert.deepEqual(fs.readdirSync(dir), ['cache.json']);
});

test('cache store round-trips, logs write errors and never writes after close', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'cache.json');
  const log = quietLog();
  const store = createCacheStore({ file, log });
  assert.equal(store.loadStatus, 'missing');
  store.get().scannedAt = 123;
  assert.equal(store.write(), true);
  assert.equal(createCacheStore({ file, log }).get().scannedAt, 123);

  store.close();
  store.get().scannedAt = 999;
  assert.equal(store.write(), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).scannedAt, 123);

  const broken = createCacheStore({ file, log, fs: { ...fs, renameSync: () => { throw new Error('EACCES'); } } });
  assert.equal(broken.write(), false);
  assert.ok(log.lines.error.some((l) => l.includes('EACCES')), 'write failure is logged');
  assert.deepEqual(fs.readdirSync(dir), ['cache.json']);
});
