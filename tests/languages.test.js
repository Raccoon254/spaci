'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { analyzeProject, quickPrimary } = require('../src/languages');
const scanner = require('../src/scanner');
const { ALL } = require('../src/tech-ids');

const CANON = new Set(ALL);
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env: gitEnv(), stdio: 'pipe' });

/** Build a fixture. `files` maps rel path to content (string) or a byte count (number). */
function fixture(files, { commit = true, untracked = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-lang-'));
  roots.push(root);
  const write = (rel, body) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'number' ? 'x'.repeat(body) : body);
  };
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  if (commit) {
    git(root, 'init', '-q');
    git(root, 'add', '--', ...Object.keys(files));
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  }
  for (const [rel, body] of Object.entries(untracked)) write(rel, body);
  return root;
}

const langIds = (r) => r.languages.map((l) => l.id);
const fwIds = (r) => r.frameworks.map((f) => f.id);
function assertCanonical(r) {
  for (const l of r.languages) if (l.id !== 'other') assert.ok(CANON.has(l.id), `language ${l.id} is not canonical`);
  for (const f of r.frameworks) assert.ok(CANON.has(f.id), `framework ${f.id} is not canonical`);
  if (r.primary) assert.ok(CANON.has(r.primary.id), `primary ${r.primary.id} is not canonical`);
  for (const f of r.frameworks) {
    assert.ok(['framework', 'library', 'runtime', 'tool', 'database', 'testing', 'styling', 'mobile', 'infra'].includes(f.category));
    assert.ok(f.evidence && typeof f.evidence === 'string');
  }
}

test('Next.js + TypeScript repo: primary nextjs, TS dominant, JSON and lockfiles excluded', async () => {
  const dir = fixture({
    'package.json': JSON.stringify({ dependencies: { next: '14.2.3', react: '^18.3.1' }, devDependencies: { typescript: '5', tailwindcss: '^3.4.0', eslint: '8' } }),
    'package-lock.json': 900000,
    'tsconfig.json': 5000,
    'data/big.json': 800000,
    'app/page.tsx': 6000,
    'app/layout.tsx': 2000,
    'lib/util.ts': 3000,
    'app/globals.css': 500,
    'next.config.mjs': 300,
    'README.md': 40000,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.analysis.source, 'git');
  assert.equal(r.primary.id, 'nextjs');
  assert.equal(r.languages[0].id, 'typescript');
  assert.equal(r.languages[0].bytes, 11000);
  assert.deepEqual(langIds(r), ['typescript', 'css', 'javascript']);
  assert.equal(r.analysis.totalBytes, 11800);
  assert.ok(fwIds(r).includes('react') && fwIds(r).includes('tailwind') && fwIds(r).includes('npm'));
  const next = r.frameworks.find((f) => f.id === 'nextjs');
  assert.equal(next.evidence, 'package.json dependency next 14.2.3');
  assert.equal(next.category, 'framework');
  const sum = r.languages.reduce((s, l) => s + l.percent, 0);
  assert.ok(Math.abs(sum - 100) < 0.5, `percent sums to ${sum}`);
  assert.equal(r.languages[0].color, '#3178c6');
});

test('SvelteKit repo', async () => {
  const dir = fixture({
    'package.json': JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0', svelte: '^4.2.0', vite: '^5.0.0' } }),
    'pnpm-lock.yaml': 50000,
    'src/routes/+page.svelte': 4000,
    'src/lib/api.ts': 1500,
    'svelte.config.js': 200,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.primary.id, 'sveltekit');
  assert.equal(r.languages[0].id, 'svelte');
  assert.ok(fwIds(r).includes('svelte-lib') && fwIds(r).includes('vite') && fwIds(r).includes('pnpm'));
});

test('Django repo', async () => {
  const dir = fixture({
    'requirements.txt': 'Django>=4.2,<5\npsycopg[binary]==3.1\n# comment\npytest==8.0\n',
    'manage.py': "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'site.settings')\n",
    'site/settings.py': 3000,
    'site/views.py': 2000,
    'site/__pycache__/views.cpython-312.pyc': 9000,
    'templates/index.html': 800,
    'docker-compose.yml': 'services:\n  web:\n    build: .\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7-alpine\n',
    'Dockerfile': 'FROM python:3.12\n',
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.primary.id, 'django');
  assert.equal(r.languages[0].id, 'python');
  const dj = r.frameworks.find((f) => f.id === 'django');
  assert.match(dj.evidence, /requirements\.txt dependency django >=4\.2/);
  for (const id of ['pytest', 'docker', 'docker-compose', 'postgres', 'redis']) assert.ok(fwIds(r).includes(id), id);
  assert.match(r.frameworks.find((f) => f.id === 'postgres').evidence, /image postgres:16/);
});

test('Flutter repo counts .dart but not generated .g.dart / .freezed.dart', async () => {
  const dir = fixture({
    'pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.0.0\n',
    'lib/main.dart': 5000,
    'lib/model.g.dart': 90000,
    'lib/model.freezed.dart': 90000,
    'android/app/build.gradle': "plugins { id 'com.android.application' }\n",
    'android/app/src/main/kotlin/MainActivity.kt': 300,
    'ios/Runner/AppDelegate.swift': 400,
    '.dart_tool/package_config.dart': 50000,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.primary.id, 'flutter');
  const dart = r.languages.find((l) => l.id === 'dart');
  assert.equal(dart.bytes, 5000);
  assert.ok(fwIds(r).includes('android'));
});

test('Rust axum repo', async () => {
  const dir = fixture({
    'Cargo.toml': '[package]\nname = "svc"\n\n[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\n',
    'Cargo.lock': 60000,
    'src/main.rs': 7000,
    'target/debug/build.rs': 99999,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.primary.id, 'axum');
  assert.deepEqual(langIds(r), ['rust']);
  assert.equal(r.languages[0].bytes, 7000);
  assert.equal(r.frameworks.find((f) => f.id === 'axum').evidence, 'Cargo.toml dependency axum 0.7');
  assert.ok(fwIds(r).includes('cargo'));
});

test('Go gin repo, generated .pb.go excluded', async () => {
  const dir = fixture({
    'go.mod': 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n',
    'go.sum': 30000,
    'main.go': 3000,
    'api/api.pb.go': 80000,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.primary.id, 'gin');
  assert.deepEqual(langIds(r), ['go']);
  assert.equal(r.languages[0].bytes, 3000);
  assert.match(r.frameworks[0].evidence, /go\.mod require github\.com\/gin-gonic\/gin v1\.9\.1/);
});

test('Laravel repo, vendor excluded', async () => {
  const dir = fixture({
    'composer.json': JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.0' } }),
    'composer.lock': 200000,
    'app/Http/Kernel.php': 4000,
    'resources/views/welcome.blade.php': 3000,
    'resources/js/app.js': 500,
    'vendor/laravel/framework/src/Foundation.php': 500000,
    'package.json': JSON.stringify({ devDependencies: { vite: '^5', 'laravel-vite-plugin': '^1' } }),
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.primary.id, 'laravel');
  assert.equal(r.languages[0].id, 'php');
  assert.equal(r.languages[0].bytes, 7000);
});

test('Android Kotlin repo', async () => {
  const dir = fixture({
    'settings.gradle.kts': 'include(":app")\n',
    'build.gradle.kts': 'plugins {\n  id("com.android.application") version "8.4.0" apply false\n}\n',
    'app/build.gradle.kts': 'plugins { id("com.android.application") }\n',
    'app/src/main/java/com/x/MainActivity.kt': 8000,
    'app/src/main/res/layout/main.xml': 20000,
    'gradlew': 8000,
    'app/build/generated/R.java': 100000,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.primary.id, 'android');
  assert.equal(r.languages[0].id, 'kotlin');
  assert.ok(!langIds(r).includes('java'), 'build/ output and gradlew must not count');
  assert.ok(fwIds(r).includes('gradle'));
});

test('monorepo: workspace manifests are read', async () => {
  const dir = fixture({
    'package.json': JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'], devDependencies: { turbo: '^2' } }),
    'yarn.lock': 10000,
    'apps/web/package.json': JSON.stringify({ dependencies: { next: '15.0.0', react: '19' } }),
    'apps/web/app/page.tsx': 3000,
    'apps/api/package.json': JSON.stringify({ dependencies: { '@nestjs/core': '^10', '@prisma/client': '^5' } }),
    'apps/api/src/main.ts': 3000,
    'packages/ui/package.json': '{ this is not json',
    'packages/ui/src/button.tsx': 1000,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  for (const id of ['turbo', 'yarn', 'nextjs', 'react', 'nestjs', 'prisma']) assert.ok(fwIds(r).includes(id), id);
  assert.equal(r.primary.id, 'nextjs');
  assert.match(r.frameworks.find((f) => f.id === 'nextjs').evidence, /^apps\/web\/package\.json dependency next 15\.0\.0$/);
});

test('non-git folder: walk, node_modules and dist excluded, symlinks not followed', async () => {
  const dir = fixture({
    'package.json': JSON.stringify({ dependencies: { express: '^4.19.0' } }),
    'src/server.js': 4000,
    'src/db.sql': 1000,
    'node_modules/express/index.js': 300000,
    'dist/server.js': 300000,
    'public/app.min.js': 300000,
    'yarn.lock': 50000,
  }, { commit: false });
  fs.symlinkSync(path.join(dir, 'node_modules'), path.join(dir, 'linked'));
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.equal(r.analysis.source, 'walk');
  assert.equal(r.primary.id, 'express');
  assert.deepEqual(r.languages.map((l) => [l.id, l.bytes]), [['javascript', 4000], ['sql', 1000]]);
  assert.deepEqual(r.languages.map((l) => l.percent), [80, 20]);
});

test('git repo with no commits falls back to the walk', async () => {
  const dir = fixture({ 'main.py': 100 }, { commit: false });
  git(dir, 'init', '-q');
  const r = await analyzeProject(dir);
  assert.equal(r.analysis.source, 'walk');
  assert.deepEqual(langIds(r), ['python']);
});

test('git source counts committed files only', async () => {
  const dir = fixture({ 'a.rb': 100 }, { untracked: { 'b.py': 5000 } });
  const r = await analyzeProject(dir);
  assert.deepEqual(langIds(r), ['ruby']);
});

test('.h is C without C++ sources, C++ with them; .m is MATLAB alone', async () => {
  const c = await analyzeProject(fixture({ 'lib.c': 1000, 'lib.h': 500 }));
  assert.deepEqual(c.languages.map((l) => [l.id, l.bytes]), [['c', 1500]]);
  const cpp = await analyzeProject(fixture({ 'lib.cpp': 1000, 'lib.h': 500, 'main.c': 200 }));
  assert.deepEqual(cpp.languages.map((l) => [l.id, l.bytes]), [['cpp', 1500], ['c', 200]]);
  const objc = await analyzeProject(fixture({ 'View.m': 1000, 'View.h': 300 }));
  assert.deepEqual(objc.languages.map((l) => [l.id, l.bytes]), [['objective-c', 1300]]);
  const matlab = await analyzeProject(fixture({ 'solve.m': 1000 }));
  assert.deepEqual(langIds(matlab), ['matlab']);
});

test('malformed package.json never throws', async () => {
  const dir = fixture({ 'package.json': '{"dependencies": {"react": ', 'index.js': 100 });
  const r = await analyzeProject(dir);
  assert.deepEqual(langIds(r), ['javascript']);
  assert.equal(r.primary.id, 'javascript');
});

test('at most 8 languages plus other', async () => {
  const files = {};
  ['a.ts', 'b.js', 'c.py', 'd.rs', 'e.go', 'f.rb', 'g.php', 'h.java', 'i.kt', 'j.swift'].forEach((f, i) => { files[f] = 1000 * (10 - i); });
  const r = await analyzeProject(fixture(files));
  assert.equal(r.languages.length, 9);
  assert.equal(r.languages[8].id, 'other');
  assert.equal(r.languages[8].bytes, 2000 + 1000);
});

test('tiny maxFiles truncates the git listing', async () => {
  const files = {};
  for (let i = 0; i < 20; i++) files[`src/f${i}.js`] = 10;
  const dir = fixture(files);
  const r = await analyzeProject(dir, { maxFiles: 5 });
  assert.equal(r.analysis.truncated, true);
  assert.equal(r.analysis.fileCount, 5);
});

test('budget: a slow fs yields a partial, truncated walk instead of hanging', async () => {
  const files = {};
  for (let i = 0; i < 30; i++) files[`d${i}/f.py`] = 10;
  const dir = fixture(files, { commit: false });
  const slowFs = {
    readdir: (...a) => new Promise((res) => setTimeout(res, 40)).then(() => fs.promises.readdir(...a)),
    lstat: (...a) => fs.promises.lstat(...a),
    readFile: (...a) => fs.promises.readFile(...a),
  };
  const started = Date.now();
  const r = await analyzeProject(dir, { fs: slowFs, budgetMs: 60, exec: async () => ({ err: new Error('no git'), stdout: '' }) });
  assert.ok(Date.now() - started < 1000, 'must return near the budget');
  assert.equal(r.analysis.truncated, true);
  assert.equal(r.analysis.source, 'walk');
});

test('abort signal stops the analysis', async () => {
  const dir = fixture({ 'a.js': 10 });
  const ac = new AbortController();
  ac.abort();
  const r = await analyzeProject(dir, { signal: ac.signal });
  assert.equal(r.analysis.truncated, true);
});

test('kubernetes needs apiVersion + kind, terraform from *.tf', async () => {
  const dir = fixture({
    'k8s/deploy.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n',
    'deploy/values.yaml': 'replicas: 2\n',
    'infra/main.tf': 'resource "x" "y" {}\n',
    'main.go': 10,
  });
  const r = await analyzeProject(dir);
  assertCanonical(r);
  assert.ok(fwIds(r).includes('kubernetes'));
  assert.ok(fwIds(r).includes('terraform'));
  assert.match(r.frameworks.find((f) => f.id === 'kubernetes').evidence, /^k8s\/deploy\.yaml/);

  const none = await analyzeProject(fixture({ 'k8s/values.yaml': 'a: 1\n', 'main.go': 10 }));
  assert.ok(!fwIds(none).includes('kubernetes'));
});

test('quickPrimary reads root manifests only', async () => {
  const dir = fixture({ 'package.json': JSON.stringify({ devDependencies: { electron: '^31' } }) }, { commit: false });
  assert.deepEqual(await quickPrimary(dir, ['package.json']), { id: 'electron', name: 'Electron' });
  const ts = fixture({ 'package.json': '{}', 'tsconfig.json': '{}' }, { commit: false });
  assert.deepEqual(await quickPrimary(ts, ['package.json', 'tsconfig.json']), { id: 'typescript', name: 'TypeScript' });
  assert.equal(await quickPrimary(ts, []), null);
});

test('enrichProject carries the analysis and reuses it while HEAD is unchanged', async () => {
  const dir = fixture({ 'Gemfile': "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n", 'app/models/user.rb': 2000 });
  const first = await scanner.enrichProject(dir, new AbortController().signal);
  assert.equal(first.primary.id, 'rails');
  assert.equal(first.languages[0].id, 'ruby');
  assert.ok(first.totalSize > 0);
  assert.ok(first.git);
  const again = await scanner.enrichProject(dir, new AbortController().signal);
  assert.equal(again.analysis.analyzedAt, first.analysis.analyzedAt, 'second open should hit the cache');

  fs.writeFileSync(path.join(dir, 'app/models/post.py'), 'x'.repeat(9000));
  git(dir, 'add', '--', 'app/models/post.py');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'two');
  const after = await scanner.enrichProject(dir, new AbortController().signal);
  assert.equal(after.languages[0].id, 'python', 'a new commit invalidates the cache');
});

test('scan sets a lightweight primary on each project', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-lang-scan-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'web'));
  fs.writeFileSync(path.join(root, 'web/package.json'), JSON.stringify({ dependencies: { next: '14' } }));
  fs.mkdirSync(path.join(root, 'svc'));
  fs.writeFileSync(path.join(root, 'svc/go.mod'), 'module svc\n');
  const { projects } = await scanner.scanProjects(root, null, new AbortController().signal);
  const by = Object.fromEntries(projects.map((p) => [p.name, p.primary && p.primary.id]));
  assert.deepEqual(by, { web: 'nextjs', svc: 'go' });
});
