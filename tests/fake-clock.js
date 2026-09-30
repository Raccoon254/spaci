'use strict';
// A deterministic clock and timer queue for scheduler tests. Not a test file
// itself (the name does not match node --test's patterns).

async function flush() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function fakeClock(start = Date.UTC(2026, 8, 30, 9, 0, 0)) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimer(fn, ms) {
      const h = { id: ++seq, at: t + Math.max(0, ms), fn };
      timers.set(h.id, h);
      return h;
    },
    clearTimer(h) { if (h) timers.delete(h.id); },
    pending: () => timers.size,
    nextAt: () => Math.min(...[...timers.values()].map((h) => h.at)),
    /** Let `ms` of awake time pass, firing timers in order. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        const due = [...timers.values()].filter((h) => h.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        t = Math.max(t, due.at);
        timers.delete(due.id);
        due.fn();
      }
      t = end;
      await flush();
    },
    /**
     * The laptop sleeps for `ms`: the wall clock jumps, but pending timers are
     * paused (they fire late, measured in awake time), as on macOS.
     */
    sleep(ms) {
      t += ms;
      for (const h of timers.values()) h.at += ms;
    },
  };
  return clock;
}

/** A promise with its resolve/reject exposed, to control when a fake scan ends. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A logger that records instead of printing. */
function quietLog() {
  const lines = { info: [], warn: [], error: [] };
  const rec = (k) => (...a) => lines[k].push(a.map((x) => (x && x.message) || String(x)).join(' '));
  return { info: rec('info'), warn: rec('warn'), error: rec('error'), lines };
}

module.exports = { fakeClock, deferred, flush, quietLog };
