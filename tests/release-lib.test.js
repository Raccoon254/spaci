'use strict';
// scripts/release-lib.mjs: which version release.mjs tags, including release
// candidates (X.Y.Z-rc.N). release.mjs itself runs with --check only, in a
// scratch folder, so nothing is committed, tagged or pushed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const lib = () => import(path.join(SCRIPTS, 'release-lib.mjs'));

test('version regex: X.Y.Z and X.Y.Z-rc.N only', async () => {
  const { RELEASE_RE, parseReleaseVersion, isPrerelease } = await lib();
  for (const ok of ['2.3.0', '0.0.1', '10.20.30', '2.3.0-rc.1', '2.3.0-rc.12']) assert.ok(RELEASE_RE.test(ok), ok);
  for (const bad of ['2.3', '2.3.0.1', 'v2.3.0', '2.3.0-rc', '2.3.0-rc.0', '2.3.0-rc.01', '2.3.0-beta.1', '02.3.0', '2.3.0-rc.1 ', '', null, 2.3]) {
    assert.equal(parseReleaseVersion(bad), null, String(bad));
  }
  assert.deepEqual(parseReleaseVersion('2.3.0-rc.4'), { base: '2.3.0', rc: 4 });
  assert.deepEqual(parseReleaseVersion('2.3.0'), { base: '2.3.0', rc: null });
  assert.equal(isPrerelease('2.3.0-rc.1'), true);
  assert.equal(isPrerelease('2.3.0'), false);
  // The same shape the release workflow treats as a prerelease (a '-' in the tag).
  assert.equal('v2.3.0-rc.1'.includes('-'), true);
});

test('nextRcVersion counts existing candidate tags for that version only', async () => {
  const { nextRcVersion } = await lib();
  assert.equal(nextRcVersion('2.3.0', []), '2.3.0-rc.1');
  assert.equal(nextRcVersion('2.3.0', ['v2.2.1-rc.4', 'v2.3.0-rc.1', 'v2.3.0-rc.2', 'v2.3.0']), '2.3.0-rc.3');
  assert.equal(nextRcVersion('2.3.0', ['v2.3.0-rc.9', 'v2.3.0-rc.10']), '2.3.0-rc.11', 'numeric, not string, order');
});

test('resolveReleaseVersion: plain releases, --rc candidates, and refusals', async () => {
  const { resolveReleaseVersion } = await lib();
  assert.deepEqual(resolveReleaseVersion({ entryVersion: '2.3.0', tags: ['v2.2.1'] }), { version: '2.3.0', prerelease: false });
  assert.deepEqual(resolveReleaseVersion({ entryVersion: '2.3.0', rc: true, tags: ['v2.3.0-rc.1'] }), { version: '2.3.0-rc.2', prerelease: true });
  assert.deepEqual(resolveReleaseVersion({ entryVersion: '2.3.0-rc.5', tags: [] }), { version: '2.3.0-rc.5', prerelease: true });
  assert.match(resolveReleaseVersion({ entryVersion: '2.3.0-rc.1', rc: true }).error, /set the changelog entry to 2\.3\.0/);
  assert.match(resolveReleaseVersion({ entryVersion: '2.3.0', rc: true, tags: ['v2.3.0'] }).error, /already released/);
  assert.match(resolveReleaseVersion({ entryVersion: '2.3.0-rc.2', tags: ['v2.3.0'] }).error, /already released/);
  assert.match(resolveReleaseVersion({ entryVersion: '2.3' }).error, /invalid version/);
});

function runCheck(entries, args = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaci-rc-'));
  try {
    fs.writeFileSync(path.join(root, 'changelog.json'), JSON.stringify(entries));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(SCRIPTS, 'release.mjs'), '--check', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout) + String(e.stderr) };
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('release.mjs --check accepts candidates and names the version it would tag', () => {
  const entry = { version: '2.3.0', date: '2026-10-01', summary: 'Languages.' };
  const rc = runCheck([entry], ['--rc']);
  assert.equal(rc.code, 0, rc.out);
  assert.match(rc.out, /The 2\.3\.0 changelog entry is valid \(would release 2\.3\.0-rc\.1\)/);
  const direct = runCheck([{ ...entry, version: '2.3.0-rc.3' }]);
  assert.equal(direct.code, 0, direct.out);
  const bad = runCheck([{ ...entry, version: '2.3.0-beta.1' }]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /invalid version/);
});
