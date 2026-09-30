'use strict';
// The scan worker's dispatch logic (src/scan-worker-ops.js), in process.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDispatcher, attachLanguages, DOCKER_ALLOWLIST } = require('../src/scan-worker-ops');
const { flush } = require('./fake-clock');

function harness(modules, extraOps) {
  const out = [];
  const d = createDispatcher({ send: (m) => out.push(m), modules, extraOps, log: { error() {} } });
  const reply = async (id) => { for (let i = 0; i < 50; i++) { const r = out.find((m) => m.id === id && 'ok' in m); if (r) return r; await flush(); } return null; };
  return { d, out, reply };
}

test('scanProjects: progress only when asked, languages and primary attached to every project', async () => {
  const analyzed = [];
  const scanner = {
    scanProjects: async (root, onProgress, signal) => {
      assert.equal(signal instanceof AbortSignal, true);
      if (onProgress) onProgress({ phase: 'done', percent: 100 });
      return { projects: [{ path: '/r/a', primary: { id: 'javascript' } }, { path: '/r/b', primary: null }], scanned: 2 };
    },
    analyzeTech: async (dir, signal, opts) => {
      analyzed.push([dir, opts.budgetMs]);
      return dir === '/r/a'
        ? { languages: [{ id: 'typescript', percent: 100 }], primary: { id: 'nextjs', name: 'Next.js' } }
        : { languages: [], primary: null };
    },
  };
  const h = harness({ scanner });
  h.d.handle({ id: 1, op: 'scanProjects', args: ['/r', { languages: true }], progress: true });
  const r = await h.reply(1);
  assert.equal(r.ok, true);
  assert.deepEqual(h.out.filter((m) => 'progress' in m && !('ok' in m)), [{ id: 1, progress: { phase: 'done', percent: 100 } }]);
  assert.deepEqual(r.result.projects[0].languages, [{ id: 'typescript', percent: 100 }]);
  assert.deepEqual(r.result.projects[0].primary, { id: 'nextjs', name: 'Next.js' });
  assert.equal(r.result.projects[1].languages, undefined, 'no strip for nothing found');
  assert.equal(r.result.projects[1].primary, null);
  assert.deepEqual(analyzed.map((a) => a[0]).sort(), ['/r/a', '/r/b']);
  assert.ok(analyzed.every((a) => a[1] > 0 && a[1] <= 1000), 'bounded per project');

  h.d.handle({ id: 2, op: 'scanProjects', args: ['/r', { languages: false }] });
  await h.reply(2);
  assert.equal(analyzed.length, 2, 'languages: false skips the pass');
  assert.equal(h.out.filter((m) => m.id === 2 && 'progress' in m && !('ok' in m)).length, 0, 'no progress unless asked');
});

test('attachLanguages stops on abort and at the pass deadline, and survives analyzer errors', async () => {
  const projects = Array.from({ length: 20 }, (_, i) => ({ path: '/p' + i }));
  let t = 0;
  const scanner = { analyzeTech: async (dir) => { t += 10; if (dir === '/p1') throw new Error('bad'); return { languages: [{ id: 'go' }], primary: { id: 'go' } }; } };
  const n = await attachLanguages(scanner, projects, null, { now: () => t, passMs: 50 });
  assert.ok(n > 0 && n < 20, `stopped at the deadline (${n})`);
  assert.equal(projects[1].languages, undefined);
  const ac = new AbortController();
  ac.abort();
  assert.equal(await attachLanguages(scanner, [{ path: '/x' }], ac.signal), 0);
  assert.equal(await attachLanguages({}, [{ path: '/x' }], null), 0, 'no analyzer, no pass');
});

test('abort messages reach the op; a finished op ignores late aborts; unknown ops and junk are handled', async () => {
  let seen = null;
  const h = harness({}, {
    wait: (ctx) => new Promise((resolve) => { seen = ctx.signal; ctx.signal.addEventListener('abort', () => resolve('partial')); }),
  });
  h.d.handle({ id: 7, op: 'wait', args: [] });
  await flush();
  assert.equal(h.d.running(), 1);
  h.d.handle({ id: 7, abort: true });
  assert.equal(seen.aborted, true);
  assert.deepEqual(await h.reply(7), { id: 7, ok: true, result: 'partial' });
  assert.equal(h.d.running(), 0);
  h.d.handle({ id: 7, abort: true }); // late: nothing to do
  h.d.handle(null);
  h.d.handle({ op: 'x' });
  h.d.handle({ id: 8, op: 'constructor' });
  assert.equal((await h.reply(8)).error.code, 'EUNKNOWNOP', 'prototype names are not ops');
});

test('dockerSummary returns the card summary and only the attributed projects, by index', async () => {
  const scanner = {
    attachDockerUsage: async (list, options) => {
      assert.deepEqual(options, { force: true });
      list[1].docker = { dockerfiles: [], usage: { totalBytes: 5 } };
      return { inventory: { ok: true, approximate: false, status: { running: true }, categories: { images: {} }, totals: { bytes: 5 }, containers: new Array(1000).fill({}) } };
    },
  };
  const docker = { desktopDisk: async () => ({ bytes: 9 }) };
  const h = harness({ scanner, docker });
  h.d.handle({ id: 1, op: 'dockerSummary', args: [[{ path: '/a', docker: null }, { path: '/b' }], { force: true }] });
  const { result } = await h.reply(1);
  assert.equal(result.summary.ok, true);
  assert.equal(result.summary.projects, 1);
  assert.deepEqual(result.summary.desktopDisk, { bytes: 9 });
  assert.equal(result.summary.containers, undefined, 'heavy inventory lists stay in the worker');
  assert.deepEqual(result.attached, [{ index: 1, docker: { dockerfiles: [], usage: { totalBytes: 5 } } }]);

  const broken = harness({ scanner: { attachDockerUsage: async () => { throw new Error('daemon'); } }, docker });
  broken.d.handle({ id: 2, op: 'dockerSummary', args: [[]] });
  const r2 = await broken.reply(2);
  assert.equal(r2.result.summary.ok, false);
  assert.equal(r2.result.summary.reason, 'error');
});

test('generic docker routing: allowlisted names only, onProgress injected into the options argument', async () => {
  const calls = [];
  const docker = {
    restartDesktop: async (options) => { options.onProgress({ phase: 'quitting' }); calls.push(['restartDesktop', typeof options.onProgress]); return { ok: true }; },
    prune: async (kind, options) => { calls.push(['prune', kind, options]); return { ok: true, freed: 1 }; },
    desktopDisk: async (...args) => { calls.push(['desktopDisk', args]); return null; },
    parseSize: () => 1,
    secretHelper: async () => 'no',
  };
  const h = harness({ docker });
  h.d.handle({ id: 1, op: 'docker', args: ['restartDesktop', [{}]], progress: true });
  assert.equal((await h.reply(1)).ok, true);
  assert.ok(h.out.some((m) => m.id === 1 && m.progress && m.progress.phase === 'quitting'));
  h.d.handle({ id: 2, op: 'docker', args: ['prune', ['build-cache']] });
  assert.deepEqual((await h.reply(2)).result, { ok: true, freed: 1 });
  h.d.handle({ id: 3, op: 'docker', args: ['desktopDisk', []], progress: true });
  await h.reply(3);
  assert.deepEqual(calls, [['restartDesktop', 'function'], ['prune', 'build-cache', undefined], ['desktopDisk', []]],
    'no options object is invented for functions without one');
  for (const [i, name] of [[4, 'parseSize'], [5, 'secretHelper'], [6, '__proto__'], [7, 'listVolumes']]) {
    h.d.handle({ id: i, op: 'docker', args: [name, []] });
    assert.equal((await h.reply(i)).error.code, 'EUNKNOWNOP', name);
  }
  assert.deepEqual(Object.keys(DOCKER_ALLOWLIST).sort(), [
    'composeServices', 'desktopDisk', 'inventory', 'listVolumes', 'prune', 'removeVolume', 'resetCache', 'restartDesktop', 'status',
  ]);
});

test('scanProjects seeds the language cache from main and hands the snapshot back', async () => {
  const seeded = [];
  const scanner = {
    scanProjects: async () => ({ projects: [{ path: '/r/a' }] }),
    analyzeTech: async () => ({ languages: [], primary: null }),
    importTechCache: (snap) => { seeded.push(snap); return snap.length; },
    exportTechCache: () => [['/r/a', { head: null }]],
  };
  const h = harness({ scanner });
  h.d.handle({ id: 1, op: 'scanProjects', args: ['/r', { languages: true, techSeed: [['/r/a', { head: null }]] }] });
  const r = await h.reply(1);
  assert.equal(r.ok, true);
  assert.deepEqual(seeded, [[['/r/a', { head: null }]]]);
  assert.deepEqual(r.result.techCache, [['/r/a', { head: null }]]);
  // A seed that throws never fails the scan.
  scanner.importTechCache = () => { throw new Error('bad seed'); };
  h.d.handle({ id: 2, op: 'scanProjects', args: ['/r', { techSeed: [1] }] });
  assert.equal((await h.reply(2)).ok, true);
});
