#!/usr/bin/env node
// `make release` engine.
//
// Reads the newest entry in changelog.json, syncs package.json to that version,
// commits, tags v<version> and pushes. The pushed tag triggers
// .github/workflows/release.yml, which builds the installers for every platform,
// publishes them to GitHub Releases, and POSTs the release (with real sha512 +
// your changelog notes) to https://spaci.kentom.co.ke so the site updates live.
//
// To cut a release:
//   1. Add a new entry to the TOP of changelog.json:
//        { "version": "1.3.0", "date": "2026-07-01", "tag": "Latest",
//          "major": false, "summary": "...",
//          "added": [...], "improved": [...], "fixed": [...] }
//      Do NOT add a "files" array, the build fills sha512 and sizes.
//      Optional rich fields (highlight, notes, media, links, notice) are
//      described in changelog/README.md and validated here before tagging.
//   2. Run:  make release    (or:  npm run release)
//
//   node scripts/release.mjs --check   validates the top entry and stops
//                                      (no version bump, commit or tag).
//
// Release candidates (see RELEASING.md):
//   node scripts/release.mjs --rc      tags the next X.Y.Z-rc.N of the top
//                                      entry's version (X.Y.Z). The changelog
//                                      entry stays X.Y.Z; package.json becomes
//                                      the candidate version. The workflow marks
//                                      it a prerelease and never syncs it to the
//                                      website or the update feed.
//   A top entry versioned X.Y.Z-rc.N is also accepted and released as is.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { validateEntry } from './changelog-lib.mjs';
import { resolveReleaseVersion } from './release-lib.mjs';

const checkOnly = process.argv.includes('--check');
const rcFlag = process.argv.includes('--rc');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const git = (...a) => execFileSync('git', a, { stdio: 'inherit' });
const gitOut = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const changelog = readJson('changelog.json');
if (!Array.isArray(changelog) || changelog.length === 0) {
  console.error('changelog.json is empty. Add a release entry at the top first.');
  process.exit(1);
}

const entry = changelog[0];
// The existing tags number the next candidate. A real release must see them;
// --check may run outside a git checkout.
let tags = [];
try {
  tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((t) => t.trim()).filter(Boolean);
} catch (e) {
  if (!checkOnly) {
    console.error('Could not list the git tags, so nothing was released. Run this from the Spaci checkout.');
    process.exit(1);
  }
}
const resolved = resolveReleaseVersion({ entryVersion: entry.version, rc: rcFlag, tags });
if (resolved.error) {
  console.error(resolved.error);
  process.exit(1);
}
const { version, prerelease } = resolved;
for (const field of ['date', 'summary']) {
  if (!entry[field]) {
    console.error(`The top changelog entry is missing "${field}".`);
    process.exit(1);
  }
}

// The rich fields: notes file, images, links and the in-app notice. Any error
// stops the release before anything is changed.
const { errors, warnings, files: extraFiles } = validateEntry(entry, { root: '.' });
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) {
  console.error(`The ${version} changelog entry has ${errors.length} problem${errors.length === 1 ? '' : 's'}; nothing was released:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('See changelog/README.md for the format.');
  process.exit(1);
}
if (checkOnly) {
  console.log(`The ${entry.version} changelog entry is valid${prerelease ? ` (would release ${version})` : ''}.${extraFiles.length ? ` It ships ${extraFiles.length} file(s): ${extraFiles.join(', ')}` : ''}`);
  process.exit(0);
}

const tag = `v${version}`;
if (gitOut('tag', '--list', tag)) {
  console.error(`Tag ${tag} already exists. Bump the version in changelog.json.`);
  process.exit(1);
}

// Sync package.json version to the changelog.
const pkg = readJson('package.json');
if (pkg.version !== version) {
  pkg.version = version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log(`package.json version -> ${version}`);
}
// And the lockfile's copy of it, so the next `npm install` leaves no diff
// behind. (npm ci does not compare this field, only the dependencies.)
const lockFiles = [];
try {
  const lock = readJson('package-lock.json');
  if (lock.version !== version || (lock.packages && lock.packages[''] && lock.packages[''].version !== version)) {
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    console.log(`package-lock.json version -> ${version}`);
  }
  lockFiles.push('package-lock.json');
} catch (_) { /* no lockfile */ }

// Stage and commit only if something actually changed. The notes and images
// must be in the tagged commit: the site and the GitHub Release load them from
// raw.githubusercontent.com at this tag.
git('add', '--', 'package.json', ...lockFiles, 'changelog.json', ...extraFiles);
const staged = gitOut('diff', '--cached', '--name-only');
if (staged) {
  git('commit', '-m', `Release ${tag}`);
} else {
  console.log('Nothing new to commit, tagging the current commit.');
}

git('tag', '-a', tag, '-m', `Spaci ${tag}`);
git('push', 'origin', 'HEAD');
git('push', 'origin', tag);

console.log(`\nReleased ${tag}${prerelease ? ' as a release candidate (GitHub prerelease, not on the website or update feed)' : ''}. GitHub Actions is now building and publishing it.`);
console.log('Watch it at: https://github.com/Raccoon254/spaci/actions');
