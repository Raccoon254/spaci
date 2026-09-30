'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attributeSystemData } = require('../src/diskbreakdown');

const GB = 1024 ** 3;

test('attributes each piece inside the category it lives in', () => {
  const r = attributeSystemData({
    cats: { appdata: 80 * GB, aitools: 18 * GB, developer: 70 * GB, xcode: 4 * GB, caches: 3 * GB, browsers: 2 * GB, system: 200 * GB, media: 25 * GB },
    dockerBytes: 58 * GB,
    devCacheBytes: 2 * GB,
    dotCacheBytes: 1 * GB,
    swapBytes: 6 * GB,
  });
  const by = Object.fromEntries(r.pieces.map((p) => [p.key, p.bytes]));
  assert.equal(by.docker, 58 * GB);
  assert.equal(by.aitools, 18 * GB);
  assert.equal(by.devcaches, 2 * GB);
  assert.equal(by.dotcache, 1 * GB);
  assert.equal(by.swap, 6 * GB);
  // app data loses the Docker image, caches lose ~/.cache, browsers are added
  assert.equal(by.appdata, (80 - 58) * GB + (3 - 1) * GB + 2 * GB);
  assert.equal(by.os, 194 * GB);
  // media and project source are not System Data
  assert.equal(r.estimate, r.pieces.reduce((a, p) => a + p.bytes, 0));
  assert.equal(r.estimate, (58 + 18 + 2 + 1 + 6 + 26 + 194) * GB);
});

test('a piece can never exceed the category that contains it', () => {
  const r = attributeSystemData({
    cats: { appdata: 10 * GB, system: 1 * GB, caches: 0 },
    dockerBytes: 50 * GB,
    swapBytes: 9 * GB,
    dotCacheBytes: 5 * GB,
  });
  const by = Object.fromEntries(r.pieces.map((p) => [p.key, p.bytes]));
  assert.equal(by.docker, 10 * GB);
  assert.equal(by.swap, 1 * GB);
  assert.equal(by.dotcache, undefined);
  assert.equal(by.os, undefined);
});

test('raw measurements follow the same scale factor as the categories', () => {
  const r = attributeSystemData({ cats: { appdata: 50 * GB }, factor: 0.5, dockerBytes: 60 * GB });
  assert.equal(r.pieces.find((p) => p.key === 'docker').bytes, 30 * GB);
});

test('snapshots report a count only, and none when there are none', () => {
  assert.deepEqual(attributeSystemData({ cats: { system: GB }, snapshots: { count: 3 } }).snapshots, { count: 3 });
  assert.equal(attributeSystemData({ cats: { system: GB }, snapshots: { count: 0 } }).snapshots, null);
  assert.equal(attributeSystemData({ cats: { system: GB } }).snapshots, null);
});

test('empty input gives an empty attribution', () => {
  const r = attributeSystemData({});
  assert.deepEqual(r.pieces, []);
  assert.equal(r.estimate, 0);
});

test('topChildren skips folders another category counts, and their ancestors', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { topChildren } = require('../src/diskbreakdown');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-tc-'));
  const mk = (rel, bytes) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); };
  mk('Library/Caches/a.bin', 200000);      // classified (caches)
  mk('Library/Mystery/b.bin', 300000);     // unclassified inside Library
  mk('.codex/sessions/c.bin', 400000);     // unclassified hidden folder
  mk('projects/app/d.bin', 500000);        // classified (projects)
  try {
    const items = await topChildren([root, path.join(root, 'Library')], 25, 20000,
      [path.join(root, 'Library', 'Caches'), path.join(root, 'projects')]);
    const names = items.map((i) => path.relative(root, i.path)).sort();
    assert.deepEqual(names, ['.codex', path.join('Library', 'Mystery')]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('APFS sibling volumes of the boot container are labelled, the Data volume is not', () => {
  const { parseApfsVolumes } = require('../src/diskbreakdown');
  const list = { Containers: [
    { ContainerReference: 'disk3', Volumes: [
      { Roles: ['System'], CapacityInUse: 13656313856 }, { Roles: ['Data'], CapacityInUse: 426e9 },
      { Roles: ['VM'], CapacityInUse: 9665884160 }, { Roles: ['Preboot'], CapacityInUse: 10879954944 },
      { Roles: [], CapacityInUse: 5 } ] },
    { ContainerReference: 'disk1', Volumes: [{ Roles: ['Preboot'], CapacityInUse: 6090752 }] },
  ] };
  assert.deepEqual(parseApfsVolumes(list, 'disk3').map((v) => v.name), ['macOS system files', 'Startup files (Preboot)', 'Swap (virtual memory)']);
});
