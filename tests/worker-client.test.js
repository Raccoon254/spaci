'use strict';
// The scan worker client (src/worker-client.js) against a fake in-process
// transport running the real dispatcher, and against a real child_process.fork
// of the worker (same message semantics as Electron's utilityProcess).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWorkerClient, forkTransport, workerEntryPath } = require('../src/worker-client');
const { createDispatcher } = require('../src/scan-worker-ops');
const { flush } = require('./fake-clock');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'scan-worker-fixture.js');
const quiet = { error() {}, warn() {}, info() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ops shared by the fake transport tests. */
function fakeOps(state) {
  const until = (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(true), { once: true }));
  return {
    echo: async (ctx, x) => x,
    progress: async (ctx, n) => { for (let i = 1; i <= n; i++) ctx.progress && ctx.progress({ i }); return n; },
    slow: async (ctx) => { state.signals.push(ctx.signal); await until(ctx.signal); return { partial: true }; },
    hang: (ctx) => { state.signals.push(ctx.signal); return new Promise(() => {}); },
    fail: async () => { const e = new Error('boom'); e.code = 'EBOOM'; throw e; },
  };
}

/** A worker in this process: messages are structured-cloned and delivered asynchronously. */
function fakeSpawner() {
  const state = { spawned: [], signals: [], posted: [] };
  const spawn = () => {
    let msgFn = () => {};
    let exitFn = () => {};
    let dead = false;
    const d = createDispatcher({
      send: (m) => { const c = structuredClone(m); setImmediate(() => { if (!dead) msgFn(c); }); },
      extraOps: fakeOps(state),
      log: quiet,
    });
    const t = {
      postMessage: (m) => { if (dead) throw new Error('dead'); state.posted.push(m); const c = structuredClone(m); setImmediate(() => { if (!dead) d.handle(c); }); },
      onMessage: (fn) => { msgFn = fn; },
      onExit: (fn) => { exitFn = fn; },
      kill: () => { t.killed = true; dead = true; d.abortAll(); setImmediate(() => exitFn(null)); },
      crash: (code) => { dead = true; d.abortAll(); exitFn(code); },
      killed: false,
      dispatcher: d,
    };
    state.spawned.push(t);
    return t;
  };
  return { spawn, state };
}

test('requests round-trip, errors keep their message and code, unknown ops are refused', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet });
  assert.equal(c.alive(), false, 'no worker until the first request');
  assert.deepEqual(await c.request('echo', [{ a: [1, 2], b: 'x' }]), { a: [1, 2], b: 'x' });
  await assert.rejects(c.request('fail'), (e) => e.message === 'boom' && e.code === 'EBOOM' && e.remote === true);
  await assert.rejects(c.request('nope'), (e) => e.code === 'EUNKNOWNOP');
  assert.equal(f.state.spawned.length, 1, 'one worker reused');
  c.close();
});

test('progress events are forwarded to the caller, in order, and only when asked for', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet });
  const seen = [];
  assert.equal(await c.request('progress', [3], { onProgress: (p) => seen.push(p.i) }), 3);
  assert.deepEqual(seen, [1, 2, 3]);
  await c.request('progress', [3]);
  assert.equal(f.state.posted.at(-1).progress, false, 'a caller without a listener gets no progress traffic');
  // A throwing progress handler does not break the request.
  assert.equal(await c.request('progress', [2], { onProgress: () => { throw new Error('window gone'); } }), 2);
  c.close();
});

test('a timeout aborts the op in the worker and rejects with ETIMEDOUT', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet, timeouts: { hang: 30 } });
  await assert.rejects(c.request('hang'), (e) => e.code === 'ETIMEDOUT' && /hang timed out/.test(e.message));
  await flush();
  assert.equal(f.state.signals[0].aborted, true, 'worker-side AbortController aborted');
  assert.equal(c.pending(), 0);
  // The worker is still usable.
  assert.equal(await c.request('echo', [1]), 1);
  c.close();
});

test('cancellation aborts the worker op and returns its partial result', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet });
  const ac = new AbortController();
  const p = c.request('slow', [], { signal: ac.signal });
  await flush();
  assert.equal(f.state.signals[0].aborted, false);
  ac.abort();
  assert.deepEqual(await p, { partial: true });
  assert.equal(f.state.signals[0].aborted, true);

  // Already aborted before the request: the op still runs, aborted at once.
  const ac2 = new AbortController();
  ac2.abort();
  assert.deepEqual(await c.request('slow', [], { signal: ac2.signal }), { partial: true });
  c.close();
});

test('an op that ignores abort is given up on after the grace period', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet, abortGraceMs: 20 });
  const ac = new AbortController();
  const p = c.request('hang', [], { signal: ac.signal });
  await flush();
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  c.close();
});

test('a worker crash mid-request fails what is in flight and the next request respawns', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet });
  const a = c.request('hang');
  const b = c.request('slow');
  await flush();
  f.state.spawned[0].crash(9);
  await assert.rejects(a, (e) => e.code === 'EWORKERCRASH' && /exit code 9/.test(e.message));
  await assert.rejects(b, (e) => e.code === 'EWORKERCRASH');
  assert.equal(c.alive(), false);
  assert.equal(await c.request('echo', ['again']), 'again');
  assert.equal(f.state.spawned.length, 2, 'respawned');
  assert.deepEqual({ ...c.stats(), pending: 0 }, { spawns: 2, crashes: 1, pending: 0, alive: true });
  c.close();
});

test('close() kills the worker at once, fails requests in flight, refuses new ones', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet });
  const a = c.request('hang');
  const b = c.request('slow');
  await flush();
  const t0 = Date.now();
  c.close();
  assert.equal(f.state.spawned[0].killed, true, 'killed synchronously');
  await assert.rejects(a, (e) => e.code === 'EWORKERCLOSED');
  await assert.rejects(b, (e) => e.code === 'EWORKERCLOSED');
  assert.ok(Date.now() - t0 < 100, 'nothing waited on the worker');
  await assert.rejects(c.request('echo', [1]), (e) => e.code === 'EWORKERCLOSED');
  assert.equal(f.state.spawned.length, 1, 'no respawn after close');
  await flush();
  assert.equal(c.stats().crashes, 0, 'a kill on purpose is not a crash');
});

test('stop() (quit, which may be cancelled) kills and fails in flight but a later request starts a new worker', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet });
  const a = c.request('hang');
  await flush();
  c.stop('quit');
  await assert.rejects(a, (e) => e.code === 'EWORKERSTOPPED' && /quit/.test(e.message));
  assert.equal(await c.request('echo', [2]), 2);
  assert.equal(f.state.spawned.length, 2);
  c.close();
});

test('an idle worker is stopped and started again on demand', async () => {
  const f = fakeSpawner();
  const c = createWorkerClient({ spawn: f.spawn, log: quiet, idleMs: 20 });
  await c.request('echo', [1]);
  assert.equal(c.alive(), true);
  await wait(60);
  assert.equal(c.alive(), false);
  assert.equal(f.state.spawned[0].killed, true);
  assert.equal(await c.request('echo', [2]), 2);
  assert.equal(c.stats().crashes, 0);
  c.close();
});

test('a worker that cannot start fails the request, not the process', async () => {
  const c = createWorkerClient({ spawn: () => { throw new Error('no utilityProcess'); }, log: quiet });
  await assert.rejects(c.request('echo', [1]), /no utilityProcess/);
  c.close();
});

// ---------- a real forked worker ----------

function realClient(entry, opts = {}) {
  const children = [];
  const c = createWorkerClient({
    spawn: () => { const t = forkTransport(entry); children.push(t.child); return t; },
    log: quiet,
    ...opts,
  });
  return { c, children };
}
const exited = (child) => (child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise((r) => child.once('exit', r)));

test('real fork: round trip, progress, error, timeout and cancellation', async () => {
  const { c, children } = realClient(FIXTURE, { timeouts: { hang: 150 } });
  try {
    assert.deepEqual(await c.request('echo', [{ big: 'x'.repeat(100000), n: [1, 2] }]), { big: 'x'.repeat(100000), n: [1, 2] });
    const seen = [];
    assert.equal(await c.request('progress', [4], { onProgress: (p) => seen.push(p.i) }), 4);
    assert.deepEqual(seen, [1, 2, 3, 4]);
    await assert.rejects(c.request('fail'), (e) => e.code === 'EBOOM');
    await assert.rejects(c.request('hang'), (e) => e.code === 'ETIMEDOUT');
    const ac = new AbortController();
    const p = c.request('slow', [60000], { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    assert.deepEqual(await p, { aborted: true, partial: true });
    assert.ok(Date.now() - t0 < 2000, 'the op stopped when aborted');
    assert.equal(children.length, 1);
  } finally { c.close(); }
  await exited(children[0]);
});

test('real fork: a crash mid-request fails it and the next request runs in a new process', async () => {
  const { c, children } = realClient(FIXTURE);
  try {
    const pid1 = await c.request('pid');
    const inflight = c.request('slow', [60000]);
    await assert.rejects(c.request('crash', [3]), (e) => e.code === 'EWORKERCRASH' && /exit code 3/.test(e.message));
    await assert.rejects(inflight, (e) => e.code === 'EWORKERCRASH');
    const pid2 = await c.request('pid');
    assert.notEqual(pid1, pid2);
    assert.equal(children.length, 2);
    assert.equal(c.stats().crashes, 1);
  } finally { c.close(); }
  await exited(children[1]);
});

test('real fork: close() with requests in flight returns at once and the process dies', async () => {
  const { c, children } = realClient(FIXTURE);
  await c.request('pid');
  const a = c.request('hang');
  const b = c.request('slow', [60000]);
  const t0 = Date.now();
  c.close();
  assert.ok(Date.now() - t0 < 50, 'close() does not wait');
  await assert.rejects(a, (e) => e.code === 'EWORKERCLOSED');
  await assert.rejects(b, (e) => e.code === 'EWORKERCLOSED');
  await exited(children[0]);
  assert.equal(children[0].signalCode, 'SIGKILL');
});

test('real fork of src/scan-worker.js: a project scan runs in the worker and carries languages, without node_modules', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-worker-'));
  const proj = path.join(dir, 'app');
  fs.mkdirSync(path.join(proj, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'app', dependencies: { react: '18' } }));
  fs.writeFileSync(path.join(proj, 'index.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(proj, 'node_modules', 'dep', 'big.py'), 'x = 1\n'.repeat(1000));
  const { c, children } = realClient(workerEntryPath(ROOT));
  try {
    const ping = await c.request('ping');
    assert.equal(ping.pid, children[0].pid, 'answered by the child, not this process');
    assert.notEqual(ping.pid, process.pid);
    const progress = [];
    const res = await c.request('scanProjects', [dir, { languages: true }], { onProgress: (p) => progress.push(p.phase) });
    assert.ok(progress.includes('done'));
    const p = res.projects.find((x) => x.path === proj);
    assert.ok(p, 'project found');
    assert.deepEqual(p.items.map((i) => i.name), ['node_modules']);
    assert.deepEqual(p.languages.map((l) => l.id), ['javascript'], 'node_modules content is not counted');
    assert.equal(p.primary.id, 'react');
    const e = await c.request('enrichProject', [proj]);
    assert.ok(e.totalSize > 0);
    assert.deepEqual(e.languages.map((l) => l.id), ['javascript']);
    assert.ok(Array.isArray(e.frameworks) && e.analysis);
    assert.deepEqual(await c.request('revalidateArtifact', ['relative/path']), { ok: false, reason: 'Not an absolute path.' });
    await assert.rejects(c.request('docker', ['parseSize', ['1GB']]), (err) => err.code === 'EUNKNOWNOP', 'not allowlisted');
  } finally {
    c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await exited(children[0]);
});

test('the worker entry resolves from app.getAppPath(), inside app.asar when packaged, and is packaged', () => {
  // app.getAppPath() in the packaged app, in this host's own path form (the
  // entry is joined with the host's separator, which is what Electron's asar
  // fs expects on each OS).
  if (process.platform === 'win32') {
    const asar = 'C:\\Users\\me\\AppData\\Local\\Programs\\Spaci\\resources\\app.asar';
    assert.equal(workerEntryPath(asar), 'C:\\Users\\me\\AppData\\Local\\Programs\\Spaci\\resources\\app.asar\\src\\scan-worker.js');
  } else if (process.platform === 'linux') {
    const asar = '/opt/Spaci/resources/app.asar';
    assert.equal(workerEntryPath(asar), '/opt/Spaci/resources/app.asar/src/scan-worker.js');
  } else {
    const asar = '/Applications/Spaci.app/Contents/Resources/app.asar';
    assert.equal(workerEntryPath(asar), '/Applications/Spaci.app/Contents/Resources/app.asar/src/scan-worker.js');
  }
  assert.ok(fs.existsSync(workerEntryPath(ROOT)), 'entry exists at the dev app path');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('src/**/*'), 'electron-builder packages src/**');
  const asarUnpack = [].concat(pkg.build.asarUnpack || []);
  assert.ok(!asarUnpack.some((g) => /scan-worker/.test(g)), 'loaded from inside the asar, not unpacked');
});
