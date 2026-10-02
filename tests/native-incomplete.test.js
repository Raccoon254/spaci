'use strict';
// Unfinished non-atomic native cleanups: recorded at start, cleared only when
// a clean of that target finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIncompleteStore, incompleteInfo } = require('../src/native-incomplete');

function memory(initial) {
  let v = initial;
  return { read: () => { if (v === undefined) throw new Error('ENOENT'); return JSON.parse(JSON.stringify(v)); }, write: (x) => { v = x; }, peek: () => v };
}

test('finding 3: a started non-atomic clean stays recorded until a clean finishes', () => {
  const m = memory();
  const s = createIncompleteStore({ ...m, now: () => 1000 });
  assert.equal(s.get('go-modcache'), null);
  s.start('go-modcache', 'go clean -modcache');
  assert.deepEqual(s.get('go-modcache'), { at: 1000, command: 'go clean -modcache' });
  // A new store over the same file (the next launch) still knows.
  const again = createIncompleteStore({ ...m });
  assert.deepEqual(again.list(), { 'go-modcache': { at: 1000, command: 'go clean -modcache' } });
  assert.deepEqual(incompleteInfo(again.get('go-modcache')), { at: 1000, command: 'go clean -modcache', message: 'Incomplete: run the clean again before building.' });
  again.finish('go-modcache');
  assert.equal(again.get('go-modcache'), null);
  assert.deepEqual(m.peek(), {});
});

test('finding 3: unknown ids and malformed records are ignored, write failures never throw', () => {
  const m = memory({ 'go-modcache': { at: 5, command: 'go clean -modcache' }, '__proto__': { at: 1 }, maven: { at: 1 }, uv: 'x', 'uv-cache': { at: 'soon' } });
  const s = createIncompleteStore(m);
  assert.deepEqual(Object.keys(s.list()), ['go-modcache']);
  s.start('rm -rf /', 'x');
  assert.equal(s.get('rm -rf /'), null);
  const broken = createIncompleteStore({ read: () => { throw new Error('bad json'); }, write: () => { throw new Error('disk full'); } });
  broken.start('uv-cache', 'uv cache clean');
  assert.equal(incompleteInfo(null), null);
});
