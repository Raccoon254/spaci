'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const log = require('../src/history-log');

test('count is what was really removed or trashed, not how many jobs were allowed', () => {
  const e = log.finishedEntry({
    id: 'x', at: 1, finishedAt: 2, scope: 'projects', label: 'app', requested: 5,
    items: [
      { path: '/a', kind: 'artifact', outcome: 'removed', bytes: 100, reversible: 'rebuild', restoreHint: 'npm ci' },
      { path: '/b', kind: 'file', outcome: 'trashed', bytes: 50, reversible: 'trash' },
      { path: '/c', kind: 'artifact', outcome: 'failed', bytes: 7, reversible: 'rebuild', reason: 'EACCES', code: 'EACCES' },
      { path: '/d', kind: 'cache', outcome: 'refused', bytes: 0, reversible: 'none', reason: 'needs-confirmation', restoreHint: 'nope' },
      { path: '/e', kind: 'artifact', outcome: 'failed', bytes: 0 },
    ],
  });
  assert.equal(e.v, 2);
  assert.equal(e.status, 'done');
  assert.equal(e.requested, 5);
  assert.equal(e.count, 2);
  assert.equal(e.failedCount, 2);
  assert.equal(e.refusedCount, 1);
  assert.equal(e.freed, 157, 'partial frees from a failed job are real space');
  assert.equal(e.items[2].code, 'EACCES');
  assert.equal(e.items[3].restoreHint, undefined, 'a refused item was never touched: no hint');
  assert.equal(e.itemsTruncated, undefined);
});

test('buildItem forces every field into its allowed set', () => {
  const it = log.buildItem({ path: '/x', kind: 'weird', outcome: 'maybe', bytes: NaN, reversible: true });
  assert.deepEqual(it, { path: '/x', kind: 'other', outcome: 'failed', bytes: 0, reversible: 'none' });
  assert.equal(log.buildItem({ path: '/x', bytes: -5 }).bytes, 0);
});

test('items are capped at 1000 with the overflow counted, and tallies cover every item', () => {
  const items = Array.from({ length: 1234 }, (_, i) => ({ path: '/f' + i, kind: 'artifact', outcome: 'removed', bytes: 1, reversible: 'rebuild' }));
  const e = log.finishedEntry({ id: 'x', at: 1, finishedAt: 2, items });
  assert.equal(e.items.length, 1000);
  assert.equal(e.itemsTruncated, 234);
  assert.equal(e.count, 1234);
  assert.equal(e.freed, 1234);
});

test("a 'started' entry becomes 'interrupted' on launch; pending work is reported as failed", () => {
  const started = log.startedEntry({
    id: 's', at: 10, scope: 'system', label: 'caches', requested: 3,
    refused: [{ path: '/r', kind: 'cache', reversible: 'none', reason: 'needs-confirmation' }],
    pending: [{ path: '/p1', kind: 'cache', reversible: 'rebuild', restoreHint: 'x' }, { path: '/p2', kind: 'artifact', reversible: 'rebuild', project: '/proj' }],
  });
  assert.equal(started.status, 'started');
  assert.equal(started.refusedCount, 1);
  assert.equal(started.count, 0);
  assert.deepEqual(started.pending.map((p) => p.path), ['/p1', '/p2']);
  const old = { at: 0, scope: 'projects', label: 'v1', count: 2, freed: 3, reversible: true, items: ['/x'] };
  const done = log.finishedEntry({ id: 'd', at: 1, finishedAt: 2, items: [] });

  const { history, changed } = log.markInterrupted([started, done, old], 99);
  assert.equal(changed, true);
  const [i] = history;
  assert.equal(i.status, 'interrupted');
  assert.equal(i.finishedAt, 99);
  assert.equal(i.pending, undefined);
  assert.equal(i.failedCount, 2);
  assert.equal(i.refusedCount, 1);
  assert.equal(i.count, 0);
  assert.equal(i.items.find((x) => x.path === '/p2').project, '/proj');
  assert.match(i.items.find((x) => x.path === '/p1').reason, /closed before this finished/);
  assert.equal(history[1], done);
  assert.equal(history[2], old, 'v1 entries are left alone');

  assert.equal(log.markInterrupted([done, old]).changed, false);
  assert.deepEqual(log.markInterrupted('junk'), { history: [], changed: false });
});

test('upsertEntry replaces by id, otherwise prepends, and keeps at most 200', () => {
  const a = { id: 'a', status: 'started' };
  let h = log.upsertEntry([], a);
  h = log.upsertEntry(h, { id: 'b' });
  h = log.upsertEntry(h, { id: 'a', status: 'done' });
  assert.deepEqual(h.map((e) => [e.id, e.status]), [['b', undefined], ['a', 'done']]);
  const many = Array.from({ length: 250 }, (_, i) => ({ id: String(i) }));
  assert.equal(log.upsertEntry(many, { id: 'new' }).length, 200);
  assert.equal(log.upsertEntry(null, { id: 'z' }).length, 1);
});

test('docker entries are v2 with main-decided reversibility', () => {
  const e = log.dockerEntry({ id: 1, at: 5, spec: { name: 'Build cache', safe: true }, freed: 10, restoreHint: 'Docker rebuilds this cache the next time you build.' });
  assert.deepEqual(
    [e.v, e.id, e.scope, e.label, e.count, e.requested, e.failedCount, e.refusedCount, e.freed, e.items, e.reversible, e.status, e.finishedAt],
    [2, '1', 'docker', 'Build cache', 1, 1, 0, 0, 10, [], 'rebuild', 'done', 5],
  );
  const s = log.dockerEntry({ id: 2, at: 5, spec: { name: 'Stopped containers', safe: false }, freed: 0 });
  assert.equal(s.reversible, 'none');
  assert.equal('restoreHint' in s, false);
});
