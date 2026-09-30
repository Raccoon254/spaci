'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const il = require('../src/install-location');

const base = { platform: 'darwin', isPackaged: true, inApplications: false, prefs: {} };

test('offer only on a packaged macOS build outside Applications, and only once', () => {
  assert.equal(il.shouldOfferMove(base), true);
  assert.equal(il.shouldOfferMove({ ...base, platform: 'win32' }), false);
  assert.equal(il.shouldOfferMove({ ...base, platform: 'linux' }), false);
  assert.equal(il.shouldOfferMove({ ...base, isPackaged: false }), false, 'dev runs are never moved');
  assert.equal(il.shouldOfferMove({ ...base, inApplications: true }), false);
  assert.equal(il.shouldOfferMove({ ...base, inApplications: undefined }), false, 'unknown location: do not ask');
  for (const a of ['moved', 'declined', 'failed']) assert.equal(il.shouldOfferMove({ ...base, prefs: { [il.PREF]: a } }), false, a);
  assert.equal(il.shouldOfferMove({ ...base, prefs: { [il.PREF]: 'junk' } }), true);
});

test('conflicts: replace an idle older copy, never a running one', () => {
  assert.equal(il.conflictChoice('exists'), true);
  assert.equal(il.conflictChoice('existsAndRunning'), false);
});

function run(over) {
  const saved = [];
  const calls = { ask: 0, move: 0 };
  const outcome = il.offerMove({
    ...base,
    ask: () => { calls.ask++; return true; },
    move: () => { calls.move++; return true; },
    save: (p) => saved.push(p),
    ...over,
  });
  return { outcome, saved, calls };
}

test('offerMove records the answer before acting and reports what happened', () => {
  let r = run();
  assert.equal(r.outcome, 'moved');
  assert.deepEqual(r.saved, [{ [il.PREF]: 'moved' }]);
  r = run({ ask: () => false });
  assert.equal(r.outcome, 'declined');
  assert.deepEqual(r.saved, [{ [il.PREF]: 'declined' }]);
  r = run({ move: () => false });
  assert.equal(r.outcome, 'failed');
  assert.deepEqual(r.saved, [{ [il.PREF]: 'moved' }, { [il.PREF]: 'failed' }]);
  const logs = [];
  r = run({ move: () => { throw new Error('EACCES'); }, log: (m) => logs.push(m) });
  assert.equal(r.outcome, 'failed');
  assert.match(logs[0], /EACCES/);
  r = run({ ask: () => { throw new Error('no dialog'); } });
  assert.equal(r.outcome, 'declined', 'a prompt that fails counts as not now');
  r = run({ prefs: { [il.PREF]: 'declined' } });
  assert.equal(r.outcome, null);
  assert.deepEqual(r.calls, { ask: 0, move: 0 });
});
