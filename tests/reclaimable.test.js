'use strict';
// Issue #13: every figure equals what the matching clean would pass to the
// cleaner (or the prune would free). Snapshot-style checks on the project and
// recommendation models.

const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../src/reclaimable');
const { buildRecommendations, dockerRecommendations, fmt } = require('../src/recommendations');
const docker = require('../src/docker');
const historyLog = require('../src/history-log');
const { dockerSummary } = require('../src/scan-worker-ops');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const item = (name, size, safe) => ({ name, path: '/p/' + name, size, safe });
const project = (name, items, mtime = Date.now()) => ({ name, path: '/code/' + name, items, mtime });

// What the renderer's project action passes to api.clean (recommendations.js
// resolveAction: items with safe === true).
const jobsOf = (p) => p.items.filter((i) => i.safe === true);

test('projectFigures: only safe items are reclaimable, the rest is unverified', () => {
  const f = r.projectFigures([item('node_modules', 3 * GB, true), item('build', 2 * GB, false), item('dist', 1 * GB), null, item('x', -5, true)]);
  assert.deepEqual(f, { cleanableSize: 3 * GB, unverifiedSize: 3 * GB, cleanableCount: 2, unverifiedCount: 2 });
  assert.deepEqual(r.projectFigures(undefined), { cleanableSize: 0, unverifiedSize: 0, cleanableCount: 0, unverifiedCount: 0 });
  const p = r.withProjectFigures({ path: '/a', cleanableSize: 99, items: [item('a', 5, true), item('b', 7, false)] });
  assert.deepEqual([p.cleanableSize, p.unverifiedSize], [5, 7]);
  assert.deepEqual(r.cleanableItems(p).map((i) => i.name), ['a']);
});

test('recommendation snapshot: each project card equals the sum of the jobs its clean would send', () => {
  const projects = [
    // The 5.9 GB versus 3.8 GB case from the issue.
    project('shop', [item('node_modules', 3.8 * GB, true), item('build', 2.1 * GB, false)]),
    project('api', [item('target', 1 * GB, true), item('.next', 0.5 * GB, true)]),
    project('unverified-only', [item('vendor', 9 * GB, false)]),
    project('empty', []),
  ];
  const recs = buildRecommendations(projects, [], { staleDays: 60 }, null, {});
  const cards = recs.filter((x) => x.kind === 'project');
  assert.deepEqual(cards.map((c) => c.id), ['proj:/code/shop', 'proj:/code/api'], 'nothing to clean, no card');
  for (const c of cards) {
    const p = projects.find((x) => 'proj:' + x.path === c.id);
    assert.equal(c.savings, jobsOf(p).reduce((s, i) => s + i.size, 0), c.id);
    assert.equal(c.itemCount, jobsOf(p).length);
    assert.ok(c.title.includes(fmt(c.savings)), 'the title shows the same number');
  }
  assert.equal(cards[0].unverifiedSize, 2.1 * GB, 'unverified bytes reported apart');
  assert.equal(cards[1].unverifiedSize, 0);
  assert.match(cards[1].body, /^2 artifact folders \(target, \.next\)\.$/);
});

test('recommendation snapshot: system cards are safe targets only, sized as cleaned', () => {
  const sys = [
    { id: 'npm', name: 'npm cache', size: 2 * GB, safe: true, description: 'd' },
    { id: 'trash', name: 'Trash', size: 50 * GB, safe: false, description: 'd' },
    { id: 'tiny', name: 'Tiny', size: 10 * MB, safe: true, description: 'd' },
  ];
  const cards = buildRecommendations([], sys, {}, null, {}).filter((x) => x.kind === 'cache');
  assert.deepEqual(cards.map((c) => [c.id, c.savings]), [['sys:npm', 2 * GB]]);
});

// A real-shaped inventory: 2 GB build cache free, 4 GB of unused images of
// which 1.5 GB are dangling, 8 GB of unused volumes, 1 GB stopped containers.
function inventory({ detail = true } = {}) {
  const categories = {
    images: { count: 6, active: 2, size: 9 * GB, reclaimable: 4 * GB },
    containers: { count: 3, active: 1, size: 2 * GB, reclaimable: 1 * GB },
    volumes: { count: 5, active: 1, size: 10 * GB, reclaimable: 8 * GB },
    buildCache: { count: 40, active: 0, size: 2 * GB, reclaimable: 2 * GB },
  };
  const images = detail ? [
    { dangling: true, containers: 0, bytes: 1 * GB, uniqueBytes: 1 * GB },
    { dangling: true, containers: 0, bytes: 0.5 * GB, uniqueBytes: 0.5 * GB },
    { dangling: false, containers: 0, bytes: 2.5 * GB, uniqueBytes: 2.5 * GB },
    { dangling: false, containers: 1, bytes: 5 * GB, uniqueBytes: 5 * GB },
  ] : [];
  return { ok: true, partial: !detail, status: { state: 'running', running: true }, categories, totals: docker.totalsOf(categories), images, containers: [], volumes: [], buildCache: [] };
}

test('docker figures: the headline excludes volumes and containers', () => {
  const f = r.dockerFigures(inventory().categories, inventory().images);
  assert.deepEqual(f, {
    bytes: 6 * GB, buildCache: 2 * GB, images: 4 * GB, danglingImages: 1.5 * GB, danglingKnown: true,
    notCounted: { volumes: 8 * GB, containers: 1 * GB },
  });
  assert.ok(f.bytes < docker.totalsOf(inventory().categories).reclaimable, 'less than Docker own reclaimable, which counts volumes');
  const noDetail = r.dockerFigures(inventory({ detail: false }).categories, []);
  assert.equal(noDetail.danglingImages, null, 'unknown, not guessed');
  assert.equal(noDetail.danglingKnown, false);
});

test('worker docker summary carries the honest figures and detail-sized suggestions', async () => {
  const inv = inventory();
  const mod = (name) => (name === 'scanner'
    ? { attachDockerUsage: async () => ({ inventory: inv }) }
    : { desktopDisk: async () => null, reclaimSuggestions: docker.reclaimSuggestions });
  const { summary } = await dockerSummary(mod, [], {});
  assert.equal(summary.cleanable.bytes, 6 * GB);
  const dangling = summary.suggestions.find((s) => s.kind === 'dangling-images');
  assert.equal(dangling.savings, 1.5 * GB, 'sized from the per-image detail');
  assert.equal(dangling.estimated, false);
  const recs = dockerRecommendations(summary, { pruneKinds: docker.PRUNE_KINDS });
  assert.deepEqual(recs.map((x) => [x.id, x.savings, x.safe, x.reversible]), [
    ['docker:build-cache', 2 * GB, true, true],
    ['docker:dangling-images', 1.5 * GB, true, true],
  ], 'no card for volumes, containers or the opt-in unused-images prune');
});

test('docker recommendations: no dangling card when its size would be a guess', () => {
  const info = { ...inventory({ detail: false }), images: [] };
  const recs = dockerRecommendations(info, { reclaimSuggestions: docker.reclaimSuggestions, pruneKinds: docker.PRUNE_KINDS });
  assert.deepEqual(recs.map((x) => x.id), ['docker:build-cache']);
});

test('docker kinds: reversible is explicit; unused images and stopped containers are permanent in history', () => {
  const K = docker.PRUNE_KINDS;
  assert.deepEqual(Object.values(K).map((k) => [k.id, k.safe, k.reversible]), [
    ['build-cache', true, true], ['dangling-images', true, true],
    ['stopped-containers', false, false], ['unused-images', false, false],
  ]);
  const rev = (kind) => historyLog.dockerEntry({ id: kind, at: 1, spec: K[kind], freed: 1 }).reversible;
  assert.deepEqual(['build-cache', 'dangling-images', 'stopped-containers', 'unused-images'].map(rev), ['rebuild', 'rebuild', 'none', 'none']);
});

test('grand total: safe project items, safe system targets and the Docker headline', () => {
  const projects = [project('a', [item('node_modules', 5, true), item('build', 100, false)])];
  const system = [{ id: 's', size: 7, safe: true }, { id: 't', size: 1000, safe: false }];
  assert.equal(r.grandTotal({ projects, system }), 12);
  assert.equal(r.grandTotal({ projects, system, docker: { ok: true, cleanable: { bytes: 30 } } }), 42);
  assert.equal(r.grandTotal({ projects, system, docker: { ok: false, cleanable: { bytes: 30 } } }), 12);
  assert.equal(r.systemReclaimable(system), 7);
});

test('worktree card: counts removable worktrees, and its savings never repeat their build output', () => {
  const repo = (name, removable) => ({ ...project(name, [item('node_modules', 1 * GB, true)]), repo: { worktrees: [], removable } });
  const projects = [
    repo('mail', { count: 3, bytes: 2 * GB, extraBytes: 0.5 * GB }),
    repo('site', { count: 1, bytes: 300 * MB, extraBytes: 300 * MB }),
    repo('quiet', { count: 0, bytes: 0, extraBytes: 0 }),
  ];
  const recs = buildRecommendations(projects, [], { staleDays: 60 }, null, {});
  const card = recs.find((x) => x.kind === 'worktrees');
  assert.ok(card);
  assert.equal(card.itemCount, 4);
  assert.equal(card.repos, 2);
  assert.equal(card.totalBytes, 2 * GB + 300 * MB);
  assert.equal(card.savings, 0.5 * GB + 300 * MB, 'only the bytes beyond build output already counted');
  assert.equal(card.action.type, 'remove-worktrees');
  assert.equal(card.safe, false, 'never presented as Safe');
  assert.doesNotMatch(card.title + card.body, /—/);
  const none = buildRecommendations([repo('quiet', { count: 0, bytes: 0, extraBytes: 0 })], [], {}, null, {});
  assert.equal(none.some((x) => x.kind === 'worktrees'), false);
});
