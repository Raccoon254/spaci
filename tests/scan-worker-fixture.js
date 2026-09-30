'use strict';
// A scan worker with extra, controllable ops, forked by tests/worker-client.test.js
// over child_process.fork (same message semantics as Electron's utilityProcess).
// Not a test file itself (the name does not match node --test's patterns).

const { startWorker } = require('../src/scan-worker-ops');

const wait = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(true); }, { once: true });
});

startWorker({
  extraOps: {
    echo: async (ctx, x) => x,
    pid: async () => process.pid,
    progress: async (ctx, n) => { for (let i = 1; i <= n; i++) { ctx.progress && ctx.progress({ i }); await wait(1); } return n; },
    // Like a scan: stops early on abort and returns what it has.
    slow: async (ctx, ms) => ({ aborted: await wait(ms, ctx.signal), partial: true }),
    // Ignores abort entirely.
    hang: () => new Promise(() => {}),
    fail: async () => { const e = new Error('boom'); e.code = 'EBOOM'; throw e; },
    crash: async (ctx, code) => { setImmediate(() => process.exit(code)); return new Promise(() => {}); },
  },
});
