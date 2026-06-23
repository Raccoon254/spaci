#!/usr/bin/env node
// Runs in CI after the cross-platform build. Reads electron-builder's generated
// latest*.yml files (which carry the real sha512 and byte sizes), combines them
// with the newest changelog.json entry, and POSTs the assembled release to the
// website. The site stores it in Neon and serves it from the changelog and the
// electron-updater feed, no redeploy needed.
//
//   SITE=https://spaci.kentom.co.ke RELEASE_PUBLISH_SECRET=xxx FEED_DIR=./feed \
//     node scripts/sync-feed.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SITE = process.env.SITE || 'https://spaci.kentom.co.ke';
const SECRET = process.env.RELEASE_PUBLISH_SECRET;
const FEED_DIR = process.env.FEED_DIR || '.';
if (!SECRET) {
  console.error('RELEASE_PUBLISH_SECRET is required');
  process.exit(1);
}

// Minimal parser for the electron-builder latest*.yml shape. The format is fixed
// and simple (version, a files list, then path/sha512/releaseDate), so we avoid
// pulling in a YAML dependency just for the CI sync step.
function parseYml(text) {
  const out = { version: '', files: [] };
  let inFiles = false;
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const v = line.match(/^version:\s*(.+)$/);
    if (v) {
      out.version = v[1].trim();
      continue;
    }
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (inFiles) {
      const url = line.match(/^\s+-\s*url:\s*(.+)$/);
      if (url) {
        cur = { url: url[1].trim() };
        out.files.push(cur);
        continue;
      }
      if (/^\s/.test(line)) {
        const sha = line.match(/^\s+sha512:\s*(.+)$/);
        if (sha && cur) cur.sha512 = sha[1].trim();
        const size = line.match(/^\s+size:\s*(\d+)\s*$/);
        if (size && cur) cur.size = Number(size[1]);
        continue;
      }
      inFiles = false; // a non-indented key ends the files block
    }
  }
  return out;
}

// Map an electron-builder artifact file name to a platform + friendly arch.
function classify(file) {
  if (/\.exe$/i.test(file)) return { platform: 'windows', arch: 'x64' };
  if (/\.AppImage$/i.test(file)) return { platform: 'linux', arch: 'x86_64' };
  if (/\.dmg$/i.test(file) || /\.zip$/i.test(file)) {
    return { platform: 'mac', arch: /arm64/i.test(file) ? 'Apple Silicon' : 'Intel' };
  }
  return null;
}

function humanize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

const changelog = JSON.parse(readFileSync('changelog.json', 'utf8'));
const entry = changelog[0];

const ymlNames = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml'];
const files = [];
const seen = new Set();
let version = entry.version;

for (const name of ymlNames) {
  const p = join(FEED_DIR, name);
  if (!existsSync(p)) continue;
  const doc = parseYml(readFileSync(p, 'utf8'));
  if (doc.version) version = doc.version;
  for (const f of doc.files) {
    if (/\.blockmap$/i.test(f.url)) continue; // not a user-facing artifact
    if (seen.has(f.url)) continue;
    const c = classify(f.url);
    if (!c) continue;
    seen.add(f.url);
    files.push({
      platform: c.platform,
      arch: c.arch,
      file: f.url,
      size: humanize(f.size || 0),
      bytes: f.size || 0,
      sha512: f.sha512 || ''
    });
  }
}

if (files.length === 0) {
  console.error(`No artifacts found in ${FEED_DIR}. Did the build upload latest*.yml?`);
  process.exit(1);
}

const release = {
  version,
  date: entry.date,
  tag: entry.tag || 'Latest',
  major: !!entry.major,
  summary: entry.summary || '',
  added: entry.added || [],
  improved: entry.improved || [],
  fixed: entry.fixed || [],
  files
};

const res = await fetch(`${SITE}/api/releases`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-publish-secret': SECRET },
  body: JSON.stringify(release)
});

if (!res.ok) {
  console.error(`Publish failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Synced ${version} (${files.length} files) to ${SITE}`);
