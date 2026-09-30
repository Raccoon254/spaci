'use strict';
// A wall-clock scheduler for periodic work (background scans, update checks).
//
// Why not setInterval: a laptop that sleeps for eight hours comes back with a
// drifted interval (timers are paused or fired late) and, with several timers,
// a burst of catch-up runs. Instead the next run is always computed from the
// last *completed* run (which the caller persists), timers are capped at
// maxSleepMs so the clock is re-read regularly, and wake() collapses any number
// of resume events into a single check. At most one run is ever in flight.
//
// A run that throws never kills the scheduler: it is logged, counted as a
// failure, and retried with exponential backoff capped at the interval.
//
// Nothing here touches Electron. Clock, timers, conditions and the task are
// injected so node --test can drive it with a fake clock.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const DEFAULTS = {
  startupDelayMs: 30 * 1000,
  rescheduleDelayMs: 5 * 1000,
  resumeSettleMs: 60 * 1000,
  maxSleepMs: 15 * MIN,
  deferMs: 10 * MIN,
  retryBaseMs: 15 * MIN,
  futureSlackMs: 5 * MIN,
};

/** Clamp a user-supplied interval (hours) to something sane. */
function clampIntervalHours(v, fallback = 6) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(168, Math.max(1, n));
}

/**
 * When is the next run due?
 * A timestamp in the future (clock set back, or a cache copied from another
 * machine) is ignored, otherwise the scheduler would stall until then.
 */
function computeNextRun({ now, intervalMs, lastCompletedAt = 0, lastAttemptAt = 0, failures = 0,
  retryBaseMs = DEFAULTS.retryBaseMs, futureSlackMs = DEFAULTS.futureSlackMs }) {
  const valid = (t) => typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= now + futureSlackMs;
  let due = valid(lastCompletedAt) ? lastCompletedAt + intervalMs : now;
  if (failures > 0 && valid(lastAttemptAt)) {
    const backoff = Math.min(intervalMs, retryBaseMs * 2 ** Math.min(failures - 1, 20));
    due = Math.max(due, lastAttemptAt + backoff);
  }
  return due;
}

/**
 * Should a heavy background scan start right now? Pure: every input is passed
 * in (from Electron's powerMonitor and os.loadavg in the app).
 * @returns {{run: boolean, reason: string}}
 */
function backgroundGate({ enabled = true, onboarded = true, force = false, busy = false,
  onBattery = false, thermalState = 'unknown', loadRatio = 0, maxLoadRatio = 0.85 } = {}) {
  if (!enabled && !force) return { run: false, reason: 'disabled' };
  if (!onboarded && !force) return { run: false, reason: 'not-onboarded' };
  if (busy) return { run: false, reason: 'busy' };
  if (force) return { run: true, reason: 'forced' };
  if (onBattery) return { run: false, reason: 'on-battery' };
  if (thermalState === 'serious' || thermalState === 'critical') return { run: false, reason: 'thermal' };
  if (typeof loadRatio === 'number' && Number.isFinite(loadRatio) && loadRatio > maxLoadRatio) {
    return { run: false, reason: 'high-load' };
  }
  return { run: true, reason: 'due' };
}

/** Task outcomes that count as a completed run (resets the clock). */
const COMPLETED = new Set(['ok', 'partial']);
/** Task outcomes that are neither success nor failure: try again after deferMs. */
const DEFERRED = new Set(['busy', 'preempted', 'skipped', 'deferred']);

/**
 * @param {object} o
 * @param {() => Promise<{status:string}>} o.task
 * @param {() => {intervalMs:number}} o.getConfig
 * @param {(force:boolean) => {run:boolean, reason:string}} o.gate  decides whether to start now
 * @param {() => {lastCompletedAt:number,lastAttemptAt:number,failures:number}} o.getState
 * @param {(state:object) => void} o.saveState
 */
function createScheduler({
  name = 'scheduler', task, getConfig, gate = () => ({ run: true, reason: 'due' }),
  getState, saveState = () => {}, log = console,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, options = {},
}) {
  const opt = { ...DEFAULTS, ...options };
  let timer = null;
  let running = null;
  let started = false;
  let stopped = false;
  let lastDecision = null;

  function arm(delay) {
    if (stopped) return;
    if (timer) clearTimer(timer);
    const ms = Math.max(0, Math.min(delay, opt.maxSleepMs));
    timer = setTimer(() => { timer = null; tick(); }, ms);
  }

  function nextDue() {
    const cfg = getConfig();
    const st = getState() || {};
    return computeNextRun({ now: now(), intervalMs: cfg.intervalMs, ...st, retryBaseMs: opt.retryBaseMs, futureSlackMs: opt.futureSlackMs });
  }

  function tick() {
    if (stopped || running) return;
    let due;
    try { due = nextDue(); } catch (e) { log.error(`[${name}] could not compute next run:`, e); arm(opt.deferMs); return; }
    const t = now();
    if (t < due) { arm(due - t); return; }
    let decision;
    try { decision = gate(false); } catch (e) { log.error(`[${name}] gate failed:`, e); decision = { run: false, reason: 'gate-error' }; }
    lastDecision = { ...decision, at: t };
    if (!decision.run) {
      // Disabled: stay idle until reschedule() (a prefs change) wakes us up.
      if (decision.reason === 'disabled' || decision.reason === 'not-onboarded') return;
      log.info && log.info(`[${name}] due but deferred: ${decision.reason}`);
      arm(opt.deferMs);
      return;
    }
    execute();
  }

  function execute() {
    const startedAt = now();
    running = (async () => {
      let result;
      try {
        result = (await task()) || { status: 'ok' };
      } catch (e) {
        log.error(`[${name}] run failed:`, e);
        result = { status: 'failed', error: e };
      }
      const status = result.status;
      try {
        const st = { ...(getState() || {}) };
        const finished = now();
        if (COMPLETED.has(status)) {
          saveState({ ...st, lastCompletedAt: finished, lastAttemptAt: finished, failures: 0 });
        } else if (!DEFERRED.has(status) && status !== 'closed') {
          saveState({ ...st, lastAttemptAt: finished, failures: (st.failures || 0) + 1 });
        }
      } catch (e) {
        log.error(`[${name}] could not save state:`, e);
      }
      return { ...result, startedAt };
    })();
    // The wrapper above catches everything, so this promise never rejects.
    const p = running;
    p.then((res) => {
      if (running === p) running = null;
      if (stopped) return;
      if (DEFERRED.has(res.status)) arm(opt.deferMs);
      else tick();
    });
    return p;
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      arm(opt.startupDelayMs);
    },
    /** Settings changed: recompute soon (debounced), never immediately. */
    reschedule() { if (started && !stopped && !running) arm(opt.rescheduleDelayMs); },
    /** Resume from sleep, screen unlock, back on AC: one check after things settle. */
    wake() { if (started && !stopped && !running) arm(opt.resumeSettleMs); },
    /** Explicit user request. Joins a run in flight instead of starting a second. */
    runNow() {
      if (stopped) return Promise.resolve({ status: 'closed' });
      if (running) return running;
      const decision = gate(true);
      if (!decision.run) return Promise.resolve({ status: decision.reason === 'busy' ? 'busy' : 'skipped', reason: decision.reason });
      if (timer) { clearTimer(timer); timer = null; }
      return execute();
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    get running() { return running; },
    get armed() { return timer !== null; },
    get lastDecision() { return lastDecision; },
    nextDue,
  };
}

module.exports = { createScheduler, computeNextRun, backgroundGate, clampIntervalHours, DEFAULTS, HOUR, MIN };
