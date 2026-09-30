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

// ---------------------------------------------------------------------------
// Build-output verification: a name alone never makes a directory cleanable.
// Safe needs positive evidence from the innermost repo: git ignores the folder
// and tracks nothing inside it. Every fixture is a real repo under os.tmpdir().
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Spaci Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Spaci Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};
function git(cwd, ...args) {
  execFileSync('git', [
    '-C', cwd, '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args,
  ], { stdio: 'ignore', env: GIT_ENV });
}
const gitOut = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' });

const TMP_ROOTS = [];
test.after(() => { for (const r of TMP_ROOTS) fs.rmSync(r, { recursive: true, force: true }); });
function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-git-'));
  TMP_ROOTS.push(r);
  return r;
}
function write(base, rel, body = 'x') {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

/** Scan `root` and return the items of the project at `proj`. */
async function itemsAt(root, proj) {
  const { projects } = await scanner.scanProjects(root, null, new AbortController().signal);
  const p = projects.find((x) => x.path === proj);
  assert.ok(p, `project ${proj} is detected`);
  return p.items;
}
const safeAt = (items, full) => items.some((i) => i.path === full && i.safe);

/** Throwaway project, optionally a git repo with everything staged. */
function makeRepo({ git: isGit, files, ignore }) {
  const root = tmpRoot();
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{"name":"proj"}');
  if (ignore) write(proj, '.gitignore', ignore);
  for (const [rel, body] of Object.entries(files)) write(proj, rel, body);
  if (isGit) { git(proj, 'init', '-q'); git(proj, 'add', '-A'); }
  return { root, proj };
}
const scanOne = ({ root, proj }) => itemsAt(root, proj);

test('a git-tracked build/ is never offered', async () => {
  const items = await scanOne(makeRepo({ git: true, files: { 'build/entitlements.mac.plist': '<plist/>' } }));
  assert.equal(items.find((i) => i.name === 'build'), undefined);
});

test('a gitignored build/ with output is offered and safe', async () => {
  const items = await scanOne(makeRepo({
    git: true, ignore: 'build/\n', files: { 'build/out.bin': 'y'.repeat(2048) },
  }));
  const build = items.find((i) => i.name === 'build');
  assert.ok(build, 'ignored build output is offered');
  assert.equal(build.safe, true);
});

test('an ignored node_modules/ is safe', async () => {
  const items = await scanOne(makeRepo({
    git: true, ignore: 'node_modules/\n', files: { 'node_modules/left-pad/index.js': 'y' },
  }));
  assert.equal(items.find((i) => i.name === 'node_modules')?.safe, true);
});

test('a git-tracked vendor/ is never offered', async () => {
  const items = await scanOne(makeRepo({ git: true, files: { 'vendor/lib.go': 'package lib' } }));
  assert.equal(items.find((i) => i.name === 'vendor'), undefined);
});

test('a tracked file deep inside a candidate blocks it, siblings stay offered', async () => {
  const items = await scanOne(makeRepo({
    git: true, ignore: 'dist/\n',
    files: { 'build/a/b/keep.txt': 'k', 'dist/bundle.js': 'z' },
  }));
  assert.deepEqual(items.map((i) => i.name), ['dist']);
});

test('reviewer: repo with no commits, never-added build/entitlements.mac.plist is not safe', async () => {
  const root = tmpRoot();
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{}');
  write(proj, 'build/entitlements.mac.plist', '<plist/>');
  git(proj, 'init', '-q');
  const items = await itemsAt(root, proj);
  const build = items.find((i) => i.name === 'build');
  assert.ok(build, 'listed for review');
  assert.equal(build.safe, false);
  assert.match(build.note, /could not verify/i);
});

test('reviewer: source added but not committed is not offered', async () => {
  const root = tmpRoot();
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{}');
  write(proj, 'build/main.js', 'new source');
  write(proj, 'dist/new-idea.js', 'never added, not ignored');
  git(proj, 'init', '-q');
  git(proj, 'add', 'build/main.js');
  const items = await itemsAt(root, proj);
  assert.equal(items.find((i) => i.name === 'build'), undefined, 'staged content blocks it');
  assert.equal(items.find((i) => i.name === 'dist')?.safe, false, 'untracked is not build output');
});

test('reviewer: a nested independent repo decides for its own dist/', async () => {
  const root = tmpRoot();
  const a = path.join(root, 'A');
  write(a, 'package.json', '{}');
  write(a, '.gitignore', 'dist/\n');
  write(a, 'dist/out.js', 'output');
  git(a, 'init', '-q'); git(a, 'add', '-A'); git(a, 'commit', '-qm', 'a');
  const inner = path.join(a, 'libs', 'inner');
  write(inner, 'dist/index.js', 'published library entry');
  git(inner, 'init', '-q'); git(inner, 'add', '-A'); git(inner, 'commit', '-qm', 'inner');

  const items = await itemsAt(root, a);
  assert.equal(safeAt(items, path.join(inner, 'dist')), false);
  assert.equal(items.find((i) => i.path === path.join(inner, 'dist')), undefined, 'tracked in inner');
  assert.equal(safeAt(items, path.join(a, 'dist')), true, 'the parent repo still owns its own dist/');
});

test('reviewer: a submodule with tracked dist/ is not offered', async () => {
  const lib = path.join(tmpRoot(), 'lib');
  write(lib, 'dist/index.js', 'library build, committed');
  git(lib, 'init', '-q'); git(lib, 'add', '-A'); git(lib, 'commit', '-qm', 'lib');

  const root = tmpRoot();
  const p = path.join(root, 'P');
  write(p, 'package.json', '{}');
  write(p, '.gitignore', 'dist/\n');
  git(p, 'init', '-q'); git(p, 'add', '-A'); git(p, 'commit', '-qm', 'p');
  git(p, 'submodule', 'add', '-q', lib, 'libs/sub');
  git(p, 'commit', '-qm', 'sub');
  const sub = path.join(p, 'libs', 'sub');
  assert.ok(fs.statSync(path.join(sub, '.git')).isFile(), 'submodule uses a .git file');

  const items = await itemsAt(root, p);
  assert.equal(safeAt(items, path.join(sub, 'dist')), false);
});

test('reviewer: a parent repo ignoring the whole project tells us nothing', async () => {
  const root = tmpRoot();
  write(root, '.gitignore', '*\n');
  git(root, 'init', '-q');
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{}');
  write(proj, '.gitignore', 'build/\nnode_modules/\n');
  write(proj, 'build/entitlements.mac.plist', '<plist/>');
  write(proj, 'node_modules/x/index.js', 'x');

  const items = await itemsAt(root, proj);
  assert.ok(items.length >= 2);
  assert.ok(items.every((i) => i.safe === false), 'no candidate may be safe');
});

test('reviewer: NFD names on the path still find the tracked dist/', async () => {
  const root = tmpRoot();
  const proj = path.join(root, 'Café'.normalize('NFD'));
  const sub = path.join(proj, 'Résumé'.normalize('NFD'));
  write(proj, 'package.json', '{}');
  write(proj, '.gitignore', 'dist/\n');
  write(sub, 'dist/app.js', 'force-added');
  git(proj, 'init', '-q'); git(proj, 'add', '-A');
  git(proj, 'add', '-f', path.relative(proj, path.join(sub, 'dist', 'app.js')));
  git(proj, 'commit', '-qm', 'nfd');
  assert.match(gitOut(proj, 'ls-files'), /dist\/app\.js/, 'fixture really tracks the file');

  const { projects } = await scanner.scanProjects(root, null, new AbortController().signal);
  const p = projects.find((x) => x.path.normalize('NFC') === proj.normalize('NFC'));
  assert.ok(p, 'NFD project detected');
  assert.ok(!p.items.some((i) => i.name === 'dist' && i.safe), 'tracked dist/ under NFD must not be safe');
});

test('reviewer: with git unavailable, committed Pods/ and target/ are not safe', async () => {
  const root = tmpRoot();
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{}');
  write(proj, 'Cargo.toml', '[package]\nname = "x"\n');
  write(proj, 'Pods/Manifest.lock', 'committed');
  write(proj, 'target/keep.rs', 'committed');
  git(proj, 'init', '-q'); git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'c');

  const empty = fs.mkdtempSync(path.join(root, 'nopath-'));
  const saved = process.env.PATH;
  process.env.PATH = empty;
  let items;
  try { items = await itemsAt(root, proj); } finally { process.env.PATH = saved; }
  for (const name of ['Pods', 'target']) {
    const it = items.find((i) => i.name === name);
    assert.ok(it, `${name} listed for review`);
    assert.equal(it.safe, false, `${name} must not be safe without git`);
    assert.match(it.note, /could not verify/i);
  }
});

test('reviewer: a force-added file inside an ignored build/ blocks it', async () => {
  const root = tmpRoot();
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{}');
  write(proj, '.gitignore', 'build/\n');
  write(proj, 'build/out.bin', 'output');
  write(proj, 'build/entitlements.mac.plist', '<plist/>');
  git(proj, 'init', '-q'); git(proj, 'add', '-A');
  git(proj, 'add', '-f', 'build/entitlements.mac.plist');
  git(proj, 'commit', '-qm', 'c');
  const items = await itemsAt(root, proj);
  assert.equal(safeAt(items, path.join(proj, 'build')), false);
  assert.equal(items.find((i) => i.name === 'build'), undefined);
});

test('a .git-file worktree with an ignored dist/ is safe', async () => {
  const root = tmpRoot();
  const main = path.join(root, 'main');
  write(main, 'package.json', '{}');
  write(main, '.gitignore', 'dist/\n');
  git(main, 'init', '-q'); git(main, 'add', '-A'); git(main, 'commit', '-qm', 'c');
  const wt = path.join(root, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), 'worktree uses a .git file');
  write(wt, 'dist/bundle.js', 'output');
  const items = await itemsAt(root, wt);
  assert.equal(safeAt(items, path.join(wt, 'dist')), true);
});

test('outside git, every candidate is offered but not marked safe', async () => {
  const items = await scanOne(makeRepo({
    git: false,
    files: { 'build/out.bin': 'y', '.svelte-kit/output/a.js': 'x', 'pkg/__pycache__/m.pyc': 'x' },
  }));
  assert.deepEqual(items.map((i) => i.name).sort(), ['.svelte-kit', '__pycache__', 'build']);
  assert.ok(items.every((i) => i.safe === false));
  assert.ok(items.every((i) => /could not verify/i.test(i.note)));
});

test('.svelte-kit and __pycache__ are detected and safe when ignored', async () => {
  const items = await scanOne(makeRepo({
    git: true, ignore: '.svelte-kit/\n__pycache__/\n',
    files: { '.svelte-kit/output/a.js': 'x', 'pkg/__pycache__/m.pyc': 'x' },
  }));
  assert.deepEqual(items.map((i) => i.name).sort(), ['.svelte-kit', '__pycache__']);
  assert.ok(items.every((i) => i.safe === true));
});

test('revalidateArtifact re-checks one path at clean time', async () => {
  const root = tmpRoot();
  const proj = path.join(root, 'proj');
  write(proj, 'package.json', '{}');
  write(proj, '.gitignore', 'build/\n');
  write(proj, 'build/out.bin', 'output');
  git(proj, 'init', '-q'); git(proj, 'add', '-A'); git(proj, 'commit', '-qm', 'c');
  const build = path.join(proj, 'build');

  assert.deepEqual(await scanner.revalidateArtifact(build), { ok: true });

  write(proj, 'build/new-entitlements.plist', '<plist/>');
  git(proj, 'add', '-f', 'build/new-entitlements.plist');
  const tracked = await scanner.revalidateArtifact(build);
  assert.equal(tracked.ok, false);
  assert.match(tracked.reason, /tracked/i);

  const plain = path.join(tmpRoot(), 'plain');
  write(plain, 'build/out.bin', 'output');
  const notRepo = await scanner.revalidateArtifact(path.join(plain, 'build'));
  assert.equal(notRepo.ok, false);
  assert.ok(notRepo.reason);

  const gone = await scanner.revalidateArtifact(path.join(proj, 'missing-build'));
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /no longer exists/i);
  fs.rmSync(build, { recursive: true, force: true });
  assert.equal((await scanner.revalidateArtifact(build)).ok, false);
});
