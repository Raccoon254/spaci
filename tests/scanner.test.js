'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scanner = require('../src/scanner');

// A small but realistic tree: a Dockerised Node app, a compose-only folder that
// has a real project underneath it, and some noise.
function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-scan-'));
  const write = (rel, body = 'x') => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  };

  write('app/package.json', '{"name":"app"}');
  write('app/Dockerfile', 'FROM node:20\n');
  write('app/.dockerignore', 'node_modules\n');
  write('app/docker-compose.yml', ['services:', '  api:', '    build: .', '  db:', '    image: postgres:16'].join('\n'));
  write('app/src/index.js', 'console.log(1)');
  write('app/node_modules/left-pad/index.js', 'y'.repeat(4096));
  write('app/dist/bundle.js', 'z'.repeat(2048));
  // Git internals must never be walked into or reported.
  write('app/.git/objects/ab/cdef', 'binary');
  write('app/.git/build/config', 'this dir is named like an artifact but is git internals');

  // Compose at the top, the real project one level down.
  write('infra/docker-compose.yml', ['services:', '  proxy:', '    image: nginx'].join('\n'));
  write('infra/service/go.mod', 'module demo\n');
  write('infra/service/vendor/lib.go', 'package lib');

  write('notes/readme.md', 'not a project');
  return root;
}

const ROOT = buildFixture();
const scan = () => scanner.scanProjects(ROOT, null, new AbortController().signal);
const byName = (projects, name) => projects.find((p) => p.name === name);

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('projects, artifacts and Docker facts come out of one walk', async () => {
  const { projects } = await scan();
  const app = byName(projects, 'app');

  assert.ok(app, 'the Node project was not detected');
  assert.equal(app.type.id, 'node');
  assert.equal(app.isGit, true);

  const names = app.items.map((i) => i.name).sort();
  assert.deepEqual(names, ['dist', 'node_modules']);
  assert.ok(app.items.every((i) => i.size > 0), 'every artifact should be measured');
  assert.equal(app.cleanableSize, app.items.reduce((s, i) => s + i.size, 0));
  // Largest first, which is what the UI renders.
  assert.ok(app.items[0].size >= app.items[app.items.length - 1].size);
});

test('git internals are never reported as artifacts', async () => {
  const { projects } = await scan();
  const app = byName(projects, 'app');
  assert.ok(!app.items.some((i) => i.path.includes('.git')), '.git/build must not be listed');
});

test('a Dockerised project carries its Docker facts', async () => {
  const { projects } = await scan();
  const app = byName(projects, 'app');

  assert.ok(app.docker, 'expected Docker facts on a project with a Dockerfile');
  assert.equal(app.docker.compose, true);
  assert.deepEqual(app.docker.dockerfiles, ['Dockerfile']);
  assert.deepEqual(app.docker.composeFiles, ['docker-compose.yml']);
  assert.equal(app.docker.hasDockerignore, true);
  assert.deepEqual(app.docker.services, ['api', 'db']);
  // Engine storage is attached separately, after one daemon call per scan.
  assert.equal(app.docker.usage, null);
});

test('a compose-only folder is recorded but does not stop the walk', async () => {
  const { projects } = await scan();
  const infra = byName(projects, 'infra');
  const service = byName(projects, 'service');

  assert.ok(infra, 'the compose-only folder should still be recorded');
  assert.equal(infra.dockerOnly, true);
  assert.equal(infra.type.id, 'docker');
  assert.deepEqual(infra.items, [], 'it owns no artifacts of its own');
  assert.deepEqual(infra.docker.services, ['proxy']);

  // The regression this guards: treating compose as a project marker hid every
  // project underneath it.
  assert.ok(service, 'the project below the compose file must still be found');
  assert.equal(service.type.id, 'go');
  assert.ok(service.items.some((i) => i.name === 'vendor'));
});

test('folders without markers are not projects', async () => {
  const { projects } = await scan();
  assert.equal(byName(projects, 'notes'), undefined);
});

test('a project with neither artifacts nor Docker is still plain', async () => {
  const { projects } = await scan();
  const service = byName(projects, 'service');
  assert.equal(service.docker, null);
});

test('engine storage attaches to the project it belongs to', async () => {
  const { projects } = await scan();
  const app = byName(projects, 'app');

  const inventory = {
    ok: true,
    images: [{ id: 'i1', repository: 'app-api', tag: 'latest', bytes: 600, uniqueBytes: 600, sharedBytes: 0, containers: 1, dangling: false }],
    containers: [{
      id: 'c1', name: 'app-api-1', image: 'app-api:latest', bytes: 40, running: true,
      project: 'app', workingDir: app.path, service: 'api',
    }],
    volumes: [{ name: 'app_pgdata', bytes: 900, links: 1, project: 'app', anonymous: false }],
    buildCache: [],
  };

  const { attached } = await scanner.attachDockerUsage(projects, { inventory });
  assert.equal(attached, 1);
  assert.equal(app.docker.usage.totalBytes, 1540);
  assert.equal(app.docker.usage.images, 1);
  assert.equal(app.docker.usage.volumes, 1);
  assert.equal(app.docker.usage.running, 1);
  // Nothing was invented for the projects Docker knows nothing about.
  assert.equal(byName(projects, 'service').docker, null);
});

test('attaching usage is a no-op when Docker is unavailable', async () => {
  const { projects } = await scan();
  const res = await scanner.attachDockerUsage(projects, { inventory: { ok: false, reason: 'not-installed' } });
  assert.equal(res.attached, 0);
  assert.ok(projects.every((p) => !p.docker || p.docker.usage === null));
});

test('the walk scheduler stays inside its concurrency limit and misses nothing', async () => {
  const seen = [];
  let active = 0;
  let peak = 0;

  // A three-level tree expressed as work items, so the scheduler is exercised
  // the same way a directory tree exercises it.
  const children = { root: ['a', 'b', 'c'], a: ['a1', 'a2'], b: ['b1'], c: [], a1: [], a2: [], b1: [] };
  await scanner.drain(['root'], 2, async (item) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(item);
    active--;
    return children[item];
  });

  assert.deepEqual(seen.sort(), ['a', 'a1', 'a2', 'b', 'b1', 'c', 'root']);
  assert.ok(peak <= 2, `concurrency cap exceeded: ${peak}`);
});

test('an aborted scan stops early instead of running to completion', async () => {
  const ac = new AbortController();
  ac.abort();
  const { projects, scanned } = await scanner.scanProjects(ROOT, null, ac.signal);
  assert.equal(projects.length, 0);
  assert.equal(scanned, 0);
});

test('directory sizing agrees with a plain walk', async () => {
  const dir = path.join(ROOT, 'app', 'node_modules');
  const fast = await scanner.dirSize(dir);
  const walked = await scanner.walkSize(dir);
  assert.ok(fast > 0 && walked > 0);
  // du reports blocks actually occupied, a walk sums apparent bytes, so they
  // differ by allocation overhead rather than by an order of magnitude.
  assert.ok(fast >= walked, 'block usage should not be below apparent size for plain files');
});
