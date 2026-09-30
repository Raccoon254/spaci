'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/restore-hints');

test('node_modules: the most specific lockfile wins (pnpm > yarn > bun > npm)', () => {
  const hint = (files) => h.artifactRestoreHint('/p/node_modules', files, []);
  assert.equal(hint(['package.json', 'pnpm-lock.yaml']), 'pnpm install');
  assert.equal(hint(['yarn.lock']), 'yarn install');
  assert.equal(hint(['bun.lockb']), 'bun install');
  assert.equal(hint(['bun.lock']), 'bun install');
  assert.equal(hint(['package-lock.json']), 'npm ci');
  assert.equal(hint(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']), 'pnpm install');
  assert.equal(hint(['package-lock.json', 'yarn.lock']), 'yarn install');
  assert.equal(hint(['package-lock.json', 'bun.lock']), 'bun install');
});

test('node_modules: no lockfile falls back to npm install; a workspace root lockfile is found', () => {
  assert.equal(h.artifactRestoreHint('/p/node_modules', ['package.json'], []), 'npm install');
  assert.equal(h.artifactRestoreHint('/p/node_modules', undefined, undefined), 'npm install');
  assert.equal(h.artifactRestoreHint('/mono/packages/a/node_modules', ['package.json'], ['pnpm-lock.yaml']), 'pnpm install');
  // A lockfile beside the artifact beats one at the root.
  assert.equal(h.artifactRestoreHint('/mono/packages/a/node_modules', ['yarn.lock'], ['pnpm-lock.yaml']), 'yarn install');
});

test('Windows paths resolve the artifact name the same way', () => {
  assert.equal(h.artifactRestoreHint('C:\\Users\\me\\app\\node_modules', ['yarn.lock'], []), 'yarn install');
  assert.equal(h.artifactRestoreHint('C:\\Users\\me\\app\\target\\', ['Cargo.toml'], []), 'cargo build');
  assert.equal(h.baseName('C:\\a\\b\\'), 'b');
  assert.equal(h.baseName(''), '');
});

test('other artifacts get a sensible command or sentence by name', () => {
  assert.equal(h.artifactRestoreHint('/p/target', ['Cargo.toml'], []), 'cargo build');
  assert.equal(h.artifactRestoreHint('/p/target', ['pom.xml'], []), 'mvn package');
  assert.equal(h.artifactRestoreHint('/p/target', [], []), "Run the project's build");
  assert.equal(h.artifactRestoreHint('/p/.venv', ['uv.lock', 'poetry.lock'], []), 'uv sync');
  assert.equal(h.artifactRestoreHint('/p/.venv', ['poetry.lock'], []), 'poetry install');
  assert.match(h.artifactRestoreHint('/p/venv', ['requirements.txt'], []), /^python -m venv venv.*requirements\.txt/);
  assert.equal(h.artifactRestoreHint('/p/.venv', [], []), 'python -m venv .venv');
  assert.equal(h.artifactRestoreHint('/p/ios/Pods', ['Podfile'], []), 'pod install');
  for (const n of ['build', 'dist', '.next', 'out']) assert.equal(h.artifactRestoreHint('/p/' + n, [], []), "Run the project's build");
  assert.equal(h.artifactRestoreHint('/p/build', ['build.gradle', 'gradlew'], []), './gradlew build');
  assert.equal(h.artifactRestoreHint('/p/.gradle', [], []), 'gradle build');
  assert.equal(h.artifactRestoreHint('/p/.dart_tool', ['pubspec.yaml'], []), 'flutter pub get');
  assert.equal(h.artifactRestoreHint('/p/vendor', ['composer.json'], []), 'composer install');
  assert.equal(h.artifactRestoreHint('/p/vendor', ['go.mod'], []), 'go mod vendor');
  assert.equal(h.artifactRestoreHint('/p/obj', [], []), 'dotnet build');
  assert.equal(h.artifactRestoreHint('/p/.terraform', [], []), 'terraform init');
  assert.match(h.artifactRestoreHint('/p/__pycache__', [], []), /Regenerates automatically/);
  assert.match(h.artifactRestoreHint('/p/something-new', [], []), /Rebuilds the next time/);
});

test('system targets: a hint only when the clean can be rebuilt', () => {
  assert.equal(h.systemRestoreHint({ id: 'npm', reversible: true }), 'Regenerates automatically when the owning app runs.');
  assert.equal(h.systemRestoreHint({ id: 'user-logs', reversible: true, restoreHint: 'Apps start new logs.' }), 'Apps start new logs.');
  assert.equal(h.systemRestoreHint({ id: 'trash', reversible: false }), null);
  assert.equal(h.systemRestoreHint(null), null);
});

test('docker: build cache and dangling images rebuild, stopped containers do not', () => {
  assert.equal(h.dockerRestoreHint('build-cache'), 'Docker rebuilds this cache the next time you build.');
  assert.equal(h.dockerRestoreHint('dangling-images'), 'Docker rebuilds this cache the next time you build.');
  assert.equal(h.dockerRestoreHint('stopped-containers'), null);
});

test('no hint promises a one-click restore or contains an em dash', () => {
  const all = [h.SYSTEM_CACHE_HINT, h.TRASH_HINT, h.DOCKER_HINT,
    ...['node_modules', 'target', '.venv', 'Pods', 'build', 'coverage', 'DerivedData', 'x'].map((n) => h.artifactRestoreHint('/p/' + n, [], []))];
  for (const s of all) {
    assert.doesNotMatch(s, /one click|one-click/i);
    assert.doesNotMatch(s, /\u2014/);
  }
});
