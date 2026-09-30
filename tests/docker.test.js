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
  const up = await docker.status({ force: true, backendRunning: () => true, exec: fakeExec({ 'version --format': { stdout: VERSION_OK } }) });
  assert.equal(up.installed, true);
  assert.equal(up.running, true);
  assert.equal(up.clientVersion, '29.5.2');
  assert.equal(up.serverVersion, '29.6.1');

  docker.resetCache();
  const daemonDown = await docker.status({
    force: true,
    backendRunning: () => false,
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
    backendRunning: () => true,
    exec: fakeExec({ 'version --format': { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) } }),
  });
  assert.equal(missing.installed, false);
  assert.equal(missing.running, false);
  assert.equal(missing.state, 'not-installed', 'no CLI wins over a backend process');
  assert.equal(up.state, 'running');
  assert.equal(daemonDown.state, 'stopped');
});

const NO_ANSWER = { 'version --format': { error: Object.assign(new Error('t'), { killed: true }) } };

test('status tells a running Desktop with a dead engine from a stopped Desktop', async () => {
  const wedged = await docker.status({ force: true, backendRunning: () => true, exec: fakeExec(NO_ANSWER) });
  assert.equal(wedged.state, 'engine-down');
  assert.equal(wedged.installed, true, 'a timeout proves the CLI exists');
  assert.equal(wedged.running, false);
  assert.equal(wedged.error, 'docker timed out');

  docker.resetCache();
  const off = await docker.status({ force: true, backendRunning: () => false, exec: fakeExec(NO_ANSWER) });
  assert.equal(off.state, 'stopped');
  assert.equal(off.installed, true);
});

test('the backend probe reads pgrep and survives a missing pgrep', async () => {
  const found = await docker.backendRunning({ processExec: (c, a, o, cb) => cb(null, '4242 com.docker.backend\n', '') }, 'darwin');
  assert.equal(found, true);
  const none = await docker.backendRunning({ processExec: (c, a, o, cb) => cb(Object.assign(new Error('1'), { code: 1 }), '', '') }, 'darwin');
  assert.equal(none, false);
  const thrown = await docker.backendRunning({ processExec: () => { throw new Error('nope'); } }, 'linux');
  assert.equal(thrown, false);
});

test('the engine states surface on the inventory too', async () => {
  const inv = await docker.inventory({ force: true, backendRunning: () => true, exec: fakeExec(NO_ANSWER) });
  assert.equal(inv.ok, false);
  assert.equal(inv.state, 'engine-down');
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
  assert.deepEqual(kinds.sort(), ['build-cache', 'dangling-images', 'stopped-containers', 'unused-images']);
  // The whole point: volumes hold real data and must never be offered.
  assert.ok(!kinds.some((k) => /volume/i.test(k)));
  for (const spec of Object.values(docker.PRUNE_KINDS)) {
    assert.ok(!spec.args.includes('volume') && !spec.args.includes('--volumes'), spec.id + ' must not touch volumes');
    assert.ok(!spec.args.includes('system'), spec.id + ' must not run a system-wide prune');
    // -a is allowed only where it is the point (unused images) and never safe.
    if (spec.args.includes('-a') || spec.args.includes('--all')) {
      assert.equal(spec.id, 'unused-images');
      assert.equal(spec.safe, false, 'removing every unused image must be confirmed');
    }
  }
  assert.equal(docker.PRUNE_KINDS['stopped-containers'].safe, false);
  assert.equal(docker.PRUNE_KINDS['unused-images'].safe, false, 'unused images are opt-in');
  assert.deepEqual(docker.PRUNE_KINDS['unused-images'].args, ['image', 'prune', '-a', '-f']);
});

test('suggestions cover the regenerable categories and skip small change', () => {
  const info = { ok: true, categories: docker.parseSummary(DF_SUMMARY) };
  const kinds = docker.reclaimSuggestions(info).map((s) => s.kind);
  assert.deepEqual(kinds, ['build-cache', 'dangling-images', 'unused-images', 'unused-volumes']);
  // 3.74 GB of reclaimable volumes on this fixture: shown for review, never pruned.
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
  for (const kind of ['nope', '__proto__', 'constructor', undefined]) {
    const res = await docker.prune(kind, { exec: () => { called = true; } });
    assert.equal(res.ok, false);
    assert.equal(res.freed, 0);
  }
  assert.equal(called, false, 'an unknown kind must never reach the CLI');
});

// Records every argv the runner sees, answering the status probe as a live engine.
function recordingExec(argvs) {
  return (file, args, opts, cb) => {
    if (args[0] === 'version') return cb(null, VERSION_OK, '');
    if (args[0] === 'context') return cb(null, 'unix:///var/run/docker.sock\n', '');
    argvs.push(args);
    cb(null, 'Total reclaimed space: 1MB', '');
  };
}

test('every prune kind builds exactly the argv it promises', async () => {
  const expected = {
    'build-cache': ['builder', 'prune', '-f'],
    'dangling-images': ['image', 'prune', '-f'],
    'stopped-containers': ['container', 'prune', '-f'],
    'unused-images': ['image', 'prune', '-a', '-f'],
  };
  for (const [kind, argv] of Object.entries(expected)) {
    const seen = [];
    docker.resetCache();
    const res = await docker.prune(kind, { exec: recordingExec(seen) });
    assert.equal(res.ok, true, kind);
    assert.deepEqual(seen, [argv], kind);
  }
});

test('volumes are never pruned without the explicit opt-in', async () => {
  for (const options of [{}, { confirmVolumes: false }, { confirmVolumes: 'yes' }, { confirmVolumes: 1 }]) {
    const seen = [];
    docker.resetCache();
    const res = await docker.prune('volumes', { ...options, exec: recordingExec(seen) });
    assert.equal(res.ok, false);
    assert.deepEqual(seen, [], 'nothing may reach the CLI');
  }
  // No other kind can smuggle volumes in, even with the flag set.
  for (const kind of Object.keys(docker.PRUNE_KINDS)) {
    const seen = [];
    docker.resetCache();
    await docker.prune(kind, { confirmVolumes: true, exec: recordingExec(seen) });
    assert.ok(seen.every((a) => !a.includes('volume')), kind);
  }
  // Not even the old opt-in flag can prune volumes any more: bulk removal of
  // databases is gone entirely. One volume at a time, by exact name, only.
  const seen = [];
  docker.resetCache();
  const res = await docker.prune('volumes', { confirmVolumes: true, exec: recordingExec(seen) });
  assert.equal(res.ok, false);
  assert.match(res.error, /never removed in bulk/);
  assert.deepEqual(seen, [], 'nothing may reach the CLI');
});

test('prune does nothing while the engine is down and says why', async () => {
  const seen = [];
  const res = await docker.prune('build-cache', {
    backendRunning: () => true,
    exec: (f, a, o, cb) => { seen.push(a); cb(Object.assign(new Error('t'), { killed: true }), '', ''); },
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /engine/);
  assert.deepEqual(seen.filter((a) => a[0] !== 'version'), []);
});

test('prune reports the space docker says it reclaimed', async () => {
  const res = await docker.prune('build-cache', {
    exec: fakeExec({
      'version --format': { stdout: VERSION_OK },
      'context inspect': { stdout: 'unix:///var/run/docker.sock\n' },
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

// NTFS only makes a file sparse when it is explicitly flagged, so truncate
// cannot build this fixture on Windows.
test('desktopDisk reports allocated bytes for a sparse image, not its apparent size', { skip: process.platform === 'win32' && 'NTFS files are not sparse unless flagged' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-disk-'));
  try {
    const file = docker.desktopDiskPaths('darwin', home)[0];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 1024 ** 3); // 1 GiB apparent, nothing written

    const disk = await docker.desktopDisk('darwin', home);
    assert.equal(disk.path, file);
    assert.equal(disk.apparentBytes, 1024 ** 3);
    assert.equal(disk.bytes, disk.allocatedBytes);
    assert.ok(disk.allocatedBytes < 64 * 1024 * 1024, 'allocated ' + disk.allocatedBytes + ' should be far below 1 GiB');
    assert.equal(disk.sparse, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('desktopDisk is null where there is no disk image', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-disk-'));
  try {
    assert.equal(await docker.desktopDisk('linux', home), null);
    assert.equal(await docker.desktopDisk('darwin', home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

const DISK = { path: '/x/Docker.raw', bytes: 54e9, allocatedBytes: 54e9, apparentBytes: 460e9 };

test('with the engine down the disk image is still reported, with guidance', () => {
  for (const state of ['engine-down', 'stopped']) {
    const out = docker.reclaimSuggestions({ ok: false, reason: 'daemon-not-running', status: { state }, desktopDisk: DISK, platform: 'darwin' });
    assert.equal(out.length, 1, state);
    const s = out[0];
    assert.equal(s.kind, 'desktop-disk');
    assert.equal(s.bytes, 54e9, 'allocated, not the 460 GB the file claims');
    assert.equal(s.apparentBytes, 460e9);
    assert.equal(s.savings, 0);
    assert.match(s.message, state === 'engine-down' ? /not answering/ : /not running/);
    assert.match(s.guidance, /will not shrink right away/);
  }
  assert.deepEqual(docker.reclaimSuggestions({ ok: false, status: { state: 'not-installed' } }), []);
});

test('prune suggestions carry the note that the disk image lags behind', () => {
  const info = { ok: true, categories: docker.parseSummary(DF_SUMMARY), desktopDisk: DISK };
  for (const s of docker.reclaimSuggestions(info)) assert.equal(s.note, docker.DISK_NOTE);
  const linux = docker.reclaimSuggestions({ ok: true, categories: docker.parseSummary(DF_SUMMARY) });
  assert.ok(linux.every((s) => s.note === null), 'no disk image, no note');
});

// ---- reviewer fixes ----

const LOCAL_ENV = {};
const CTX = (host) => ({ 'context inspect': { stdout: host + '\n' } });

test('backend probe matches the process name exactly, not any command line', async () => {
  let seen;
  await docker.backendRunning({ processExec: (c, a, o, cb) => { seen = [c, a]; cb(null, '1\n', ''); } }, 'darwin');
  assert.deepEqual(seen, ['pgrep', ['-x', 'com.docker.backend']]);
  let win;
  await docker.backendRunning({ processExec: (c, a, o, cb) => { win = c; cb(null, 'com.docker.backend.exe 12 Console', ''); } }, 'win32');
  assert.equal(win, 'tasklist');
});

test('a timed out probe is cached for seconds, a clean answer for a minute', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const slow = (f, a, o, cb) => { calls++; cb(Object.assign(new Error('t'), { killed: true }), '', ''); };
  await docker.status({ backendRunning: () => true, exec: slow, env: LOCAL_ENV });
  await docker.status({ backendRunning: () => true, exec: slow, env: LOCAL_ENV });
  assert.equal(calls, 1, 'fresh timeout is served from cache');
  now += 6000;
  await docker.status({ backendRunning: () => true, exec: slow, env: LOCAL_ENV });
  assert.equal(calls, 2, 'a timeout is asked again after about 5 s');

  docker.resetCache();
  let ok = 0;
  const good = fakeExec({ 'version --format': { stdout: VERSION_OK }, ...CTX('unix:///var/run/docker.sock') });
  const counting = (f, a, o, cb) => { if (a[0] === 'version') ok++; good(f, a, o, cb); };
  await docker.status({ exec: counting, env: LOCAL_ENV });
  now += 30000;
  await docker.status({ exec: counting, env: LOCAL_ENV });
  assert.equal(ok, 1, 'a clean answer is still cached at 30 s');
  now += 31000;
  await docker.status({ exec: counting, env: LOCAL_ENV });
  assert.equal(ok, 2, 'and expires after 60 s');
});

test('status exposes the endpoint and flags a remote context', async () => {
  const local = await docker.status({ force: true, env: LOCAL_ENV, exec: fakeExec({ 'version --format': { stdout: VERSION_OK }, ...CTX('unix:///var/run/docker.sock') }) });
  assert.equal(local.remote, false);
  assert.equal(local.endpoint, 'unix:///var/run/docker.sock');
  const pipe = await docker.status({ force: true, env: LOCAL_ENV, exec: fakeExec({ 'version --format': { stdout: VERSION_OK }, ...CTX('npipe:////./pipe/docker_engine') }) });
  assert.equal(pipe.remote, false);
  for (const host of ['ssh://me@build-box', 'tcp://10.0.0.5:2376']) {
    const st = await docker.status({ force: true, env: LOCAL_ENV, exec: fakeExec({ 'version --format': { stdout: VERSION_OK }, ...CTX(host) }) });
    assert.equal(st.remote, true, host);
    assert.equal(st.endpoint, host);
  }
  const viaEnv = await docker.status({ force: true, env: { DOCKER_HOST: 'tcp://1.2.3.4:2375' }, exec: fakeExec({ 'version --format': { stdout: VERSION_OK } }) });
  assert.equal(viaEnv.remote, true, 'DOCKER_HOST overrides the context');
});

test('prune refuses on a remote or unknown endpoint and runs nothing', async () => {
  for (const ctx of [CTX('ssh://me@build-box'), CTX('tcp://10.0.0.5:2376'), { 'context inspect': { error: new Error('no') } }]) {
    const seen = [];
    docker.resetCache();
    const exec = (f, a, o, cb) => {
      if (a[0] === 'version') return cb(null, VERSION_OK, '');
      seen.push(a);
      fakeExec(ctx)(f, a, o, cb);
    };
    const res = await docker.prune('build-cache', { exec, env: LOCAL_ENV });
    assert.equal(res.ok, false);
    assert.equal(res.freed, 0);
    assert.deepEqual(seen.filter((a) => a[0] !== 'context'), [], 'no prune reaches the CLI');
  }
  docker.resetCache();
  const res = await docker.prune('build-cache', { env: LOCAL_ENV, exec: fakeExec({ 'version --format': { stdout: VERSION_OK }, ...CTX('ssh://x') }) });
  assert.match(res.error, /remote host/);
});

test('no suggestions are offered against a remote context', () => {
  const info = { ok: true, categories: docker.parseSummary(DF_SUMMARY), status: { remote: true } };
  assert.deepEqual(docker.reclaimSuggestions(info), []);
});

test('a socket permission error is its own state, not stopped', async () => {
  const msg = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/version": dial unix /var/run/docker.sock: connect: permission denied';
  const st = await docker.status({
    force: true,
    backendRunning: () => false,
    exec: fakeExec({ 'version --format': { error: Object.assign(new Error('x'), { code: 1 }), stderr: msg } }),
  });
  assert.equal(st.state, 'no-permission');
  assert.equal(st.installed, true);
  assert.equal(st.running, false);

  docker.resetCache();
  const inv = await docker.inventory({ force: true, exec: fakeExec({ 'version --format': { error: Object.assign(new Error('x'), { code: 1 }), stderr: msg } }) });
  assert.equal(inv.reason, 'no-permission');

  docker.resetCache();
  const res = await docker.prune('build-cache', { exec: fakeExec({ 'version --format': { error: Object.assign(new Error('x'), { code: 1 }), stderr: msg } }) });
  assert.equal(res.ok, false);
  assert.match(res.error, /docker group/);
  assert.match(res.error, /rootless/);

  // Unrelated permission errors are not this state.
  docker.resetCache();
  const other = await docker.status({ force: true, backendRunning: () => false, exec: fakeExec({ 'version --format': { error: new Error('x'), stderr: 'permission denied: /etc/foo' } }) });
  assert.equal(other.state, 'stopped');
});

test('disk copy is worded per platform', () => {
  assert.match(docker.diskNote('darwin'), /Mac/);
  assert.match(docker.diskNote('darwin'), /Docker\.raw/);
  assert.match(docker.diskNote('win32'), /WSL2/);
  assert.match(docker.diskNote('win32'), /sparse VHDX/);
  assert.doesNotMatch(docker.diskNote('win32'), /Mac/);
  assert.doesNotMatch(docker.diskNote('linux'), /Mac|VHDX/);
  assert.ok(!/\u2014/.test(['darwin', 'win32', 'linux'].map(docker.diskNote).join('')));

  const down = (state, platform) => docker.reclaimSuggestions({ ok: false, platform, status: { state }, desktopDisk: DISK })[0];
  assert.match(down('engine-down', 'win32').guidance, /^Restart Docker Desktop/);
  assert.match(down('engine-down', 'win32').guidance, /WSL2/);
  assert.doesNotMatch(down('engine-down', 'win32').guidance, /Mac/);
  assert.match(down('stopped', 'darwin').guidance, /^Start Docker Desktop/);
  assert.match(down('stopped', 'darwin').guidance, /Mac/);
  const ok = docker.reclaimSuggestions({ ok: true, platform: 'win32', categories: docker.parseSummary(DF_SUMMARY), desktopDisk: DISK });
  assert.ok(ok.every((s) => s.note === docker.diskNote('win32')));
});

test('on Linux the backend probe matches the executable path, since procps truncates names to 15 chars', async () => {
  let seen;
  await docker.backendRunning({ processExec: (c, a, o, cb) => { seen = [c, a]; cb(null, '1\n', ''); } }, 'linux');
  assert.equal(seen[0], 'pgrep');
  assert.equal(seen[1][0], '-f');
  const re = new RegExp(seen[1][1]);
  assert.ok(re.test('/opt/docker-desktop/bin/com.docker.backend'));
  assert.ok(re.test('/opt/docker-desktop/bin/com.docker.backend run'));
  assert.ok(!re.test('tail -f /home/b/.docker/desktop/log/host/com.docker.backend.log'));
});

// ---- unused images, volumes, Desktop restart ----

// Records copied verbatim from `docker system df -v --format json` on Docker
// Desktop 4.81 / Engine 29.6.1 (a linked compose volume, an unused compose
// volume, an anonymous volume, and the container mounting the first).
const REAL_VOL_LINKED = {"Availability": "N/A", "Driver": "local", "Group": "N/A", "Labels": "com.docker.compose.config-hash=b86343c95d5620ab2e4948c052d9c6136c309aee242e815141078ebf6bb2a4ae,com.docker.compose.project=taifa-emr,com.docker.compose.version=5.2.0,com.docker.compose.volume=dbdata", "Links": "1", "Mountpoint": "/var/lib/docker/volumes/taifa-emr_dbdata/_data", "Name": "taifa-emr_dbdata", "Scope": "local", "Size": "66.95MB", "Status": "N/A"};
const REAL_VOL_UNUSED = {"Availability": "N/A", "Driver": "local", "Group": "N/A", "Labels": "com.docker.compose.config-hash=f967c2ea7b779aef9bab7a473511352b4fc00292478eaa65f586cc5c9bee8a18,com.docker.compose.project=taifa-mail,com.docker.compose.version=5.2.0,com.docker.compose.volume=redis_data", "Links": "0", "Mountpoint": "/var/lib/docker/volumes/taifa-mail_redis_data/_data", "Name": "taifa-mail_redis_data", "Scope": "local", "Size": "236B", "Status": "N/A"};
const ANON = '1a29d09560135480a207ee8f9336942b5d36d942c1c94f800d9ee191ac513371';
const REAL_VOL_ANON = {"Availability": "N/A", "Driver": "local", "Group": "N/A", "Labels": "com.docker.volume.anonymous=", "Links": "0", "Mountpoint": "/var/lib/docker/volumes/1a29d09560135480a207ee8f9336942b5d36d942c1c94f800d9ee191ac513371/_data", "Name": ANON, "Scope": "local", "Size": "107.8MB", "Status": "N/A"};
const REAL_CONTAINER = {"ID": "36a30056d4f7b4c09fa91fdfe4ca54b6e9e7cd0d61d2a3cd2af01133484735f4", "Names": "taifa-emr-db-1", "Image": "postgres:16-alpine", "Labels": "com.docker.compose.config-hash=c2a0355ae6820eef742a1763c3c0cff896e9023dcb53cb00dd7c7d478e65ae94,com.docker.compose.container-number=1,com.docker.compose.depends_on=,com.docker.compose.image=sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685,com.docker.compose.oneoff=False,com.docker.compose.project.config_files=/Users/user/projects/rcfi/taifa-health/taifa-emr/docker-compose.yml,com.docker.compose.project.working_dir=/Users/user/projects/rcfi/taifa-health/taifa-emr,com.docker.compose.project=taifa-emr,com.docker.compose.service=db,com.docker.compose.version=5.2.0,desktop.docker.io/ports.scheme=v2,desktop.docker.io/ports/5432/tcp=:5433", "LocalVolumes": "1", "Mounts": "taifa-emr_dbdata", "Size": "20.5kB", "State": "running", "Status": "Up 9 minutes (healthy)"};
const REAL_DF_V = JSON.stringify({ Images: [], Containers: [REAL_CONTAINER], Volumes: [REAL_VOL_LINKED, REAL_VOL_UNUSED, REAL_VOL_ANON], BuildCache: [] });
// Verbatim `docker volume inspect taifa-mail_redis_data`.
const REAL_INSPECT_UNUSED = {"CreatedAt": "2026-08-29T08:47:01Z", "Driver": "local", "Labels": {"com.docker.compose.config-hash": "f967c2ea7b779aef9bab7a473511352b4fc00292478eaa65f586cc5c9bee8a18", "com.docker.compose.project": "taifa-mail", "com.docker.compose.version": "5.2.0", "com.docker.compose.volume": "redis_data"}, "Mountpoint": "/var/lib/docker/volumes/taifa-mail_redis_data/_data", "Name": "taifa-mail_redis_data", "Options": null, "Scope": "local"};
const inspectOf = (name) => ({ CreatedAt: '2026-09-01T10:58:16Z', Driver: 'local', Labels: name === ANON ? { 'com.docker.volume.anonymous': '' } : {}, Name: name, Options: null, Scope: 'local' });

test('volumes are built from real df -v and inspect output', () => {
  const list = docker.buildVolumeList(REAL_DF_V, [REAL_INSPECT_UNUSED]);
  const [linked, unused, anon] = list;
  assert.equal(linked.name, 'taifa-emr_dbdata');
  assert.equal(linked.sizeBytes, 66950000);
  assert.equal(linked.inUse, true);
  assert.deepEqual(linked.containers, ['taifa-emr-db-1']);
  assert.equal(linked.project, 'taifa-emr');
  assert.equal(linked.volume, 'dbdata');
  assert.equal(linked.service, 'db', 'service comes from the container that mounts it');
  assert.equal(linked.createdAt, null, 'not inspected, so no creation time');

  assert.equal(unused.inUse, false);
  assert.deepEqual(unused.containers, []);
  assert.equal(unused.sizeBytes, 236);
  assert.equal(unused.project, 'taifa-mail');
  assert.equal(unused.service, null);
  assert.equal(unused.createdAt, '2026-08-29T08:47:01Z');
  assert.equal(unused.driver, 'local');
  assert.equal(unused.labels['com.docker.compose.volume'], 'redis_data');
  assert.equal(unused.anonymous, false);

  assert.equal(anon.anonymous, true);
  assert.equal(anon.project, null);
  assert.equal(docker.isAnonymousVolume('a'.repeat(64), {}), true, '64-hex name alone marks it anonymous');
  assert.equal(docker.isAnonymousVolume('pgdata', {}), false);
  assert.deepEqual(docker.buildVolumeList('nope'), []);
  // inspect prints the found volumes even when one name is missing and it exits 1.
  assert.equal(docker.parseVolumeInspect(JSON.stringify([REAL_INSPECT_UNUSED])).length, 1);
  assert.deepEqual(docker.parseVolumeInspect('[]\n'), []);
});

test('listVolumes runs df -v then batched inspects, with the exact argv', async () => {
  const names = Array.from({ length: 120 }, (_, i) => `proj_v${i}`);
  const df = JSON.stringify({ Containers: [], Volumes: names.map((n) => ({ Name: n, Size: '1MB', Links: '0', Driver: 'local', Labels: 'com.docker.compose.project=proj' })) });
  const seen = [];
  const exec = (f, args, opts, cb) => {
    if (args[0] === 'version') return cb(null, VERSION_OK, '');
    if (args[0] === 'context') return cb(null, 'unix:///var/run/docker.sock\n', '');
    seen.push({ args, timeout: opts.timeout });
    if (args[0] === 'system') return cb(null, df, '');
    if (args[0] === 'volume' && args[1] === 'inspect') return cb(null, JSON.stringify(args.slice(2).map(inspectOf)), '');
    cb(new Error('unexpected ' + args.join(' ')), '', '');
  };
  const list = await docker.listVolumes({ exec, env: LOCAL_ENV });
  assert.equal(list.length, 120);
  assert.deepEqual(seen[0].args, ['system', 'df', '-v', '--format', 'json']);
  assert.deepEqual(seen.slice(1).map((s) => s.args.length - 2), [50, 50, 20], 'inspect in batches of 50');
  assert.deepEqual(seen[1].args.slice(0, 3), ['volume', 'inspect', 'proj_v0']);
  assert.ok(seen.every((s) => s.timeout > 0), 'every call has a timeout');
  assert.ok(list.every((v) => v.createdAt === '2026-09-01T10:58:16Z'));
  assert.ok(seen.every((s) => !s.args.includes('rm') && !s.args.includes('prune')));

  docker.resetCache();
  const calls = [];
  const down = await docker.listVolumes({ backendRunning: () => true, exec: (f, a, o, cb) => { calls.push(a); cb(Object.assign(new Error('t'), { killed: true }), '', ''); } });
  assert.deepEqual(down, []);
  assert.deepEqual(calls.filter((a) => a[0] !== 'version'), [], 'engine down: nothing else runs');
});

test('volumes group by compose project with totals', () => {
  const list = docker.buildVolumeList(REAL_DF_V);
  const groups = docker.groupVolumesByProject(list);
  assert.deepEqual(groups.map((g) => g.key), ['(anonymous)', 'taifa-emr', 'taifa-mail']);
  const emr = groups.find((g) => g.key === 'taifa-emr');
  assert.equal(emr.count, 1); assert.equal(emr.inUse, 1); assert.equal(emr.unusedBytes, 0);
  const anon = groups[0];
  assert.equal(anon.project, null);
  assert.equal(anon.unused, 1);
  assert.equal(anon.unusedBytes, 107800000);
  assert.deepEqual(docker.groupVolumesByProject(null), []);
});

// A docker runner for removeVolume. `users` is a list of answers for the
// successive `ps --filter volume=` checks.
function volumeExec({ host = 'unix:///var/run/docker.sock', users = [[], []], exists = true } = {}) {
  const seen = [];
  let check = 0;
  const exec = (f, args, opts, cb) => {
    seen.push(args);
    if (args[0] === 'version') return cb(null, VERSION_OK, '');
    if (args[0] === 'context') return cb(null, host + '\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return exists ? cb(null, JSON.stringify([inspectOf(args[2])]), '') : cb(Object.assign(new Error('x'), { code: 1 }), '[]\n', 'Error response from daemon: get x: no such volume');
    }
    if (args[0] === 'ps') return cb(null, (users[check++] || []).join('\n'), '');
    if (args[0] === 'volume' && args[1] === 'rm') return cb(null, args[2] + '\n', '');
    cb(new Error('unexpected'), '', '');
  };
  return { exec, seen, rms: () => seen.filter((a) => a[1] === 'rm' || a.includes('prune')) };
}

test('removeVolume removes one volume with exactly the promised argv', async () => {
  const r = volumeExec();
  const res = await docker.removeVolume('taifa-mail_redis_data', { confirm: 'taifa-mail_redis_data', exec: r.exec, env: LOCAL_ENV });
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  assert.deepEqual(r.seen, [
    ['version', '--format', '{{json .}}'],
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    // status() reads the endpoint once, then removeVolume checks it fresh.
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    ['volume', 'inspect', 'taifa-mail_redis_data'],
    ['ps', '-a', '--no-trunc', '--filter', 'volume=taifa-mail_redis_data', '--format', '{{.Names}}'],
    ['ps', '-a', '--no-trunc', '--filter', 'volume=taifa-mail_redis_data', '--format', '{{.Names}}'],
    ['volume', 'rm', 'taifa-mail_redis_data'],
  ]);
});

test('removeVolume refuses without the exact name, and runs nothing', async () => {
  for (const confirm of [undefined, true, '', 'taifa-mail', 'taifa-mail_redis_data ', 'TAIFA-MAIL_REDIS_DATA', ['taifa-mail_redis_data']]) {
    const r = volumeExec();
    const res = await docker.removeVolume('taifa-mail_redis_data', { confirm, exec: r.exec, env: LOCAL_ENV });
    assert.equal(res.ok, false, String(confirm));
    assert.deepEqual(r.seen, [], 'no CLI call at all for ' + JSON.stringify(confirm));
  }
  // A name that could be read as a flag never reaches the CLI, even confirmed.
  for (const name of ['-f', '--all', '', 'a b', '../x', null]) {
    const r = volumeExec();
    const res = await docker.removeVolume(name, { confirm: name, exec: r.exec, env: LOCAL_ENV });
    assert.equal(res.ok, false);
    assert.deepEqual(r.seen, []);
  }
});

test('removeVolume refuses a volume in use, including one attached between check and removal', async () => {
  const busy = volumeExec({ users: [['taifa-emr-db-1']] });
  const res = await docker.removeVolume('taifa-emr_dbdata', { confirm: 'taifa-emr_dbdata', exec: busy.exec, env: LOCAL_ENV });
  assert.equal(res.ok, false);
  assert.equal(res.inUse, true);
  assert.deepEqual(res.containers, ['taifa-emr-db-1']);
  assert.match(res.error, /taifa-emr-db-1/);
  assert.deepEqual(busy.rms(), []);

  docker.resetCache();
  const race = volumeExec({ users: [[], ['taifa-mail-redis-1']] });
  const raced = await docker.removeVolume('taifa-mail_redis_data', { confirm: 'taifa-mail_redis_data', exec: race.exec, env: LOCAL_ENV });
  assert.equal(raced.ok, false);
  assert.deepEqual(raced.containers, ['taifa-mail-redis-1']);
  assert.deepEqual(race.rms(), [], 'the last-moment check stops the removal');

  docker.resetCache();
  const missing = volumeExec({ exists: false });
  const gone = await docker.removeVolume('nope_x', { confirm: 'nope_x', exec: missing.exec, env: LOCAL_ENV });
  assert.equal(gone.ok, false);
  assert.deepEqual(missing.rms(), []);
});

test('removeVolume refuses a remote or unknown context', async () => {
  for (const host of ['ssh://me@build-box', 'tcp://10.0.0.5:2376', '']) {
    docker.resetCache();
    const r = volumeExec({ host });
    const res = await docker.removeVolume('taifa-mail_redis_data', { confirm: 'taifa-mail_redis_data', exec: r.exec, env: LOCAL_ENV });
    assert.equal(res.ok, false, host);
    assert.deepEqual(r.seen.filter((a) => a[0] === 'volume' || a[0] === 'ps'), [], host);
  }
  docker.resetCache();
  const viaEnv = volumeExec();
  const res = await docker.removeVolume('taifa-mail_redis_data', { confirm: 'taifa-mail_redis_data', exec: viaEnv.exec, env: { DOCKER_HOST: 'tcp://1.2.3.4:2375' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /remote host/);
  assert.deepEqual(viaEnv.rms(), []);
});

test('an anonymous volume is removable only with its exact 64-hex name', async () => {
  const wrong = volumeExec();
  assert.equal((await docker.removeVolume(ANON, { confirm: ANON.slice(0, 12), exec: wrong.exec, env: LOCAL_ENV })).ok, false);
  assert.deepEqual(wrong.seen, []);
  docker.resetCache();
  const right = volumeExec();
  const res = await docker.removeVolume(ANON, { confirm: ANON, exec: right.exec, env: LOCAL_ENV });
  assert.equal(res.ok, true);
  assert.deepEqual(right.rms(), [['volume', 'rm', ANON]]);
});

test('there is no bulk volume API and prune still cannot reach volumes by kind', () => {
  assert.equal(docker.removeVolumes, undefined);
  assert.ok(!Object.keys(docker.PRUNE_KINDS).some((k) => /volume/i.test(k)));
});

test('suggestions size dangling and unused images apart and list volumes for review only', () => {
  const info = {
    ok: true,
    categories: docker.parseSummary([
      '{"Active":"1","Reclaimable":"24.94GB (90%)","Size":"27GB","TotalCount":"40","Type":"Images"}',
      '{"Active":"0","Reclaimable":"0B","Size":"0B","TotalCount":"0","Type":"Build Cache"}',
      '{"Active":"7","Reclaimable":"28.44GB (98%)","Size":"29GB","TotalCount":"138","Type":"Local Volumes"}',
    ].join('\n')),
    images: [
      { dangling: true, containers: 0, bytes: 3e8, uniqueBytes: 3e8 },
      { dangling: false, containers: 0, bytes: 2e10, uniqueBytes: 2e10 },
    ],
    volumes: [
      { name: 'taifa-sign_data', bytes: 20e9, links: 0, project: 'taifa-sign' },
      { name: 'taifa-mail_postgres', bytes: 5e8, links: 0, project: 'taifa-mail' },
      { name: 'taifa-support_redis', bytes: 1e6, links: 0, project: 'taifa-support' },
      { name: 'x', bytes: 1e8, links: 0, project: 'other' },
      { name: ANON, bytes: 6e9, links: 0, project: null },
      { name: 'live', bytes: 9e9, links: 1, project: 'taifa-emr' },
    ],
  };
  const out = docker.reclaimSuggestions(info);
  assert.deepEqual(out.map((s) => s.kind), ['unused-images', 'unused-volumes'], '300 MB of danglers is below the bar');
  const [images, volumes] = out;
  assert.equal(images.savings, 24940000000);
  assert.equal(images.optIn, true);
  assert.equal(images.safe, false);
  assert.equal(volumes.informational, true);
  assert.equal(volumes.action, 'review');
  assert.equal(volumes.prune, null, 'no prune action for volumes');
  assert.equal(volumes.savings, 0);
  assert.equal(volumes.count, 5);
  assert.equal(volumes.bytes, 20e9 + 5e8 + 1e6 + 1e8 + 6e9);
  assert.deepEqual(volumes.topProjects.map((p) => p.project), ['taifa-sign', 'taifa-mail', 'other']);
  assert.ok(!Object.prototype.hasOwnProperty.call(docker.PRUNE_KINDS, volumes.kind));
});

// ---- restartDesktop ----

// A fake macOS: `backend` is the list of live backend pids, which reacts to
// the quit request and to signals according to the scenario.
function fakeMac({ quitWorks = true, ignoresTerm = false, ignoresKill = false, lsof = { code: 1 }, ps = '1 /sbin/launchd\n', engineAfter = 0, quitStops = true } = {}) {
  let now = 0;
  let backend = [92144, 92148, 92149];
  let launched = false;
  let polls = 0;
  const cmds = [];
  const signals = [];
  const processExec = (cmd, args, opts, cb) => {
    cmds.push([cmd, ...args]);
    const fail = (code, stderr = '') => cb(Object.assign(new Error(cmd), { code }), '', stderr);
    if (cmd === 'osascript') { if (quitWorks && quitStops) backend = []; return cb(null, '', ''); }
    if (cmd === 'pgrep') return backend.length ? cb(null, backend.join('\n') + '\n', '') : fail(1);
    if (cmd === 'lsof') return lsof.code === 0 ? cb(null, lsof.stdout, '') : cb(Object.assign(new Error('lsof'), { code: lsof.code }), lsof.stdout || '', lsof.stderr || '');
    if (cmd === 'ps') return cb(null, ps, '');
    if (cmd === 'open') { launched = true; backend = [93001]; return cb(null, '', ''); }
    fail('ENOENT');
  };
  const exec = (f, args, opts, cb) => {
    if (args[0] === 'context') return cb(null, 'unix:///Users/user/.docker/run/docker.sock\n', '');
    if (args[0] === 'version') {
      if (launched && polls++ >= engineAfter) return cb(null, VERSION_OK, '');
      return cb(Object.assign(new Error('t'), { killed: true }), '', '');
    }
    cb(new Error('unexpected'), '', '');
  };
  const kill = (pid, sig) => {
    signals.push([pid, sig]);
    if (sig === 'SIGTERM' && !ignoresTerm) backend = backend.filter((p) => p !== pid);
    if (sig === 'SIGKILL' && !ignoresKill) backend = backend.filter((p) => p !== pid);
  };
  const progress = [];
  const options = {
    platform: 'darwin', env: LOCAL_ENV, exec, processExec, kill,
    backendRunning: () => backend.length > 0,
    diskPaths: ['/Users/demo/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw'],
    now: () => now, sleep: async (ms) => { now += ms; },
    onProgress: (p) => progress.push(p),
  };
  return { options, cmds, signals, progress, elapsed: () => now };
}

// Verbatim `lsof -w -Fpc -- Docker.raw` and a `ps -axo pid=,comm=` excerpt,
// captured while Docker Desktop 4.81 was running.
const LSOF_HELD = 'p92373\nccom.apple.Virtualization.Virtua\nf6\n';
const PS_WITH_VM = '  547 /Library/PrivilegedHelperTools/com.docker.vmnetd\n92144 /Applications/Docker.app/Contents/MacOS/com.docker.backend\n92363 /Applications/Docker.app/Contents/MacOS/com.docker.virtualization\n92371 /Applications/Docker.app/Contents/MacOS/Docker Desktop.app/Contents/MacOS/Docker Desktop\n';

test('lsof and ps output parse into holders and VM processes', () => {
  assert.deepEqual(docker.parseLsof(LSOF_HELD), [{ pid: 92373, command: 'com.apple.Virtualization.Virtua' }]);
  assert.deepEqual(docker.parseLsof(''), []);
  assert.deepEqual(docker.parseVmProcesses(PS_WITH_VM), [{ pid: 92363, command: 'com.docker.virtualization' }]);
  assert.deepEqual(docker.parseVmProcesses('1 /sbin/launchd\n'), []);
});

test('restartDesktop on macOS: graceful quit, relaunch, engine answers, nothing killed', async () => {
  const mac = fakeMac({ engineAfter: 2 });
  const res = await docker.restartDesktop(mac.options);
  assert.equal(res.ok, true);
  assert.equal(res.state, 'running');
  assert.equal(res.killed, 'none');
  assert.deepEqual(mac.signals, []);
  assert.deepEqual(mac.cmds[0], ['osascript', '-e', 'quit app "Docker"']);
  assert.deepEqual(mac.cmds[1], ['pgrep', '-x', 'com.docker.backend']);
  assert.ok(mac.cmds.some((c) => c.join(' ') === 'open -a Docker'));
  assert.ok(!mac.cmds.some((c) => c[0] === 'lsof'), 'no safety probe needed when it quit');
  assert.ok(mac.progress.some((p) => p.phase === 'starting' && p.elapsedMs >= 0));
  assert.ok(mac.progress.every((p) => typeof p.message === 'string'));
  JSON.parse(JSON.stringify(res)); // serialisable for IPC
});

test('restartDesktop on macOS: a backend ignoring quit gets SIGTERM only after a clear safety check', async () => {
  const mac = fakeMac({ quitStops: false });
  const res = await docker.restartDesktop(mac.options);
  assert.equal(res.ok, true);
  assert.equal(res.killed, 'sigterm');
  assert.deepEqual(mac.signals, [[92144, 'SIGTERM'], [92148, 'SIGTERM'], [92149, 'SIGTERM']]);
  const lsofAt = mac.cmds.findIndex((c) => c[0] === 'lsof');
  assert.deepEqual(mac.cmds[lsofAt], ['lsof', '-w', '-Fpc', '--', '/Users/demo/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw']);
  assert.deepEqual(mac.cmds[lsofAt + 1], ['ps', '-axo', 'pid=,comm=']);
  assert.ok(mac.elapsed() >= 60000, 'waited the full minute for the quit first');
  assert.ok(mac.cmds.findIndex((c) => c[0] === 'open') > lsofAt);
});

test('restartDesktop on macOS: SIGKILL follows SIGTERM only after a second clear check', async () => {
  const mac = fakeMac({ quitStops: false, ignoresTerm: true });
  const res = await docker.restartDesktop(mac.options);
  assert.equal(res.ok, true);
  assert.equal(res.killed, 'sigkill');
  assert.deepEqual(mac.signals.map((s) => s[1]), ['SIGTERM', 'SIGTERM', 'SIGTERM', 'SIGKILL', 'SIGKILL', 'SIGKILL']);
  assert.equal(mac.cmds.filter((c) => c[0] === 'lsof').length, 2);

  const stuck = fakeMac({ quitStops: false, ignoresTerm: true, ignoresKill: true });
  const bad = await docker.restartDesktop(stuck.options);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'kill-failed');
  assert.ok(!stuck.cmds.some((c) => c[0] === 'open'), 'never relaunch over a backend that will not die');
});

test('restartDesktop refuses to kill while the disk image is open or a VM runs', async () => {
  const scenarios = [
    { lsof: { code: 0, stdout: LSOF_HELD }, match: /disk image is still open/ },
    { ps: PS_WITH_VM, match: /virtual machine/ },
    // A probe that cannot answer is not a clear answer.
    { lsof: { code: 1, stderr: 'lsof: status error on Docker.raw: No such file or directory' }, match: /Could not check/ },
    { lsof: { code: 'ENOENT' }, match: /Could not check/ },
  ];
  for (const s of scenarios) {
    const mac = fakeMac({ quitStops: false, ...s });
    const res = await docker.restartDesktop(mac.options);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unsafe-to-kill');
    assert.match(res.message, s.match);
    assert.match(res.message, /did not force/);
    assert.deepEqual(mac.signals, [], 'no signal sent');
    assert.ok(!mac.cmds.some((c) => c[0] === 'open'));
  }
  const noDisk = fakeMac({ quitStops: false });
  noDisk.options.diskPaths = [];
  const res = await docker.restartDesktop(noDisk.options);
  assert.equal(res.reason, 'unsafe-to-kill');
  assert.deepEqual(noDisk.signals, []);
});

test('restartDesktop reports a start timeout after five minutes', async () => {
  const mac = fakeMac({ engineAfter: Infinity });
  const res = await docker.restartDesktop(mac.options);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'start-timeout');
  assert.equal(res.state, 'engine-down');
  assert.ok(mac.elapsed() >= 5 * 60000 && mac.elapsed() < 5 * 60000 + 5000);
  assert.ok(mac.progress.some((p) => p.timeoutMs === 5 * 60000));
});

test('restartDesktop refuses on a remote context and runs nothing', async () => {
  const mac = fakeMac();
  const res = await docker.restartDesktop({ ...mac.options, env: { DOCKER_HOST: 'ssh://me@box' } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'remote');
  assert.deepEqual(mac.cmds, []);
});

test('restartDesktop on Windows closes politely, never force-kills, and relaunches the exe', async () => {
  let backend = true;
  const cmds = [];
  const spawned = [];
  let now = 0;
  const processExec = (cmd, args, opts, cb) => {
    cmds.push([cmd, ...args]);
    if (cmd === 'taskkill') { backend = false; return cb(null, 'SUCCESS', ''); }
    if (cmd === 'tasklist') return cb(null, backend ? 'com.docker.backend.exe 12 Console' : 'INFO: No tasks are running', '');
    if (cmd === 'sc') return cb(null, 'STATE: 4 RUNNING', '');
    cb(Object.assign(new Error(cmd), { code: 'ENOENT' }), '', '');
  };
  const exec = (f, args, opts, cb) => args[0] === 'context' ? cb(null, 'npipe:////./pipe/dockerDesktopLinuxEngine\n', '') : cb(null, VERSION_OK, '');
  const options = {
    platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exec, processExec,
    now: () => now, sleep: async (ms) => { now += ms; },
    spawn: (cmd, args, o) => { spawned.push([cmd, args, o]); return { on() {}, unref() {} }; },
    kill: () => { throw new Error('must never kill on Windows'); },
  };
  const res = await docker.restartDesktop(options);
  assert.equal(res.ok, true);
  assert.deepEqual(cmds[0], ['taskkill', '/IM', 'Docker Desktop.exe']);
  assert.deepEqual(cmds[1], ['tasklist', '/FI', 'IMAGENAME eq com.docker.backend.exe', '/NH']);
  assert.ok(cmds.every((c) => !c.includes('/F')), 'no force flag anywhere');
  assert.deepEqual(cmds.filter((c) => c[0] === 'sc'), [['sc', 'query', 'com.docker.service'], ['sc', 'stop', 'com.docker.service'], ['sc', 'start', 'com.docker.service']]);
  assert.equal(spawned[0][0], 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe');
  assert.equal(spawned[0][2].detached, true);

  // A Desktop that will not close is left alone.
  now = 0; cmds.length = 0; spawned.length = 0;
  const stubborn = { ...options, processExec: (cmd, args, o, cb) => { cmds.push([cmd, ...args]); cb(null, cmd === 'tasklist' ? 'com.docker.backend.exe 12' : '', ''); } };
  const res2 = await docker.restartDesktop(stubborn);
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'quit-timeout');
  assert.match(res2.message, /never force-closes/);
  assert.deepEqual(spawned, []);
  assert.ok(now >= 60000);
});

test('restartDesktop on Linux restarts Docker Desktop via systemd and leaves a plain engine alone', async () => {
  const cmds = [];
  let hasUnit = true;
  const processExec = (cmd, args, o, cb) => {
    cmds.push([cmd, ...args]);
    if (args[1] === 'cat') return hasUnit ? cb(null, '[Unit]\n', '') : cb(Object.assign(new Error('x'), { code: 1 }), '', 'No files found for docker-desktop.service.');
    cb(null, '', '');
  };
  const exec = (f, args, o, cb) => args[0] === 'context' ? cb(null, 'unix:///home/b/.docker/desktop/docker.sock\n', '') : cb(null, VERSION_OK, '');
  const base = { platform: 'linux', env: LOCAL_ENV, exec, processExec, backendRunning: () => true, now: () => 0, sleep: async () => {} };
  const res = await docker.restartDesktop(base);
  assert.equal(res.ok, true);
  assert.deepEqual(cmds, [['systemctl', '--user', 'cat', 'docker-desktop.service'], ['systemctl', '--user', 'restart', 'docker-desktop']]);

  cmds.length = 0; hasUnit = false;
  const engine = await docker.restartDesktop(base);
  assert.equal(engine.ok, false);
  assert.equal(engine.reason, 'engine-only');
  assert.match(engine.message, /sudo systemctl restart docker/);
  assert.deepEqual(cmds, [['systemctl', '--user', 'cat', 'docker-desktop.service']], 'only the read-only probe ran');
});
