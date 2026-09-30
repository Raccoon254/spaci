'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanService } = require('../src/background');
const { createScanCoordinator } = require('../src/scan-coordinator');
const { emptyCache } = require('../src/scan-cache');
const { deferred, flush, quietLog } = require('./fake-clock');

const project = (p, size = 10) => ({ path: p, name: p, items: [{ path: p + '/node_modules', size }], cleanableSize: size, mtime: 0 });

/** In-memory store that records every write as a JSON snapshot. */
function memStore() {
  const cache = emptyCache();
  let closed = false;
  const writes = [];
  return {
    get: () => cache,
    write() { if (closed) return false; writes.push(JSON.parse(JSON.stringify(cache))); return true; },
    close() { closed = true; },
    get closed() { return closed; },
    writes,
  };
}

/**
 * Scans that finish only when the test says so. Each call to scanProjects /
 * scanSystem queues a job; `jobs.projects[i].finish(value)` resolves it. Like
 * the real scanner, an aborted scan resolves with whatever it found so far.
 */
function harness(extra = {}) {
  const jobs = { projects: [], system: [] };
  const store = memStore();
  const log = quietLog();
  const emitted = [];
  const coordinator = createScanCoordinator({ log });
  let t = 1000;
  const mk = (kind) => (...args) => {
    const signal = args[args.length - 1];
    const d = deferred();
    const job = { args, signal, finish: d.resolve, fail: d.reject };
    jobs[kind].push(job);
    return d.promise;
  };
  const svc = createScanService({
    coordinator,
    store,
    scanProjects: mk('projects'),
    scanSystem: mk('system'),
    computeDocker: async (projects) => ({ ok: true, projects: projects.length, at: t }),
    getRoot: () => '/home',
    emit: (ch, p) => emitted.push([ch, p]),
    onCommitted: () => emitted.push(['tray']),
    log,
    now: () => ++t,
    ...extra,
  });
  return { svc, jobs, store, log, emitted, coordinator };
}

test('manual projects scan commits its result and reports it', async () => {
  const h = harness();
  const p = h.svc.manualProjects('/home', () => {});
  await flush();
  h.jobs.projects[0].finish({ projects: [project('/home/a'), { path: '/home/empty', items: [] }], scanned: 3 });
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.scanned, 3);
  assert.deepEqual(res.projects.map((x) => x.path), ['/home/a'], 'empty projects are dropped');
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.get().docker.ok, true);
  assert.ok(h.store.get().kindScannedAt.projects > 0);
  assert.ok(h.emitted.some(([ch]) => ch === 'tray'), 'tray refreshed');
});

test('a manual scan pre-empts a background scan, and the background result is never written', async () => {
  const h = harness();
  const bg = h.svc.backgroundRun();
  await flush();
  assert.equal(h.jobs.projects.length, 1);
  const manual = h.svc.manualProjects('/home', null);
  await flush();
  assert.equal(h.jobs.projects[0].signal.aborted, true, 'background scan aborted');

  h.jobs.projects[1].finish({ projects: [project('/home/new')] });
  assert.equal((await manual).ok, true);
  // The aborted background scan resolves late with a partial list.
  h.jobs.projects[0].finish({ projects: [project('/home/old-partial')] });
  const r = await bg;
  assert.equal(r.status, 'preempted');
  assert.deepEqual(h.store.get().projects.map((x) => x.path), ['/home/new']);
  for (const w of h.store.writes) {
    assert.ok(!w.projects.some((x) => x.path === '/home/old-partial'), 'partial background result was written');
  }
  assert.equal(h.jobs.system.length, 0, 'a pre-empted background run does not continue to the next phase');
});

test('two manual scans: the older one finishing last never overwrites, and its caller gets the newer result', async () => {
  const h = harness();
  const first = h.svc.manualProjects('/home', null);
  await flush();
  const second = h.svc.manualProjects('/home', null);
  await flush();
  h.jobs.projects[1].finish({ projects: [project('/home/newer')] });
  const r2 = await second;
  h.jobs.projects[0].finish({ projects: [project('/home/older')] });
  const r1 = await first;
  assert.deepEqual(r2.projects.map((x) => x.path), ['/home/newer']);
  assert.deepEqual(r1.projects.map((x) => x.path), ['/home/newer'], 'superseded caller reuses the newer result');
  assert.deepEqual(h.store.get().projects.map((x) => x.path), ['/home/newer']);
  assert.equal(h.store.writes.length, 1);
});

test('a superseded manual scan waits for the newer one when it has not finished yet', async () => {
  const h = harness();
  const first = h.svc.manualSystem(null);
  await flush();
  const second = h.svc.manualSystem(null);
  await flush();
  h.jobs.system[0].finish([{ id: 'old', size: 1 }]);
  let settled = false;
  first.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false, 'does not return stale data while the newer scan runs');
  h.jobs.system[1].finish([{ id: 'new', size: 2 }]);
  assert.deepEqual((await first).targets.map((x) => x.id), ['new']);
  assert.deepEqual((await second).targets.map((x) => x.id), ['new']);
  assert.deepEqual(h.store.get().system.map((x) => x.id), ['new']);
});

test('a background run while a manual scan runs skips the busy lanes', async () => {
  const h = harness();
  const mp = h.svc.manualProjects('/home', null);
  const ms = h.svc.manualSystem(null);
  await flush();
  const r = await h.svc.backgroundRun();
  assert.equal(r.status, 'busy');
  assert.equal(h.jobs.projects.length, 1, 'no second projects scan');
  assert.equal(h.jobs.system.length, 1, 'no second system scan');
  h.jobs.projects[0].finish({ projects: [] });
  h.jobs.system[0].finish([]);
  await Promise.all([mp, ms]);
});

test('a full background run commits projects then system, enriches and refreshes the breakdown', async () => {
  const enriched = [];
  let breakdowns = 0;
  const h = harness({
    enrichProject: async (dir) => { enriched.push(dir); return { totalSize: 5, git: null }; },
    refreshBreakdown: async () => { breakdowns++; return {}; },
  });
  const run = h.svc.backgroundRun();
  await flush();
  h.jobs.projects[0].finish({ projects: [project('/home/a', 5), project('/home/b', 50)] });
  await flush();
  h.jobs.system[0].finish([{ id: 'npm', size: 3, safe: true }]);
  const r = await run;
  assert.equal(r.status, 'ok');
  assert.deepEqual(enriched, ['/home/b', '/home/a'], 'largest first');
  assert.equal(breakdowns, 1);
  const c = h.store.get();
  assert.equal(c.system[0].id, 'npm');
  assert.equal(c.enrich['/home/b'].totalSize, 5);
  assert.ok(c.schedule.lastRun, 'run summary persisted');
  const bgEvents = h.emitted.filter(([ch]) => ch === 'bg:scan').map(([, p]) => p.active);
  assert.deepEqual(bgEvents, [true, false]);
});

test('a phase that throws is logged, the rest still runs, and the run is partial', async () => {
  const h = harness();
  const run = h.svc.backgroundRun();
  await flush();
  h.jobs.projects[0].fail(new Error('EACCES walking'));
  await flush();
  h.jobs.system[0].finish([{ id: 'npm', size: 1 }]);
  const r = await run;
  assert.equal(r.status, 'partial');
  assert.equal(r.errors[0].phase, 'projects');
  assert.ok(h.log.lines.error.some((l) => l.includes('EACCES')), 'error logged, not swallowed');
  assert.equal(h.store.get().system[0].id, 'npm');
  assert.deepEqual(h.emitted.filter(([ch]) => ch === 'bg:scan').map(([, p]) => p.active), [true, false]);
});

test('a run where every phase fails reports failed', async () => {
  const h = harness();
  const run = h.svc.backgroundRun();
  await flush();
  h.jobs.projects[0].fail(new Error('a'));
  await flush();
  h.jobs.system[0].fail(new Error('b'));
  const r = await run;
  assert.equal(r.status, 'failed');
  assert.equal(r.errors.length, 2);
});

test('quit mid-scan: scans are aborted and nothing is written afterwards', async () => {
  const h = harness({ enrichProject: async () => ({ totalSize: 1 }), refreshBreakdown: async () => assert.fail('breakdown after quit') });
  const run = h.svc.backgroundRun();
  const manual = h.svc.manualSystem(null);
  await flush();
  const writesBefore = h.store.writes.length;
  h.svc.close();
  assert.equal(h.jobs.projects[0].signal.aborted, true);
  assert.equal(h.jobs.system[0].signal.aborted, true);
  h.jobs.projects[0].finish({ projects: [project('/home/late')] });
  h.jobs.system[0].finish([{ id: 'late', size: 1 }]);
  assert.equal((await run).status, 'closed');
  assert.equal((await manual).ok, false);
  assert.equal(h.store.writes.length, writesBefore, 'a write happened after quit');
  assert.equal(h.store.get().projects.length, 0);
  assert.equal((await h.svc.backgroundRun()).status, 'closed');
  assert.equal((await h.svc.manualProjects('/home', null)).ok, false);
});

test('a user cancel keeps the partial manual result, as before', async () => {
  const h = harness();
  const p = h.svc.manualProjects('/home', null);
  await flush();
  h.svc.cancel('projects');
  h.jobs.projects[0].finish({ projects: [project('/home/partial')] });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.equal(h.store.get().meta.projects.partial, true);
});

test('a manual scan that throws returns an error and frees the lane', async () => {
  const h = harness();
  const p = h.svc.manualProjects('/home', null);
  await flush();
  h.jobs.projects[0].fail(new Error('disk gone'));
  const r = await p;
  assert.deepEqual(r, { ok: false, error: 'disk gone' });
  assert.equal(h.coordinator.busy('projects'), false);
  assert.ok(h.log.lines.error.length > 0);
});

test('writes land in start order even when scans finish out of order', async () => {
  const h = harness();
  const a = h.svc.manualProjects('/home', null);
  await flush();
  const b = h.svc.manualProjects('/home', null);
  await flush();
  const c = h.svc.manualProjects('/home', null);
  await flush();
  h.jobs.projects[2].finish({ projects: [project('/c')] });
  h.jobs.projects[0].finish({ projects: [project('/a')] });
  h.jobs.projects[1].finish({ projects: [project('/b')] });
  await Promise.all([a, b, c]);
  assert.deepEqual(h.store.writes.map((w) => w.projects[0].path), ['/c']);
});

test('watchdog expiry: a hung background scan that settles later never writes, and the lane is free', async () => {
  const h = harness();
  const run = h.svc.backgroundRun();
  await flush();
  const writesBefore = h.store.writes.length;
  h.svc.expireBackground();
  assert.equal(h.jobs.projects[0].signal.aborted, true);
  assert.equal(h.coordinator.busy('projects'), false, 'lane released');
  assert.deepEqual(h.emitted.filter(([ch]) => ch === 'bg:scan').map(([, p]) => p.active), [true, false]);
  // A new background run can start while the old one is still hung.
  const run2 = h.svc.backgroundRun();
  await flush();
  assert.equal(h.jobs.projects.length, 2);
  // The hung scan finally returns: nothing from it is written.
  h.jobs.projects[0].finish({ projects: [project('/home/stale')] });
  assert.equal((await run).status, 'expired');
  assert.equal(h.store.writes.length, writesBefore);
  h.jobs.projects[1].finish({ projects: [project('/home/fresh')] });
  await flush();
  h.jobs.system[0].finish([]);
  assert.equal((await run2).status, 'ok');
  assert.deepEqual(h.store.get().projects.map((x) => x.path), ['/home/fresh']);
});

// ---------- scan worker failure modes (the scans run in a worker process) ----------

test('a scan whose worker was stopped under it (cancel or quit) reports cancelled, not a failure', async () => {
  const h = harness();
  const p = h.svc.manualProjects('/home', () => {});
  await flush();
  h.svc.cancel('projects');
  h.jobs.projects[0].fail(Object.assign(new Error('The scan worker was stopped (quit).'), { code: 'EWORKERSTOPPED' }));
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.cancelled, true);
  assert.deepEqual(h.log.lines.error, [], 'not logged as a failure');
  assert.equal(h.store.writes.length, 0, 'nothing committed');
});

test('a superseded scan that fails on abort still hands its caller the newer result', async () => {
  const h = harness();
  const first = h.svc.manualSystem(() => {});
  await flush();
  const second = h.svc.manualSystem(() => {});
  await flush();
  assert.equal(h.jobs.system[0].signal.aborted, true);
  h.jobs.system[0].fail(Object.assign(new Error('scanSystem was aborted.'), { name: 'AbortError' }));
  h.jobs.system[1].finish([{ id: 'npm', size: 5, safe: true }]);
  const [r1, r2] = await Promise.all([first, second]);
  assert.deepEqual(r2.targets.map((t) => t.id), ['npm']);
  assert.deepEqual(r1.targets.map((t) => t.id), ['npm']);
});

test('a real worker error on a live scan is still reported as a failure', async () => {
  const h = harness();
  const p = h.svc.manualProjects('/home', null);
  await flush();
  h.jobs.projects[0].fail(Object.assign(new Error('The scan worker stopped unexpectedly (exit code 1).'), { code: 'EWORKERCRASH' }));
  const res = await p;
  assert.equal(res.ok, false);
  assert.match(res.error, /stopped unexpectedly/);
  assert.equal(h.store.writes.length, 0);
});

test('background enrichment stores languages, frameworks, primary and analysis with size and git', async () => {
  const { enrichRecord } = require('../src/background');
  const r = {
    totalSize: 7, git: { branch: 'main' },
    languages: [{ id: 'rust', name: 'Rust', percent: 100 }], frameworks: [{ id: 'axum', name: 'Axum' }],
    primary: { id: 'axum', name: 'Axum' }, analysis: { source: 'git', truncated: false },
  };
  const h = harness({ enrichProject: async () => r });
  const bg = h.svc.backgroundRun();
  await flush();
  h.jobs.projects[0].finish({ projects: [project('/home/a')] });
  await flush();
  h.jobs.system[0].finish([]);
  await bg;
  const e = h.store.get().enrich['/home/a'];
  assert.deepEqual({ ...e, at: 0 }, { ...enrichRecord(r, 0) });
  assert.deepEqual(e.languages, r.languages);
  assert.deepEqual(e.primary, r.primary);
  assert.deepEqual(enrichRecord({ totalSize: 1 }, 5), { totalSize: 1, git: null, languages: [], frameworks: [], primary: null, analysis: null, at: 5 });
});
