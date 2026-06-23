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
//   2. Run:  make release    (or:  npm run release)

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const git = (...a) => execFileSync('git', a, { stdio: 'inherit' });
const gitOut = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();

const changelog = readJson('changelog.json');
if (!Array.isArray(changelog) || changelog.length === 0) {
  console.error('changelog.json is empty. Add a release entry at the top first.');
  process.exit(1);
}

const entry = changelog[0];
const version = entry.version;
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error(`The top changelog entry has an invalid version: ${JSON.stringify(version)}`);
  process.exit(1);
}
for (const field of ['date', 'summary']) {
  if (!entry[field]) {
    console.error(`The top changelog entry is missing "${field}".`);
    process.exit(1);
  }
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

// Stage and commit only if something actually changed.
git('add', 'package.json', 'changelog.json');
const staged = gitOut('diff', '--cached', '--name-only');
if (staged) {
  git('commit', '-m', `Release ${tag}`);
} else {
  console.log('Nothing new to commit, tagging the current commit.');
}

git('tag', '-a', tag, '-m', `Spaci ${tag}`);
git('push', 'origin', 'HEAD');
git('push', 'origin', tag);

console.log(`\nReleased ${tag}. GitHub Actions is now building and publishing it.`);
console.log('Watch it at: https://github.com/Raccoon254/spaci/actions');
