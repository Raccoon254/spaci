'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/ipc-guards');

test('open:external allows only https: and mailto:', () => {
  for (const ok of ['https://spaci.kentom.co.ke', 'https://github.com/x/y?a=1', 'mailto:hi@kentom.co.ke', '  https://a.b  ']) {
    assert.equal(g.isSafeExternalUrl(ok), true, ok);
  }
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///etc/passwd', 'http://example.com',
    'ftp://x', 'data:text/html,hi', 'vscode://x', 'smb://host/share', '/etc/passwd', 'https:', '', null, undefined, 42, {}]) {
    assert.equal(g.isSafeExternalUrl(bad), false, String(bad));
  }
});

test('minBytes is at least 10 MB, 100 MB when not a usable number', () => {
  const MB = 1024 * 1024;
  assert.equal(g.clampMinBytes(NaN), 100 * MB);
  assert.equal(g.clampMinBytes(undefined), 100 * MB);
  assert.equal(g.clampMinBytes(null), 100 * MB);
  assert.equal(g.clampMinBytes('abc'), 100 * MB);
  assert.equal(g.clampMinBytes(Infinity), 100 * MB);
  assert.equal(g.clampMinBytes(-1), 100 * MB);
  assert.equal(g.clampMinBytes(0), 100 * MB);
  assert.equal(g.clampMinBytes(1), 10 * MB);
  assert.equal(g.clampMinBytes(10 * MB - 1), 10 * MB);
  assert.equal(g.clampMinBytes(500 * MB), 500 * MB);
  assert.equal(g.clampMinBytes(String(200 * MB)), 200 * MB);
});

test('large-file root: home, a scan root or inside one; anything else is refused', () => {
  const opts = { home: '/Users/me', scanRoots: ['/Volumes/Work'], realpath: (p) => p, platform: 'darwin' };
  assert.deepEqual(g.resolveLargeFilesRoot(undefined, opts), { ok: true, root: '/Users/me' });
  assert.deepEqual(g.resolveLargeFilesRoot('', opts), { ok: true, root: '/Users/me' });
  assert.equal(g.resolveLargeFilesRoot('/Users/me/Movies', opts).ok, true);
  assert.equal(g.resolveLargeFilesRoot('/Volumes/Work/x', opts).ok, true);
  assert.equal(g.resolveLargeFilesRoot('/USERS/ME/Movies', opts).ok, true, 'case-insensitive on macOS');
  for (const bad of ['/', '/etc', '/Users', '/Users/meme', '/Users/me/../other', 'Movies', '//server/share', 42, {}]) {
    const r = g.resolveLargeFilesRoot(bad, opts);
    assert.equal(r.ok, false, String(bad));
    assert.equal(typeof r.error, 'string');
  }
});

test('large-file root: a symlink inside home that points outside is refused', () => {
  const realpath = (p) => (p === '/Users/me/root-link' ? '/' : p);
  const r = g.resolveLargeFilesRoot('/Users/me/root-link', { home: '/Users/me', realpath, platform: 'darwin' });
  assert.equal(r.ok, false);
});

test('large-file root: Windows paths', () => {
  const opts = { home: 'C:\\Users\\Me', scanRoots: ['D:\\code'], realpath: (p) => p, platform: 'win32' };
  assert.equal(g.resolveLargeFilesRoot('C:\\Users\\Me\\Videos', opts).ok, true);
  assert.equal(g.resolveLargeFilesRoot('c:\\users\\me\\videos', opts).ok, true);
  assert.equal(g.resolveLargeFilesRoot('D:\\code\\repo', opts).ok, true);
  assert.equal(g.resolveLargeFilesRoot('C:\\Windows', opts).ok, false);
  assert.equal(g.resolveLargeFilesRoot('C:\\Users\\Me\\..\\Other', opts).ok, false);
  assert.equal(g.resolveLargeFilesRoot('\\\\server\\share', opts).ok, false);
});

test('knownPathSet matches exact identities only, never a prefix or a relative path', () => {
  const s = g.knownPathSet(['/home/u/app', '/home/u/app/node_modules', null, ''], 'linux');
  assert.equal(s.has('/home/u/app'), true);
  assert.equal(s.has('/home/u/app/'), true);
  assert.equal(s.has('/home/u/app/node_modules'), true);
  assert.equal(s.has('/home/u/app/src/index.js'), false);
  assert.equal(s.has('/home/u'), false);
  assert.equal(s.has('/home/u/app/../../../etc/passwd'), false);
  assert.equal(s.has('app'), false);
  assert.equal(s.has(undefined), false);
  assert.equal(s.has('/HOME/U/APP'), false, 'case matters on Linux');
  const w = g.knownPathSet(['C:\\Users\\Me\\app'], 'win32');
  assert.equal(w.has('c:\\users\\me\\APP'), true);
  assert.equal(w.has('C:\\Users\\Me'), false);
});

test('prefs:set scan roots: only inside home, already configured, or picked in the dialog', () => {
  const opts = { home: '/Users/u', current: ['/Volumes/Old'], picked: new Set(['/Volumes/Backup']), platform: 'darwin' };
  assert.deepEqual(
    g.acceptScanRoots(['/Users/u', '/Users/u/code', '/Volumes/Old', '/Volumes/Backup', '/', '/Applications', 'relative', 42, null], opts),
    ['/Users/u', '/Users/u/code', '/Volumes/Old', '/Volumes/Backup']);
  assert.deepEqual(g.acceptScanRoots('not an array', opts), ['/Volumes/Old']);
  assert.deepEqual(g.acceptScanRoots(['/Users/u/../../etc'], opts), []);
});
