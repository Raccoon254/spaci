#!/usr/bin/env node
// Render the GitHub Release description for a version.
//
//   node scripts/release-notes.mjs                     # newest changelog entry
//   node scripts/release-notes.mjs --version 2.0.1     # a specific one
//   node scripts/release-notes.mjs --feed-dir feed     # with real artifact data
//
// The text comes from changelog.json, the same entry that is published to
// spaci.kentom.co.ke, so the release page and the website changelog can never
// tell different stories. The download table comes from electron-builder's
// latest*.yml when they are available, which is where the real file names,
// byte sizes and sha512 hashes live.
//
// Written to stdout. CI pipes it into `gh release edit --notes-file` from the
// sync job, which runs once after all three platform builds; generating it in
// the build matrix would have three runners racing to write the same body.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'Raccoon254/spaci';
const SITE = 'https://spaci.kentom.co.ke';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? fallback : args[i + 1];
};

const changelog = JSON.parse(readFileSync('changelog.json', 'utf8'));
const wanted = flag('version');
const entry = wanted ? changelog.find((e) => e.version === wanted) : changelog[0];
if (!entry) {
  console.error(`No changelog.json entry for ${wanted || 'the newest release'}`);
  process.exit(1);
}
const version = entry.version;
const feedDir = flag('feed-dir');

// --- artifacts -------------------------------------------------------------

// Minimal reader for the electron-builder latest*.yml shape, matching the one
// in sync-feed.mjs. The format is fixed, so a yaml dependency is not worth it.
function parseYml(text) {
  const files = [];
  let inFiles = false;
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) { inFiles = true; continue; }
    if (!inFiles) continue;
    const url = line.match(/^\s+-\s*url:\s*(.+)$/);
    if (url) { cur = { file: url[1].trim() }; files.push(cur); continue; }
    if (/^\s/.test(line)) {
      const sha = line.match(/^\s+sha512:\s*(.+)$/);
      if (sha && cur) cur.sha512 = sha[1].trim();
      const size = line.match(/^\s+size:\s*(\d+)\s*$/);
      if (size && cur) cur.bytes = Number(size[1]);
      continue;
    }
    inFiles = false;
  }
  return files;
}

function fromFeeds(dir) {
  const out = [];
  const seen = new Set();
  for (const name of ['latest-mac.yml', 'latest.yml', 'latest-linux.yml']) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    for (const f of parseYml(readFileSync(p, 'utf8'))) {
      if (/\.blockmap$/i.test(f.file) || seen.has(f.file)) continue;
      seen.add(f.file);
      out.push(f);
    }
  }
  return out;
}

// electron-builder's naming, used when no feed directory is given (for example
// when backfilling notes for an older release).
function conventional(v) {
  return [
    { file: `Spaci-${v}-arm64.dmg` },
    { file: `Spaci-${v}.dmg` },
    { file: `Spaci-Setup-${v}.exe` },
    { file: `Spaci-${v}.AppImage` },
  ];
}

const artifacts = feedDir ? fromFeeds(feedDir) : conventional(version);

// What a person should actually download: installers, never the update-only
// .zip builds or the .blockmap deltas.
const INSTALLER = /\.(dmg|exe|AppImage)$/i;
const label = (file) => {
  if (/\.dmg$/i.test(file)) return /arm64/i.test(file) ? 'macOS (Apple Silicon)' : 'macOS (Intel)';
  if (/\.exe$/i.test(file)) return 'Windows';
  if (/\.AppImage$/i.test(file)) return 'Linux';
  return null;
};
const mb = (bytes) => (bytes ? `${Math.round(bytes / (1024 * 1024))} MB` : '');
const url = (file) => `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(file)}`;

// --- markdown --------------------------------------------------------------

const out = [];
out.push(entry.summary || `Spaci ${version}.`);
out.push('');

// Most Macs are Apple Silicon now, so that row leads.
const ORDER = ['macOS (Apple Silicon)', 'macOS (Intel)', 'Windows', 'Linux'];
const installers = artifacts
  .filter((a) => INSTALLER.test(a.file) && label(a.file))
  .sort((a, b) => ORDER.indexOf(label(a.file)) - ORDER.indexOf(label(b.file)));
if (installers.length) {
  out.push('## Download');
  out.push('');
  out.push('| Platform | File | Size |');
  out.push('| --- | --- | --- |');
  for (const a of installers) out.push(`| ${label(a.file)} | [${a.file}](${url(a.file)}) | ${mb(a.bytes)} |`);
  out.push('');
  out.push('Or from a terminal:');
  out.push('');
  out.push('```bash');
  out.push(`# macOS and Linux`);
  out.push(`curl -fsSL ${SITE}/install.sh | bash`);
  out.push('```');
  out.push('');
  out.push('```powershell');
  out.push('# Windows');
  out.push(`irm ${SITE}/install.ps1 | iex`);
  out.push('```');
  out.push('');
}

const section = (title, items) => {
  if (!items || !items.length) return;
  out.push(`## ${title}`);
  out.push('');
  for (const i of items) out.push(`- ${i}`);
  out.push('');
};
section('New', entry.added);
section('Improved', entry.improved);
section('Fixed', entry.fixed);

out.push('## Updating');
out.push('');
out.push('Installed copies pick this up on their next check, within six hours, or immediately from **Check for updates** on the About screen. macOS builds are signed and notarized, so the update applies without a Gatekeeper prompt.');
out.push('');

const hashed = artifacts.filter((a) => a.sha512);
if (hashed.length) {
  out.push('<details>');
  out.push('<summary>Verify your download (sha512, base64)</summary>');
  out.push('');
  out.push('```');
  for (const a of hashed) out.push(`${a.file}\n  ${a.sha512}`);
  out.push('```');
  out.push('');
  out.push('```bash');
  out.push('openssl dgst -sha512 -binary <file> | openssl base64 -A');
  out.push('```');
  out.push('');
  out.push('</details>');
  out.push('');
}

out.push(`Full changelog: ${SITE}/changelog`);

console.log(out.join('\n'));
