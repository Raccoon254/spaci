'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanCoordinator, singleFlight, keyedSingleFlight } = require('../src/scan-coordinator');
const { deferred, quietLog } = require('./fake-clock');

const coord = () => createScanCoordinator({ log: quietLog() });

test('a manual scan supersedes a running background scan of the same kind', () => {
  const c = coord();
  const bg = c.begin('projects', 'background');
  const man = c.begin('projects', 'manual');
  assert.ok(bg && man);
  assert.equal(bg.signal.aborted, true);
  assert.equal(bg.reason, 'superseded');
  assert.equal(c.commit(bg, () => assert.fail('stale background result applied')), false);
  let applied = false;
  assert.equal(c.commit(man, () => { applied = true; }), true);
  assert.equal(applied, true);
});

test('a background scan never starts while any scan holds the lane', () => {
  const c = coord();
  const man = c.begin('system', 'manual');
  assert.equal(c.begin('system', 'background'), null);
  const bg = c.begin('projects', 'background');
  assert.ok(bg, 'other lanes are independent');
  assert.equal(c.begin('projects', 'background'), null, 'no second background scan');
  c.end(man);
  assert.ok(c.begin('system', 'background'));
});

test('an older manual scan finishing last cannot overwrite the newer one', () => {
  const c = coord();
  const first = c.begin('projects', 'manual');
  const second = c.begin('projects', 'manual');
  const order = [];
  assert.equal(c.commit(second, () => order.push('second')), true);
  assert.equal(c.commit(first, () => order.push('first')), false);
  assert.deepEqual(order, ['second']);
});

test('the same ticket cannot commit twice', () => {
  const c = coord();
  const t = c.begin('projects', 'manual');
  assert.equal(c.commit(t, () => {}), true);
  assert.equal(c.commit(t, () => assert.fail('double commit')), false);
});

test('a user cancel keeps a manual partial result but drops a background one', () => {
  const c = coord();
  const man = c.begin('projects', 'manual');
  const bg = c.begin('system', 'background');
  c.cancel();
  assert.equal(man.reason, 'cancelled');
  assert.equal(c.canCommit(man), true);
  assert.equal(c.canCommit(bg), false);
});

test('after quit nothing starts and nothing commits', () => {
  const c = coord();
  const t = c.begin('projects', 'manual');
  c.close();
  assert.equal(t.signal.aborted, true);
  assert.equal(t.reason, 'quit');
  assert.equal(c.commit(t, () => assert.fail('write after quit')), false);
  assert.equal(c.begin('projects', 'manual'), null);
  assert.equal(c.closed, true);
});

test('end() only clears the lane for the current ticket', () => {
  const c = coord();
  const a = c.begin('projects', 'manual');
  const b = c.begin('projects', 'manual');
  c.end(a);
  assert.equal(c.current('projects'), b);
  assert.equal(c.busy('projects'), true);
  c.end(b);
  assert.equal(c.busy(), false);
});

test('singleFlight shares one in-flight call and allows the next after it settles', async () => {
  let calls = 0;
  const d = deferred();
  const f = singleFlight(() => { calls++; return d.promise; });
  const p1 = f();
  const p2 = f();
  assert.equal(p1, p2);
  d.resolve(7);
  assert.equal(await p1, 7);
  const d2 = Promise.reject(new Error('boom'));
  d2.catch(() => {});
  const g = singleFlight(() => { calls++; return d2; });
  await assert.rejects(g(), /boom/);
  assert.equal(g.inflight(), null, 'a failure does not wedge it');
  assert.equal(calls, 2);
});

test('keyedSingleFlight dedupes per key only', async () => {
  const seen = [];
  const f = keyedSingleFlight(async (k) => { seen.push(k); return k; });
  const [a, b, c] = await Promise.all([f('/a'), f('/a'), f('/b')]);
  assert.deepEqual([a, b, c], ['/a', '/a', '/b']);
  assert.deepEqual(seen, ['/a', '/b']);
  await f('/a');
  assert.deepEqual(seen, ['/a', '/b', '/a']);
});
