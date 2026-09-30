'use strict';
// Main-process client for the scan worker (src/scan-worker.js). Pure and
// injectable: the transport comes from `spawn`, so node --test drives it with a
// fake transport and with a real child_process.fork of the worker.
//
// Behaviour:
// - The worker starts on the first request and is reused.
// - Every request has a timeout. On timeout the worker is told to abort the op
//   and the caller gets an ETIMEDOUT error.
// - An aborted signal tells the worker to abort that op. The caller then gets
//   whatever the op returns (scans return their partial result), or an
//   AbortError if the worker has not answered within `abortGraceMs`.
// - If the worker exits unexpectedly, every request in flight fails with
//   EWORKERCRASH and the next request starts a new worker.
// - stop() kills the worker now and fails what is in flight (quit, which may
//   still be cancelled); close() does the same and refuses every later
//   request. Neither waits for the worker.
//
// A transport is { postMessage(msg), onMessage(fn), onExit(fn), kill() }.

const path = require('path');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const ABORT_GRACE_MS = 10 * 1000;

function workerError(message, code, name = 'Error') {
  const e = new Error(message);
  e.code = code;
  if (name !== 'Error') e.name = name;
  return e;
}

function remoteError(err) {
  const e = new Error((err && err.message) || 'The scan worker failed.');
  if (err && err.name && err.name !== 'Error') e.name = err.name;
  if (err && err.code) e.code = err.code;
  e.remote = true;
  return e;
}

const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };

/**
 * @param {object} d
 * @param {() => {postMessage:Function,onMessage:Function,onExit:Function,kill:Function}} d.spawn
 * @param {Record<string, number>} [d.timeouts]  per-op timeout in ms
 * @param {number} [d.defaultTimeoutMs]
 * @param {number} [d.abortGraceMs]  how long an aborted op may take to answer
 * @param {number} [d.idleMs]  stop an idle worker after this long (0: never)
 */
function createWorkerClient(d) {
  const {
    spawn, timeouts = {}, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, abortGraceMs = ABORT_GRACE_MS,
    idleMs = 0, log = console, setTimer = setTimeout, clearTimer = clearTimeout,
  } = d;
  let child = null; // { transport, dead }
  let seq = 0;
  let closed = false;
  let idleTimer = null;
  const pending = new Map();
  const stats = { spawns: 0, crashes: 0 };

  function clearIdle() { if (idleTimer) { clearTimer(idleTimer); idleTimer = null; } }
  function armIdle() {
    clearIdle();
    if (!idleMs || !child || pending.size) return;
    idleTimer = unref(setTimer(() => { idleTimer = null; if (!pending.size) killChild(); }, idleMs));
  }

  function killChild() {
    const c = child;
    child = null;
    if (!c) return;
    c.dead = true;
    try { c.transport.kill(); } catch (e) { log.warn && log.warn('[worker] kill failed:', e && e.message); }
  }

  function failAll(err) {
    for (const id of [...pending.keys()]) settle(id, err);
  }

  function ensure() {
    if (child) return child;
    const c = { transport: spawn(), dead: false };
    stats.spawns++;
    c.transport.onMessage((m) => { if (!c.dead && child === c) onMessage(m); });
    c.transport.onExit((code) => {
      if (c.dead) return; // killed on purpose
      c.dead = true;
      if (child === c) child = null;
      stats.crashes++;
      log.error && log.error(`[worker] scan worker exited unexpectedly (code ${code})`);
      failAll(workerError(`The scan worker stopped unexpectedly (exit code ${code}).`, 'EWORKERCRASH'));
    });
    child = c;
    return c;
  }

  function post(msg) {
    if (!child) return false;
    try { child.transport.postMessage(msg); return true; } catch (e) { return false; }
  }

  function settle(id, err, result) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (entry.timer) clearTimer(entry.timer);
    if (entry.graceTimer) clearTimer(entry.graceTimer);
    if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort);
    if (err) entry.reject(err); else entry.resolve(result);
    if (!pending.size) armIdle();
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    const entry = pending.get(m.id);
    if (!entry) return;
    if ('progress' in m && !('ok' in m)) {
      if (entry.onProgress) { try { entry.onProgress(m.progress); } catch (e) { log.warn && log.warn('[worker] progress handler failed:', e && e.message); } }
      return;
    }
    if (m.ok) settle(m.id, null, m.result);
    else settle(m.id, remoteError(m.error));
  }

  /**
   * Run `op(...args)` in the worker.
   * @param {string} op
   * @param {any[]} [args]  structured-clone safe arguments
   * @param {{signal?:AbortSignal, onProgress?:Function, timeoutMs?:number}} [opts]
   */
  function request(op, args = [], opts = {}) {
    const { signal = null, onProgress = null } = opts;
    if (closed) return Promise.reject(workerError('The scan worker is closed.', 'EWORKERCLOSED'));
    return new Promise((resolve, reject) => {
      let c;
      try { c = ensure(); } catch (e) { reject(e); return; }
      clearIdle();
      const id = ++seq;
      const entry = { id, op, resolve, reject, onProgress, signal, timer: null, graceTimer: null, onAbort: null };
      entry.onAbort = () => {
        if (!pending.has(id) || entry.graceTimer) return;
        post({ id, abort: true });
        entry.graceTimer = setTimer(() => settle(id, workerError(`${op} was aborted.`, 'ABORT_ERR', 'AbortError')), abortGraceMs);
      };
      const timeoutMs = opts.timeoutMs || timeouts[op] || defaultTimeoutMs;
      // Not unref'd: a request in flight is a reason to stay alive.
      entry.timer = setTimer(() => {
        post({ id, abort: true });
        settle(id, workerError(`${op} timed out after ${Math.round(timeoutMs / 1000)} s.`, 'ETIMEDOUT'));
      }, timeoutMs);
      pending.set(id, entry);
      if (signal) signal.addEventListener('abort', entry.onAbort, { once: true });
      try {
        c.transport.postMessage({ id, op, args, progress: Boolean(onProgress) });
      } catch (e) {
        settle(id, e);
        return;
      }
      if (signal && signal.aborted) entry.onAbort();
    });
  }

  return {
    request,
    /** Kill the worker now and fail what is in flight. The next request starts a new one. */
    stop(reason = 'stopped') {
      clearIdle();
      killChild();
      failAll(workerError(`The scan worker was stopped (${reason}).`, 'EWORKERSTOPPED'));
    },
    /** Kill the worker now; every later request is refused. Never waits. */
    close() {
      closed = true;
      clearIdle();
      killChild();
      failAll(workerError('The scan worker is closed.', 'EWORKERCLOSED'));
    },
    get closed() { return closed; },
    alive: () => Boolean(child),
    pending: () => pending.size,
    stats: () => ({ ...stats, pending: pending.size, alive: Boolean(child) }),
  };
}

/**
 * Path of the worker entry. Resolved from app.getAppPath() so it points inside
 * app.asar in a packaged build (utilityProcess.fork loads scripts from asar)
 * and at the project folder in development.
 */
function workerEntryPath(appPath) {
  return path.join(appPath, 'src', 'scan-worker.js');
}

/** Transport over Electron's utilityProcess (main process only). */
function utilityTransport(utilityProcess, modulePath, options = {}) {
  const child = utilityProcess.fork(modulePath, [], { serviceName: 'Spaci Scanner', stdio: 'inherit', ...options });
  // An unhandled 'error' event would throw in the main process.
  child.on('error', (e) => console.error('[worker] utility process error:', e && (e.message || e.type || e)));
  return {
    postMessage: (m) => child.postMessage(m),
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', fn),
    kill: () => child.kill(),
    child,
  };
}

/** Transport over child_process.fork (tests, and any plain Node host). */
function forkTransport(modulePath, options = {}) {
  const { fork } = require('child_process');
  const child = fork(modulePath, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'], ...options });
  child.on('error', () => { /* a send to a dying worker; its exit is reported separately */ });
  return {
    postMessage: (m) => { if (child.connected) child.send(m); else throw workerError('The scan worker is not connected.', 'EWORKERCRASH'); },
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code, sig) => fn(code == null ? sig : code)),
    kill: () => child.kill('SIGKILL'),
    child,
  };
}

module.exports = { createWorkerClient, workerEntryPath, utilityTransport, forkTransport, DEFAULT_TIMEOUT_MS, ABORT_GRACE_MS };
