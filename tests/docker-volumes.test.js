'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dv = require('../src/docker-volumes');
const historyLog = require('../src/history-log');
const { dockerVolumes } = require('../src/scan-worker-ops');

const running = { state: 'running', running: true, remote: false };
const vol = (name, over = {}) => ({ name, sizeBytes: 1000, project: 'shop', inUse: false, containers: [], createdAt: '2026-01-01T00:00:00Z', anonymous: false, labels: { a: 'b' }, ...over });

test('volumesView: the IPC shape, grouped by project, bad names dropped', () => {
  const raw = {
    status: running,
    volumes: [vol('shop_db', { sizeBytes: 5000, inUse: true, containers: ['shop-db-1'] }), vol('shop_cache'), vol('-f'), vol('a'.repeat(64), { project: null, anonymous: true, sizeBytes: 7 })],
    groups: [{ key: 'shop', project: 'shop', volumes: ['shop_db', 'shop_cache', '-f'] }, { key: '(anonymous)', project: null, volumes: ['a'.repeat(64)] }],
  };
  const v = dv.volumesView(raw, 123);
  assert.equal(v.ok, true);
  assert.equal(v.at, 123);
  assert.deepEqual(v.volumes.map((x) => x.name), ['shop_db', 'shop_cache', 'a'.repeat(64)]);
  assert.deepEqual(v.volumes[0], { name: 'shop_db', size: 5000, project: 'shop', inUse: true, containers: ['shop-db-1'], createdAt: '2026-01-01T00:00:00Z', anonymous: false });
  assert.equal('labels' in v.volumes[0], false, 'only the contract fields');
  assert.deepEqual(v.groups, [
    { project: 'shop', label: 'shop', volumes: ['shop_db', 'shop_cache'], size: 6000, unusedSize: 1000, inUse: 1 },
    { project: null, label: 'Anonymous volumes', volumes: ['a'.repeat(64)], size: 7, unusedSize: 7, inUse: 0 },
  ]);
});

test('volumesView: engine down, not installed and remote contexts list nothing and say why', () => {
  const down = dv.volumesView({ status: { state: 'engine-down', running: false } });
  assert.deepEqual([down.ok, down.state, down.volumes, down.groups], [false, 'engine-down', [], []]);
  assert.match(down.error, /not running/);
  assert.match(dv.volumesView({ status: { state: 'not-installed', running: false } }).error, /not installed/);
  const remote = dv.volumesView({ status: { ...running, remote: true, endpoint: 'ssh://box' }, volumes: [vol('x')] });
  assert.equal(remote.ok, false);
  assert.match(remote.error, /ssh:\/\/box/);
  assert.equal(dv.volumesView(null).ok, false);
});

test('removalDecision: confirmation, name, allowlist and in-use gates', () => {
  const listing = dv.volumesView({ status: running, volumes: [vol('free'), vol('busy', { inUse: true })], groups: [] });
  assert.deepEqual(dv.removalDecision('free', { confirmed: true }, listing), { ok: true, volume: listing.volumes[0] });
  assert.equal(dv.removalDecision('free', {}, listing).error, 'needs-confirmation');
  assert.equal(dv.removalDecision('free', { confirmed: 'yes' }, listing).error, 'needs-confirmation', 'only true counts');
  assert.equal(dv.removalDecision('free', undefined, listing).error, 'needs-confirmation');
  assert.equal(dv.removalDecision('-f', { confirmed: true }, listing).error, 'invalid-name');
  assert.equal(dv.removalDecision('a b', { confirmed: true }, listing).error, 'invalid-name');
  assert.equal(dv.removalDecision(42, { confirmed: true }, listing).error, 'invalid-name');
  assert.equal(dv.removalDecision('other', { confirmed: true }, listing).error, 'unknown-volume');
  assert.equal(dv.removalDecision('free', { confirmed: true }, null).error, 'unknown-volume');
  assert.equal(dv.removalDecision('busy', { confirmed: true }, listing).error, 'in-use');
  for (const code of ['invalid-name', 'needs-confirmation', 'unknown-volume', 'in-use']) assert.ok(dv.REFUSAL_TEXT[code]);
});

test('restart only from the unresponsive state', () => {
  assert.equal(dv.canRestart('engine-down'), true);
  assert.equal(dv.canRestart('unresponsive'), true);
  for (const s of ['running', 'stopped', 'not-installed', 'no-permission', null, undefined]) assert.equal(dv.canRestart(s), false, String(s));
});

test('a removed volume is a permanent history v2 entry with its real size', () => {
  const e = historyLog.dockerVolumeEntry({ id: 'h1', at: 10, name: 'shop_db', project: 'shop', bytes: 5000 });
  assert.deepEqual(
    [e.v, e.scope, e.label, e.reversible, e.status, e.count, e.freed, e.failedCount, e.refusedCount, e.restoreHint],
    [2, 'docker', 'Docker volume shop_db', 'none', 'done', 1, 5000, 0, 0, undefined],
  );
  assert.deepEqual(e.items, [{ path: 'docker volume shop_db', kind: 'other', outcome: 'removed', bytes: 5000, reversible: 'none', project: 'shop' }]);
});

test('worker dockerVolumes: status, list and grouping in one round trip; nothing listed without a local engine', async () => {
  const calls = [];
  const docker = {
    status: async (o) => { calls.push(['status', o]); return running; },
    listVolumes: async (o) => { calls.push(['list', o.status === running]); return [vol('b', { sizeBytes: 1 }), vol('a', { sizeBytes: 9 })]; },
    groupVolumesByProject: require('../src/docker').groupVolumesByProject,
  };
  const r = await dockerVolumes(() => docker, { force: true });
  assert.deepEqual(calls, [['status', { force: true }], ['list', true]]);
  assert.deepEqual(r.groups, [{ key: 'shop', project: 'shop', volumes: ['a', 'b'] }]);
  assert.equal(r.volumes.length, 2);
  docker.status = async () => ({ ...running, remote: true });
  assert.deepEqual((await dockerVolumes(() => docker)).volumes, []);
  docker.status = async () => ({ state: 'stopped', running: false });
  assert.deepEqual((await dockerVolumes(() => docker)).groups, []);
});
