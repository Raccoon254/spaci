'use strict';
/**
 * How to get something back after Spaci removed it, as one short line for the
 * History screen. Never a promise that Spaci restores anything: it names the
 * command the user runs, or says the item regenerates by itself.
 *
 * Pure: the caller lists the files it found, so this is tested without a disk.
 */

const SYSTEM_CACHE_HINT = 'Regenerates automatically when the owning app runs.';
const TRASH_HINT = 'Still in your Trash: put it back from there. The space is freed only when the Trash is emptied.';
const DOCKER_HINT = 'Docker rebuilds this cache the next time you build.';
const DOCKER_IMAGES_HINT = 'Docker downloads or rebuilds these images the next time a container or build needs them.';
const GENERIC_BUILD_HINT = "Run the project's build";
const FALLBACK_HINT = 'Rebuilds the next time you build or install this project.';

// Most specific first: a pnpm or yarn project often still has a stray
// package-lock.json, and `npm ci` there would install the wrong tree.
const NODE_LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm install'],
  ['yarn.lock', 'yarn install'],
  ['bun.lockb', 'bun install'],
  ['bun.lock', 'bun install'],
  ['package-lock.json', 'npm ci'],
];

const BUILD_OUTPUT = new Set(['build', 'dist', 'out', '.next', '.nuxt', '.output', '.svelte-kit', '.angular', '.turbo', '.parcel-cache']);
const PYTHON_CACHES = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const VENVS = new Set(['.venv', 'venv']);

/** Basename of a POSIX or Windows path, whichever separator it uses. */
function baseName(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function fileSet(list) {
  const s = new Set();
  for (const f of Array.isArray(list) ? list : []) if (typeof f === 'string' && f) s.add(f);
  return s;
}

/**
 * First lockfile rule that matches the folder beside the artifact, else the
 * project root (workspaces keep one lockfile at the top).
 */
function pick(rules, near, root) {
  for (const files of [near, root]) {
    for (const [file, hint] of rules) if (files.has(file)) return hint;
  }
  return null;
}

function has(near, root, ...names) {
  return names.some((n) => near.has(n) || root.has(n));
}

function nodeModulesHint(near, root) {
  return pick(NODE_LOCKFILES, near, root) || 'npm install';
}

function venvHint(name, near, root) {
  if (has(near, root, 'uv.lock')) return 'uv sync';
  if (has(near, root, 'poetry.lock')) return 'poetry install';
  if (has(near, root, 'Pipfile.lock', 'Pipfile')) return 'pipenv install';
  if (has(near, root, 'requirements.txt')) return `python -m venv ${name}, activate it, then pip install -r requirements.txt`;
  return `python -m venv ${name}`;
}

/**
 * Restore hint for a project artifact.
 * artifactPath: the removed folder. nearFiles: names in the folder that held
 * it. rootFiles: names in the project root (may be the same folder).
 */
function artifactRestoreHint(artifactPath, nearFiles, rootFiles) {
  const name = baseName(artifactPath);
  const near = fileSet(nearFiles);
  const root = fileSet(rootFiles);
  if (!name) return FALLBACK_HINT;

  if (name === 'node_modules') return nodeModulesHint(near, root);
  if (VENVS.has(name)) return venvHint(name, near, root);
  if (PYTHON_CACHES.has(name)) return 'Regenerates automatically the next time the tool runs.';
  if (name === 'Pods') return 'pod install';
  if (name === '.dart_tool') return has(near, root, 'pubspec.yaml') ? 'flutter pub get' : 'dart pub get';
  if (name === '.terraform') return 'terraform init';
  if (name === 'coverage') return 'Run the tests with coverage again.';
  if (name === 'DerivedData') return 'Rebuilds the next time you build in Xcode.';
  if (name === 'target') {
    if (has(near, root, 'Cargo.toml')) return 'cargo build';
    if (has(near, root, 'pom.xml')) return 'mvn package';
    return GENERIC_BUILD_HINT;
  }
  if (name === '.gradle' || (name === 'build' && has(near, root, 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'))) {
    return has(near, root, 'gradlew', 'gradlew.bat') ? './gradlew build' : 'gradle build';
  }
  if (name === 'obj' || (name === 'bin' && [...near, ...root].some((f) => /\.(csproj|fsproj|sln)$/i.test(f)))) return 'dotnet build';
  if (name === 'vendor') {
    if (has(near, root, 'composer.json')) return 'composer install';
    if (has(near, root, 'go.mod')) return 'go mod vendor';
    if (has(near, root, 'Gemfile')) return 'bundle install';
    return FALLBACK_HINT;
  }
  if (BUILD_OUTPUT.has(name)) return GENERIC_BUILD_HINT;
  return FALLBACK_HINT;
}

/**
 * Restore hint for a system target, or null when a clean of it cannot be
 * undone (no hint is better than a false one).
 */
function systemRestoreHint(target) {
  if (!target || target.reversible === false) return null;
  return target.restoreHint || SYSTEM_CACHE_HINT;
}

/** Docker prune kinds whose data Docker recreates by itself. */
function dockerRestoreHint(kind) {
  if (kind === 'unused-images') return DOCKER_IMAGES_HINT;
  return kind === 'build-cache' || kind === 'dangling-images' ? DOCKER_HINT : null;
}

module.exports = {
  SYSTEM_CACHE_HINT, TRASH_HINT, DOCKER_HINT, DOCKER_IMAGES_HINT, NODE_LOCKFILES,
  artifactRestoreHint, systemRestoreHint, dockerRestoreHint, baseName,
};
