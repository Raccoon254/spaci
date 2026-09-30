'use strict';
// One lane per scan kind ('projects', 'system'): at most one scan of each kind
// runs at a time, and only the newest scan of a kind may write its result.
//
// Rules:
// - A manual scan always wins. Starting one aborts whatever runs in that lane
//   (an older manual scan or a background one) with reason 'superseded'.
// - A background scan never interrupts anything: if the lane is busy, begin()
//   returns null and the caller skips that phase.
// - commit() applies a result only when the ticket is still the lane's current
//   one, was not aborted (a user cancel of a manual scan is the exception: its
//   partial result is kept, as before), and is newer than the last committed
//   ticket of that kind. A slow older scan can never overwrite a newer result.
// - abortAll('quit') and close() stop everything; after close() nothing commits.

function createScanCoordinator({ log = console } = {}) {
  let seq = 0;
  let closed = false;
  const lanes = new Map();
  const committed = new Map();

  function makeTicket(kind, source) {
    const controller = new AbortController();
    const ticket = {
      id: ++seq,
      kind,
      source,
      reason: null,
      promise: null,
      signal: controller.signal,
      abort(reason) {
        if (controller.signal.aborted) return;
        ticket.reason = reason || 'aborted';
        controller.abort();
      },
    };
    return ticket;
  }

  return {
    get closed() { return closed; },

    /** @returns {object|null} a ticket, or null when the scan must not start. */
    begin(kind, source = 'manual') {
      if (closed) return null;
      const cur = lanes.get(kind);
      if (cur) {
        if (source === 'background') return null;
        log.info && log.info(`[scan] ${kind}: ${source} scan supersedes running ${cur.source} scan #${cur.id}`);
        cur.abort('superseded');
      }
      const t = makeTicket(kind, source);
      lanes.set(kind, t);
      return t;
    },

    /** Attach the promise that settles with this ticket's result, for callers that want to reuse it. */
    track(ticket, promise) { ticket.promise = promise; return promise; },

    current(kind) { return lanes.get(kind) || null; },

    isCurrent(ticket) { return !closed && lanes.get(ticket.kind) === ticket; },

    canCommit(ticket) {
      if (closed || lanes.get(ticket.kind) !== ticket) return false;
      if (ticket.signal.aborted && !(ticket.reason === 'cancelled' && ticket.source === 'manual')) return false;
      return ticket.id > (committed.get(ticket.kind) || 0);
    },

    commit(ticket, apply) {
      if (!this.canCommit(ticket)) return false;
      committed.set(ticket.kind, ticket.id);
      apply();
      return true;
    },

    end(ticket) { if (lanes.get(ticket.kind) === ticket) lanes.delete(ticket.kind); },

    busy(kind) { return kind ? lanes.has(kind) : lanes.size > 0; },

    /** User cancel: the lane (or every lane) stops, a manual scan keeps its partial result. */
    cancel(kind) {
      for (const [k, t] of lanes) if (!kind || k === kind) t.abort('cancelled');
    },

    abortAll(reason = 'quit') { for (const t of lanes.values()) t.abort(reason); },

    /**
     * Give up on every scan from `source` (a watchdog timeout): abort it and
     * free its lane now, so it can never commit even if it settles later.
     */
    expire(source, reason = 'timeout') {
      for (const [k, t] of [...lanes]) {
        if (t.source !== source) continue;
        t.abort(reason);
        lanes.delete(k);
      }
    },

    close() { closed = true; this.abortAll('quit'); },
  };
}

/** Collapse concurrent calls into one in-flight promise. */
function singleFlight(fn) {
  let inflight = null;
  const wrapped = (...args) => {
    if (inflight) return inflight;
    inflight = Promise.resolve().then(() => fn(...args)).finally(() => { inflight = null; });
    return inflight;
  };
  wrapped.inflight = () => inflight;
  return wrapped;
}

/** singleFlight per key (for example per project path). */
function keyedSingleFlight(fn) {
  const inflight = new Map();
  return (key, ...args) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = Promise.resolve().then(() => fn(key, ...args)).finally(() => { inflight.delete(key); });
    inflight.set(key, p);
    return p;
  };
}

module.exports = { createScanCoordinator, singleFlight, keyedSingleFlight };
