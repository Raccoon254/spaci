'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const docker = require('../src/docker');

// A fake execFile. `replies` maps the first two docker arguments to
// { stdout } or { error }, so no test needs a Docker daemon.
function fakeExec(replies) {
  return (file, args, opts, cb) => {
    const key = args.slice(0, 2).join(' ');
    const reply = replies[key];
    if (!reply) return cb(Object.assign(new Error('unexpected: ' + key), { code: 'ENOENT' }), '', '');
    if (reply.error) return cb(reply.error, reply.stdout || '', reply.stderr || '');
    cb(null, reply.stdout || '', '');
  };
}

const VERSION_OK = JSON.stringify({
  Client: { Version: '29.5.2' },
  Server: { Version: '29.6.1', Platform: { Name: 'Docker Desktop 4.81.0' } },
});

// Shape copied verbatim from `docker system df --format json` on a real daemon.
const DF_SUMMARY = [
  '{"Active":"2","Reclaimable":"12.48GB (75%)","Size":"16.45GB","TotalCount":"49","Type":"Images"}',
  '{"Active":"2","Reclaimable":"20.48kB (45%)","Size":"45.06kB","TotalCount":"3","Type":"Containers"}',
  '{"Active":"2","Reclaimable":"3.74GB (98%)","Size":"3.791GB","TotalCount":"111","Type":"Local Volumes"}',
  '{"Active":"0","Reclaimable":"5.765GB","Size":"14.16GB","TotalCount":"257","Type":"Build Cache"}',
].join('\n');

const DF_VERBOSE = JSON.stringify({
  Images: [
    { ID: 'sha256:aaa', Repository: 'taifa-support-api', Tag: 'latest', Size: '608MB', UniqueSize: '405.3MB', SharedSize: '202.4MB', Containers: '1' },
    { ID: 'sha256:bbb', Repository: '<none>', Tag: '<none>', Size: '512MB', UniqueSize: '512MB', SharedSize: '0B', Containers: '0' },
  ],
  Containers: [
    {
      ID: 'c1', Names: 'taifa-support-postgres-1', Image: 'taifa-support-api:latest',
      State: 'running', Status: 'Up 3 hours', Size: '45.1kB (virtual 608MB)',
      Labels: 'com.docker.compose.project=taifa-support,com.docker.compose.service=api,com.docker.compose.project.working_dir=/Users/dev/projects/taifa-support',
    },
    {
      ID: 'c2', Names: 'old-worker', Image: 'ghost:1',
      State: 'exited', Status: 'Exited (0) 2 weeks ago', Size: '120MB (virtual 300MB)',
      Labels: '',
    },
  ],
  Volumes: [
    { Name: 'taifa-support_pgdata', Size: '1.2GB', Links: '1', Labels: 'com.docker.compose.project=taifa-support,com.docker.compose.volume=pgdata' },
    { Name: 'orphan', Size: '800MB', Links: '0', Labels: 'com.docker.volume.anonymous=' },
  ],
  BuildCache: [
    { ID: 'b1', CacheType: 'regular', Size: '2.5GB', InUse: false, Shared: false, LastUsedSince: '3 weeks ago' },
    { ID: 'b2', CacheType: 'regular', Size: '500MB', InUse: true, Shared: false, LastUsedSince: '1 hour ago' },
  ],
});

test.beforeEach(() => docker.resetCache());

test('sizes parse in the units docker actually prints', () => {
  assert.equal(docker.parseSize('12.48GB'), 12480000000);
  assert.equal(docker.parseSize('20.48kB'), 20480);
  assert.equal(docker.parseSize('0B'), 0);
  assert.equal(docker.parseSize('1.5MiB'), 1572864);
  // Anything unusable counts as zero rather than NaN, which would poison totals.
  assert.equal(docker.parseSize('N/A'), 0);
  assert.equal(docker.parseSize(''), 0);
  assert.equal(docker.parseSize(undefined), 0);
  assert.equal(docker.parseSize('lots'), 0);
});

test('reclaimable keeps the bytes and the percentage apart', () => {
  assert.deepEqual(docker.parseReclaimable('12.48GB (75%)'), { bytes: 12480000000, percent: 75 });
  // Build cache reports no percentage.
  assert.deepEqual(docker.parseReclaimable('5.765GB'), { bytes: 5765000000, percent: null });
  assert.deepEqual(docker.parseReclaimable(''), { bytes: 0, percent: null });
});

test('labels split on the first = so values keeping an = survive', () => {
  const labels = docker.parseLabels('a=1,com.docker.compose.project=web,cmd=sh -c x=1');
  assert.equal(labels.a, '1');
  assert.equal(labels['com.docker.compose.project'], 'web');
  assert.equal(labels.cmd, 'sh -c x=1');
  assert.deepEqual(docker.parseLabels(''), {});
  assert.deepEqual(docker.parseLabels(undefined), {});
});

test('summary totals match what docker itself reports', () => {
  const cats = docker.parseSummary(DF_SUMMARY);
  assert.equal(cats.images.count, 49);
  assert.equal(cats.images.size, 16450000000);
  assert.equal(cats.images.reclaimable, 12480000000);
  assert.equal(cats.images.percent, 75);
  assert.equal(cats.volumes.count, 111);
  assert.equal(cats.buildCache.reclaimable, 5765000000);
  const totals = docker.totalsOf(cats);
  assert.equal(totals.size, 16450000000 + 45060 + 3791000000 + 14160000000);
});

test('verbose inventory keeps compose labels and marks danglers', () => {
  const inv = docker.parseInventory(DF_VERBOSE);
  assert.equal(inv.images.length, 2);
  assert.equal(inv.images[0].bytes, 608000000);
  assert.equal(inv.images[0].dangling, false);
  assert.equal(inv.images[1].dangling, true);

  const [running, stopped] = inv.containers;
  assert.equal(running.project, 'taifa-support');
  assert.equal(running.workingDir, '/Users/dev/projects/taifa-support');
  assert.equal(running.service, 'api');
  assert.equal(running.running, true);
  // Only the writable layer counts; the "(virtual ...)" part is the image.
  assert.equal(running.bytes, 45100);
  assert.equal(stopped.running, false);
  assert.equal(stopped.project, null);

  assert.equal(inv.volumes[0].project, 'taifa-support');
  assert.equal(inv.volumes[1].anonymous, true);
  assert.equal(inv.buildCache[0].inUse, false);
  assert.equal(inv.buildCache[1].inUse, true);
});

test('unreadable inventory output is null, never a throw', () => {
  assert.equal(docker.parseInventory('not json'), null);
  assert.equal(docker.parseInventory(''), null);
});

test('derived reclaimable counts only what nothing is using', () => {
  const cats = docker.summarise(docker.parseInventory(DF_VERBOSE));
  // The image with a container is in use; the dangling one is not.
  assert.equal(cats.images.reclaimable, 512000000);
  assert.equal(cats.images.active, 1);
  // Stopped container's writable layer.
  assert.equal(cats.containers.reclaimable, 120000000);
  // The unlinked volume only.
  assert.equal(cats.volumes.reclaimable, 800000000);
  // The cache entry not in use only.
  assert.equal(cats.buildCache.reclaimable, 2500000000);
});

test('engine storage is attributed to the directory compose was started from', () => {
  const inv = { ok: true, ...docker.parseInventory(DF_VERBOSE) };
  const byDir = docker.usageByProject(inv);
  const usage = byDir.get('/Users/dev/projects/taifa-support');

  assert.ok(usage, 'expected the compose working_dir to be a key');
  assert.equal(usage.project, 'taifa-support');
  assert.equal(usage.containers.length, 1);
  assert.equal(usage.images.length, 1);
  assert.equal(usage.volumes.length, 1, 'compose volumes attach through the project name');
  assert.equal(usage.volumeBytes, 1200000000);
  assert.equal(usage.totalBytes, 45100 + 608000000 + 1200000000);
  // A container with no compose labels belongs to no project.
  assert.equal(byDir.size, 1);
});

test('usageByProject is empty rather than broken without an inventory', () => {
  assert.equal(docker.usageByProject(null).size, 0);
  assert.equal(docker.usageByProject({ ok: false }).size, 0);
});

test('project detection reads the listing the scanner already has', () => {
  assert.equal(docker.detect(['package.json', 'src']), null);
  assert.equal(docker.detect([]), null);

  const compose = docker.detect(['compose.yaml', 'package.json']);
  assert.equal(compose.compose, true);
  assert.deepEqual(compose.composeFiles, ['compose.yaml']);

  const full = docker.detect(['Dockerfile', 'Dockerfile.dev', 'docker-compose.yml', '.dockerignore', '.devcontainer']);
  assert.deepEqual(full.dockerfiles, ['Dockerfile', 'Dockerfile.dev']);
  assert.equal(full.hasDockerignore, true);
  assert.equal(full.hasDevcontainer, true);

  // A .dockerignore on its own still means the project is built into an image.
  assert.ok(docker.detect(['.dockerignore']));
});

test('dockerfile naming covers the conventional variants', () => {
  assert.ok(docker.isDockerfile('Dockerfile'));
  assert.ok(docker.isDockerfile('Dockerfile.prod'));
  assert.ok(docker.isDockerfile('api.Dockerfile'));
  assert.ok(!docker.isDockerfile('Dockerfile-notes.md'));
  assert.ok(!docker.isDockerfile('dockerfiles'));
});

test('compose services are read without a yaml dependency', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-compose-'));
  const file = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(file, [
    'version: "3.9"',
    '# a comment',
    'services:',
    '  api:',
    '    build: .',
    '    environment:',
    '      NESTED: not-a-service',
    '  db:',
    '    image: postgres:16',
    '',
    'volumes:',
    '  pgdata:',
  ].join('\n'));

  assert.deepEqual(await docker.composeServices(file), ['api', 'db']);
  assert.deepEqual(await docker.composeServices(path.join(dir, 'missing.yml')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status reports installed, running and neither', async () => {
  const up = await docker.status({ force: true, exec: fakeExec({ 'version --format': { stdout: VERSION_OK } }) });
  assert.equal(up.installed, true);
  assert.equal(up.running, true);
  assert.equal(up.clientVersion, '29.5.2');
  assert.equal(up.serverVersion, '29.6.1');

  docker.resetCache();
  const daemonDown = await docker.status({
    force: true,
    exec: fakeExec({
      'version --format': {
        error: Object.assign(new Error('daemon'), { code: 1 }),
        stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
      },
    }),
  });
  assert.equal(daemonDown.installed, true, 'a refusing daemon still means Docker is installed');
  assert.equal(daemonDown.running, false);

  docker.resetCache();
  const missing = await docker.status({
    force: true,
    exec: fakeExec({ 'version --format': { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) } }),
  });
  assert.equal(missing.installed, false);
  assert.equal(missing.running, false);
});

test('inventory prefers docker deduplicated totals over summing the detail', async () => {
  const inv = await docker.inventory({
    force: true,
    exec: fakeExec({
      'version --format': { stdout: VERSION_OK },
      'system df': { stdout: DF_SUMMARY },
    }),
  });
  assert.equal(inv.ok, true);
  assert.ok(!inv.approximate);
  // Summing the two verbose images would give 1.12GB; docker says 16.45GB.
  assert.equal(inv.categories.images.size, 16450000000);
});

test('inventory falls back to the summary when the verbose form fails', async () => {
  const exec = (file, args, opts, cb) => {
    const key = args.slice(0, 2).join(' ');
    if (key === 'version --format') return cb(null, VERSION_OK, '');
    if (args.includes('-v')) return cb(Object.assign(new Error('timeout'), { killed: true }), '', '');
    return cb(null, DF_SUMMARY, '');
  };
  const inv = await docker.inventory({ force: true, exec });
  assert.equal(inv.ok, true);
  assert.equal(inv.partial, true);
  assert.equal(inv.categories.images.size, 16450000000);
  assert.deepEqual(inv.images, [], 'no per-item detail is available in the fallback');
});

test('a stopped daemon degrades to a reason, never an exception', async () => {
  const inv = await docker.inventory({
    force: true,
    exec: fakeExec({ 'version --format': { error: Object.assign(new Error('x'), { code: 'ENOENT' }) } }),
  });
  assert.equal(inv.ok, false);
  assert.equal(inv.reason, 'not-installed');
});

test('only regenerable things can be pruned', () => {
  const kinds = Object.keys(docker.PRUNE_KINDS);
  assert.deepEqual(kinds.sort(), ['build-cache', 'dangling-images', 'stopped-containers']);
  // The whole point: volumes hold real data and must never be offered.
  assert.ok(!kinds.some((k) => /volume/i.test(k)));
  for (const spec of Object.values(docker.PRUNE_KINDS)) {
    assert.ok(!spec.args.includes('volume'), spec.id + ' must not touch volumes');
    assert.ok(!spec.args.includes('-a') && !spec.args.includes('--all'), spec.id + ' must not prune everything');
  }
  assert.equal(docker.PRUNE_KINDS['stopped-containers'].safe, false);
});

test('suggestions cover the regenerable categories and skip small change', () => {
  const info = { ok: true, categories: docker.parseSummary(DF_SUMMARY) };
  const kinds = docker.reclaimSuggestions(info).map((s) => s.kind);
  assert.deepEqual(kinds, ['build-cache', 'dangling-images']);
  // 3.74 GB of reclaimable volumes on this fixture, deliberately not offered.
  assert.ok(!kinds.includes('volumes'));

  const suggestion = docker.reclaimSuggestions(info)[0];
  assert.equal(suggestion.savings, 5765000000);
  assert.equal(suggestion.severity, 'high');
  assert.equal(suggestion.unused, 257);

  const tiny = {
    ok: true,
    categories: {
      images: { count: 1, active: 1, size: 100, reclaimable: 100 },
      containers: { count: 0, active: 0, size: 0, reclaimable: 0 },
      volumes: { count: 0, active: 0, size: 0, reclaimable: 0 },
      buildCache: { count: 1, active: 0, size: 200, reclaimable: 200 },
    },
  };
  assert.deepEqual(docker.reclaimSuggestions(tiny), [], 'a few hundred bytes is not worth a card');
  assert.deepEqual(docker.reclaimSuggestions({ ok: false }), []);
  assert.deepEqual(docker.reclaimSuggestions(null), []);
});

test('prune refuses unknown kinds without running anything', async () => {
  let called = false;
  const res = await docker.prune('volumes', { exec: () => { called = true; } });
  assert.equal(res.ok, false);
  assert.equal(res.freed, 0);
  assert.equal(called, false, 'an unknown kind must never reach the CLI');
});

test('prune reports the space docker says it reclaimed', async () => {
  const res = await docker.prune('build-cache', {
    exec: fakeExec({
      'version --format': { stdout: VERSION_OK },
      'builder prune': { stdout: 'deleted: sha256:x\n\nTotal reclaimed space: 5.765GB\n' },
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.freed, 5765000000);
  assert.equal(docker.parseReclaimed('Total reclaimed space: 0B'), 0);
  assert.equal(docker.parseReclaimed('nothing here'), 0);
});

test('the VM disk is looked for where each platform keeps it', () => {
  const mac = docker.desktopDiskPaths('darwin', '/Users/demo');
  assert.ok(mac.some((p) => p.includes('com.docker.docker') && p.endsWith('Docker.raw')));
  assert.ok(docker.desktopDiskPaths('win32', 'C:\\Users\\Demo').some((p) => p.endsWith('.vhdx')));
  // Linux runs the engine natively, there is no disk image to report.
  assert.deepEqual(docker.desktopDiskPaths('linux', '/home/demo'), []);
});

test('the CLI is looked for outside PATH, which a GUI launch does not have', () => {
  const mac = docker.candidateBinaries('darwin', '/Users/demo');
  assert.ok(mac.includes('/usr/local/bin/docker'));
  assert.ok(mac.includes('/opt/homebrew/bin/docker'));
  assert.ok(mac.some((p) => p.includes('Docker.app')));
  assert.ok(docker.candidateBinaries('win32', 'C:\\Users\\Demo').every((p) => p.endsWith('.exe')));
});
