'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createScheduler, computeNextRun, backgroundGate, clampIntervalHours, DEFAULTS, HOUR, MIN,
} = require('../src/scheduler');
const { fakeClock, deferred, flush, quietLog } = require('./fake-clock');

test('clampIntervalHours rejects junk and clamps to 1..168 hours', () => {
  assert.equal(clampIntervalHours(6), 6);
  assert.equal(clampIntervalHours('12'), 12);
  assert.equal(clampIntervalHours(0.1), 1);
  assert.equal(clampIntervalHours(10000), 168);
  for (const bad of [undefined, null, NaN, 'abc', 0, -3, Infinity, {}]) assert.equal(clampIntervalHours(bad), 6);
});

test('computeNextRun: from the last completed run, now when never run', () => {
  const now = 10 * HOUR;
  assert.equal(computeNextRun({ now, intervalMs: 6 * HOUR }), now);
  assert.equal(computeNextRun({ now, intervalMs: 6 * HOUR, lastCompletedAt: 8 * HOUR }), 14 * HOUR);
  assert.equal(computeNextRun({ now, intervalMs: 6 * HOUR, lastCompletedAt: 1 * HOUR }), 7 * HOUR, 'overdue means due');
});

test('computeNextRun ignores a timestamp from the future (clock moved back)', () => {
  const now = 10 * HOUR;
  assert.equal(computeNextRun({ now, intervalMs: 6 * HOUR, lastCompletedAt: now + 3 * 24 * HOUR }), now);
});

test('computeNextRun backs off after failures, capped at the interval', () => {
  const now = 100 * HOUR;
  const base = { now, intervalMs: 6 * HOUR, lastCompletedAt: 50 * HOUR, lastAttemptAt: now, retryBaseMs: 15 * MIN };
  assert.equal(computeNextRun({ ...base, failures: 1 }), now + 15 * MIN);
  assert.equal(computeNextRun({ ...base, failures: 2 }), now + 30 * MIN);
  assert.equal(computeNextRun({ ...base, failures: 3 }), now + 60 * MIN);
  assert.equal(computeNextRun({ ...base, failures: 50 }), now + 6 * HOUR);
});

test('backgroundGate: battery, heat, load, busy, disabled, force', () => {
  assert.deepEqual(backgroundGate({}), { run: true, reason: 'due' });
  assert.equal(backgroundGate({ enabled: false }).reason, 'disabled');
  assert.equal(backgroundGate({ onboarded: false }).reason, 'not-onboarded');
  assert.equal(backgroundGate({ onBattery: true }).reason, 'on-battery');
  assert.equal(backgroundGate({ thermalState: 'serious' }).reason, 'thermal');
  assert.equal(backgroundGate({ thermalState: 'critical' }).reason, 'thermal');
  assert.equal(backgroundGate({ thermalState: 'fair' }).run, true);
  assert.equal(backgroundGate({ loadRatio: 1.5 }).reason, 'high-load');
  assert.equal(backgroundGate({ loadRatio: NaN }).run, true, 'unknown load does not block');
  assert.equal(backgroundGate({ busy: true }).reason, 'busy');
  // An explicit request ignores battery and prefs, never a scan in progress.
  assert.equal(backgroundGate({ force: true, onBattery: true, enabled: false }).run, true);
  assert.equal(backgroundGate({ force: true, busy: true }).run, false);
});

/** A scheduler on a fake clock, with a task the test controls. */
function rig({ state = {}, intervalMs = 6 * HOUR, gate, task, options } = {}) {
  const clock = fakeClock();
  const log = quietLog();
  const runs = [];
  let st = { lastCompletedAt: 0, lastAttemptAt: 0, failures: 0, ...state };
  const conditions = { onBattery: false, enabled: true, onboarded: true, busy: false };
  const s = createScheduler({
    name: 'test',
    task: task || (async () => { runs.push(clock.now()); return { status: 'ok' }; }),
    getConfig: () => ({ intervalMs }),
    gate: gate || ((force) => backgroundGate({ ...conditions, force })),
    getState: () => st,
    saveState: (x) => { st = x; },
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    options,
  });
  return { s, clock, runs, log, conditions, state: () => st };
}

test('first run happens after the startup delay, never during startup', async () => {
  const r = rig();
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs - 1);
  assert.equal(r.runs.length, 0);
  await r.clock.advance(1);
  assert.equal(r.runs.length, 1);
  assert.equal(r.state().lastCompletedAt, r.clock.now());
});

test('a fresh cache is not rescanned at launch; the run waits for the interval', async () => {
  const r = rig();
  // Last completed 1 hour ago with a 6 hour interval.
  r.state().lastCompletedAt = r.clock.now() - HOUR;
  r.s.start();
  await r.clock.advance(5 * HOUR - 1000);
  assert.equal(r.runs.length, 0);
  await r.clock.advance(2000);
  assert.equal(r.runs.length, 1);
});

test('periodic runs are measured from the last completion, with no drift', async () => {
  const r = rig();
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  await r.clock.advance(3 * 6 * HOUR);
  assert.equal(r.runs.length, 4);
  for (let i = 1; i < r.runs.length; i++) assert.equal(r.runs[i] - r.runs[i - 1], 6 * HOUR);
});

test('sleep through several intervals: exactly one catch-up run after wake, not a burst', async () => {
  const r = rig();
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  assert.equal(r.runs.length, 1);
  await r.clock.advance(HOUR);
  r.clock.sleep(3 * 24 * HOUR); // three days asleep, twelve intervals missed
  // Several wake signals arrive (resume, unlock-screen, on-ac).
  r.s.wake(); r.s.wake(); r.s.wake();
  await r.clock.advance(DEFAULTS.resumeSettleMs + 1000);
  assert.equal(r.runs.length, 2, 'one catch-up run');
  await r.clock.advance(5 * HOUR);
  assert.equal(r.runs.length, 2, 'next run is a full interval after the catch-up');
  await r.clock.advance(HOUR);
  assert.equal(r.runs.length, 3);
});

test('without a wake event the capped timer still notices the clock jump within maxSleepMs', async () => {
  const r = rig();
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  r.clock.sleep(10 * HOUR);
  await r.clock.advance(DEFAULTS.maxSleepMs);
  assert.equal(r.runs.length, 2);
});

test('a task that throws does not kill the scheduler; it is logged and retried with backoff', async () => {
  let n = 0;
  const times = [];
  const r = rig({
    task: async () => { times.push(Date.now()); n++; if (n <= 2) throw new Error('scan blew up'); return { status: 'ok' }; },
    options: { retryBaseMs: 15 * MIN },
  });
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  assert.equal(n, 1);
  assert.equal(r.state().failures, 1);
  assert.ok(r.log.lines.error.some((l) => l.includes('scan blew up')));
  await r.clock.advance(15 * MIN - 1000);
  assert.equal(n, 1, 'no tight retry loop');
  await r.clock.advance(1000);
  assert.equal(n, 2);
  await r.clock.advance(30 * MIN);
  assert.equal(n, 3);
  assert.equal(r.state().failures, 0, 'success resets the failure count');
  assert.ok(r.state().lastCompletedAt > 0);
});

test('a failed status (not a throw) also backs off', async () => {
  let n = 0;
  const r = rig({ task: async () => { n++; return { status: 'failed' }; } });
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs + 2 * HOUR);
  // 15m, 30m, 60m retries fit in two hours after the first attempt: 4 runs.
  assert.equal(n, 4);
  assert.equal(r.state().failures, 4);
});

test('on battery: deferred, then runs once shortly after power returns', async () => {
  const r = rig();
  r.conditions.onBattery = true;
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs + 2 * HOUR);
  assert.equal(r.runs.length, 0);
  assert.equal(r.s.lastDecision.reason, 'on-battery');
  r.conditions.onBattery = false;
  r.s.wake(); // on-ac
  await r.clock.advance(DEFAULTS.resumeSettleMs);
  assert.equal(r.runs.length, 1);
});

test('busy (a manual scan running): deferred, not counted as a failure', async () => {
  const r = rig();
  r.conditions.busy = true;
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  assert.equal(r.runs.length, 0);
  r.conditions.busy = false;
  await r.clock.advance(DEFAULTS.deferMs);
  assert.equal(r.runs.length, 1);
  assert.equal(r.state().failures, 0);
});

test('a pre-empted run is retried after deferMs, without a failure', async () => {
  let n = 0;
  const r = rig({ task: async () => { n++; return { status: n === 1 ? 'preempted' : 'ok' }; } });
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  assert.equal(n, 1);
  assert.equal(r.state().failures, 0);
  await r.clock.advance(DEFAULTS.deferMs);
  assert.equal(n, 2);
});

test('disabled: no timer stays armed; reschedule() after enabling runs it', async () => {
  const r = rig();
  r.conditions.enabled = false;
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs + 24 * HOUR);
  assert.equal(r.runs.length, 0);
  assert.equal(r.s.armed, false);
  r.conditions.enabled = true;
  r.s.reschedule(); r.s.reschedule(); r.s.reschedule();
  await r.clock.advance(DEFAULTS.rescheduleDelayMs);
  assert.equal(r.runs.length, 1);
});

test('never two runs at once: runNow joins the run in flight', async () => {
  const d = deferred();
  let n = 0;
  const r = rig({ task: () => { n++; return d.promise; } });
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  assert.equal(n, 1);
  const joined = r.s.runNow();
  r.s.wake();
  await r.clock.advance(DEFAULTS.resumeSettleMs + DEFAULTS.maxSleepMs);
  assert.equal(n, 1);
  d.resolve({ status: 'ok' });
  assert.equal((await joined).status, 'ok');
});

test('runNow bypasses the battery gate but not a scan in progress', async () => {
  const r = rig();
  r.conditions.onBattery = true;
  r.s.start();
  await r.s.runNow();
  assert.equal(r.runs.length, 1);
  r.conditions.busy = true;
  assert.equal((await r.s.runNow()).status, 'busy');
  assert.equal(r.runs.length, 1);
});

test('stop(): no further runs, and a run that finishes after stop schedules nothing', async () => {
  const d = deferred();
  let n = 0;
  const r = rig({ task: () => { n++; return d.promise; } });
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  r.s.stop();
  d.resolve({ status: 'ok' });
  await flush();
  await r.clock.advance(7 * 24 * HOUR);
  assert.equal(n, 1);
  assert.equal(r.clock.pending(), 0);
  assert.equal((await r.s.runNow()).status, 'closed');
});

test('a throwing gate or state reader is logged and retried, not fatal', async () => {
  let fail = true;
  const r = rig({ gate: () => { if (fail) throw new Error('powerMonitor exploded'); return { run: true, reason: 'due' }; } });
  r.s.start();
  await r.clock.advance(DEFAULTS.startupDelayMs);
  assert.equal(r.runs.length, 0);
  assert.ok(r.log.lines.error.some((l) => l.includes('powerMonitor exploded')));
  fail = false;
  await r.clock.advance(DEFAULTS.deferMs);
  assert.equal(r.runs.length, 1);
});
