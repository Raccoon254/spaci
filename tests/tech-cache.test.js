'use strict';
// The language analysis cache: key, LRU bound, validation, and that
// scanner.analyzeTech really hits it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tc = require('../src/tech-cache');

const HEAD = 'a'.repeat(40);
const entry = (over = {}) => ({
  head: HEAD, rootMtime: 1, manifests: [['package.json', 5]],
  result: { languages: [{ id: 'go' }], frameworks: [], primary: { id: 'go' }, analysis: { truncated: false } }, ...over,
});

test('key: resolved, trailing slashes and dot segments collapse; case folds only off Linux', () => {
  assert.equal(tc.techCacheKey('/Users/Me/app/', 'linux'), '/Users/Me/app');
  assert.equal(tc.techCacheKey('/Users/Me/x/../app', 'linux'), '/Users/Me/app');
  assert.equal(tc.techCacheKey('/Users/Me/app', 'darwin'), '/users/me/app');
  assert.equal(tc.techCacheKey('C:\\Code\\App\\', 'win32'), 'c:\\code\\app');
  for (const bad of ['', 'relative/dir', null, 42, '/a\0b']) assert.equal(tc.techCacheKey(bad, 'linux'), null);
});

test('LRU: bounded, evicts the least recently used, and a hit refreshes recency', () => {
  const lru = tc.createLru(3);
  lru.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(lru.get('a'), 1); // a is now the most recent
  lru.set('d', 4);
  assert.equal(lru.has('b'), false, 'b was least recently used');
  assert.deepEqual(lru.entries().map(([k]) => k), ['c', 'a', 'd']);
  lru.set('c', 30); // an update is a use too
  lru.set('e', 5);
  assert.deepEqual(lru.entries().map(([k]) => k), ['d', 'c', 'e']);
  assert.equal(lru.size, 3);
  assert.equal(lru.peek('d'), 4);
  assert.deepEqual(lru.entries().map(([k]) => k), ['d', 'c', 'e'], 'peek does not change the order');
  const big = tc.createLru(tc.TECH_CACHE_MAX);
  for (let i = 0; i < tc.TECH_CACHE_MAX + 50; i++) big.set('k' + i, i);
  assert.equal(big.size, tc.TECH_CACHE_MAX);
  assert.equal(big.has('k0'), false);
});

test('stampMatches: same HEAD in git; same folder mtime outside git', () => {
  assert.equal(tc.stampMatches(entry(), { head: HEAD, rootMtime: 99 }), true, 'mtime ignored under git');
  assert.equal(tc.stampMatches(entry(), { head: 'b'.repeat(40), rootMtime: 1 }), false);
  assert.equal(tc.stampMatches(entry({ head: null }), { head: null, rootMtime: 1 }), true);
  assert.equal(tc.stampMatches(entry({ head: null }), { head: null, rootMtime: 2 }), false);
  assert.equal(tc.stampMatches(null, { head: null, rootMtime: 1 }), false);
});

test('sanitizeEntry refuses malformed or partial entries from disk', () => {
  assert.ok(tc.sanitizeEntry(entry()));
  assert.ok(tc.sanitizeEntry(entry({ head: null })));
  const bad = [
    entry({ head: 'not-a-sha' }), entry({ rootMtime: 'x' }), entry({ manifests: 'x' }),
    entry({ manifests: [['/etc/passwd', 1]] }), entry({ manifests: [['../x', 1]] }), entry({ manifests: [['a', 'b']] }),
    entry({ result: null }), entry({ result: { languages: [], frameworks: [], analysis: { truncated: true } } }),
    null, 'x',
  ];
  for (const b of bad) assert.equal(tc.sanitizeEntry(b), null, JSON.stringify(b));
});

test('export and import round trip; memory wins; junk skipped; import is bounded', () => {
  const a = tc.createLru(10);
  a.set('/p/one', entry()).set('/p/two', entry({ head: null }));
  const snap = JSON.parse(JSON.stringify(tc.exportEntries(a)));
  const b = tc.createLru(10);
  b.set('/p/one', entry({ rootMtime: 7 }));
  const added = tc.importEntries(b, [...snap, ['relative', entry()], ['/p/bad', { head: 1 }], 'junk'], 'linux');
  assert.equal(added, 1);
  assert.equal(b.peek('/p/one').rootMtime, 7, 'the in-memory entry was kept');
  assert.equal(b.peek('/p/two').head, null);
  const small = tc.createLru(2);
  const many = Array.from({ length: 5 }, (_, i) => ['/q/' + i, entry()]);
  tc.importEntries(small, many, 'linux');
  assert.deepEqual(small.entries().map(([k]) => k), ['/q/3', '/q/4'], 'the newest entries of the snapshot');
  assert.equal(tc.importEntries(small, 'nope'), 0);
});

test('scanner.analyzeTech hits the cache: same folder and trailing slash hit, a changed manifest misses, and the entry is exported for main', async () => {
  const scanner = require('../src/scanner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-tech-'));
  try {
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/x\n\ngo 1.22\n');
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main\nfunc main() {}\n');
    const s0 = scanner.techCacheStats();
    const first = await scanner.analyzeTech(dir, undefined, { budgetMs: 10000 });
    assert.equal(first.primary && first.primary.id, 'go');
    const s1 = scanner.techCacheStats();
    assert.equal(s1.misses, s0.misses + 1);
    await scanner.analyzeTech(dir, undefined, { budgetMs: 10000 });
    await scanner.analyzeTech(dir + path.sep, undefined, { budgetMs: 10000 });
    const s2 = scanner.techCacheStats();
    assert.equal(s2.hits, s1.hits + 2, 'both repeat calls hit');
    assert.equal(s2.misses, s1.misses);
    // The snapshot main keeps carries this entry.
    const snap = scanner.exportTechCache();
    assert.ok(snap.some(([k]) => k === tc.techCacheKey(dir)));
    // A manifest that changed is a miss.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'go.mod'), later, later);
    await scanner.analyzeTech(dir, undefined, { budgetMs: 10000 });
    assert.equal(scanner.techCacheStats().misses, s2.misses + 1);
    assert.ok(scanner.techCacheStats().size <= scanner.techCacheStats().max);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
